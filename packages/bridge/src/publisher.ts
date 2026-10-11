// Outbox publishing (docs/bridge-spec.md sections 7 and 9): the signed event is stored before the first
// attempt, retries resend that exact event, and the completion (for example the message_map row) is
// written in the same transaction that clears the outbox row.
import { errorFields, RelayError, retry, withTransaction, type Logger, type Pool, type PoolClient, type RelayClient, type Signer } from '@brain/shared';
import type { BridgeStore, OutboxRow } from './store.ts';

export type Completion = (row: OutboxRow, tx: PoolClient) => Promise<void>;

export interface PublisherDeps {
  pool: Pool;
  store: BridgeStore;
  relay: RelayClient;
  signerFor: (pubkey: string) => Promise<Signer>;
  completions: Record<string, Completion>;
  log: Logger;
  attempts?: number;
}

export class OutboxPublisher {
  readonly #deps: PublisherDeps;

  constructor(deps: PublisherDeps) {
    this.#deps = deps;
  }

  /** Store and publish a signed event. Returns false if it was dead-lettered. */
  async publish(row: Omit<OutboxRow, 'attempts'>): Promise<boolean> {
    await this.#deps.store.insertOutbox(row);
    return this.publishRow({ ...row, attempts: 0 });
  }

  async publishRow(row: OutboxRow): Promise<boolean> {
    const { store, relay, log } = this.#deps;
    const event = row.signedEvent;
    try {
      const signer = await this.#deps.signerFor(event.pubkey);
      await retry(() => relay.publish(event, signer), {
        attempts: this.#deps.attempts ?? 8,
        baseMs: 500,
        maxMs: 30_000,
        isRetryable: (error) => error instanceof RelayError && error.retryable,
        minDelayMs: (error) => (error instanceof RelayError ? error.retryAfterMs : undefined),
        onRetry: (error, attempt, delayMs) => {
          log.warn({ eventId: event.id, kind: event.kind, attempt, delayMs, ...errorFields(error) }, 'Relay publish failed; retrying');
          void store.recordOutboxAttempt(event.id, error instanceof Error ? error.message : String(error));
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ eventId: event.id, kind: event.kind, purpose: row.purpose, ...errorFields(error) }, 'Relay publish gave up; dead-lettering');
      await withTransaction(this.#deps.pool, async (tx) => {
        await store.deadLetter('mm_to_relay', { purpose: row.purpose, mmPostId: row.mmPostId, mmChannelId: row.mmChannelId, event }, message, row.attempts + 1, tx);
        await store.deleteOutbox(event.id, tx);
      });
      return false;
    }
    const complete = this.#deps.completions[row.purpose];
    await withTransaction(this.#deps.pool, async (tx) => {
      if (complete) await complete(row, tx);
      await store.deleteOutbox(event.id, tx);
    });
    return true;
  }

  /** Publish everything left in the outbox, for example after a crash. */
  async drain(): Promise<void> {
    for (const row of await this.#deps.store.listOutbox()) await this.publishRow(row);
  }
}
