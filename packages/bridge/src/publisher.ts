// Outbox publishing (docs/bridge-spec.md sections 7 and 9): the signed event is stored before the first
// attempt, retries resend that exact event, and the completion (for example the message_map row) is
// written in the same transaction that clears the outbox row.
import { errorFields, isBackfill, messageTimeMs, metrics, RelayError, retry, withTransaction, type Logger, type Pool, type PoolClient, type RelayClient, type Signer } from '@brain/shared';
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

  /**
   * Store and publish a signed event. Returns false if the relay refused it: then it is dead-lettered, or with
   * `deadLetter: false` (a replay that has a fallback) just dropped from the outbox.
   */
  async publish(row: Omit<OutboxRow, 'attempts' | 'meta'> & { meta?: Record<string, unknown> }, options: { deadLetter?: boolean } = {}): Promise<boolean> {
    await this.#deps.store.insertOutbox(row);
    return this.publishRow({ ...row, attempts: 0, meta: row.meta ?? {} }, options);
  }

  /** The signer for a pubkey the bridge holds: its own key or one from the key store. */
  signerFor(pubkey: string): Promise<Signer> {
    return this.#deps.signerFor(pubkey);
  }

  async publishRow(row: OutboxRow, options: { deadLetter?: boolean } = {}): Promise<boolean> {
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
          metrics.bridgeRetries.inc({ direction: 'mm_to_relay' });
          log.warn({ eventId: event.id, kind: event.kind, attempt, delayMs, ...errorFields(error) }, 'Relay publish failed; retrying');
          void store.recordOutboxAttempt(event.id, error instanceof Error ? error.message : String(error));
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.deadLetter === false) {
        log.warn({ eventId: event.id, kind: event.kind, purpose: row.purpose, ...errorFields(error) }, 'Relay refused the event');
        await store.deleteOutbox(event.id);
        return false;
      }
      log.error({ eventId: event.id, kind: event.kind, purpose: row.purpose, ...errorFields(error) }, 'Relay publish gave up; dead-lettering');
      metrics.deadLetters.inc({ direction: 'mm_to_relay' });
      await withTransaction(this.#deps.pool, async (tx) => {
        // The whole row, so a replay can publish the same event through the same completion.
        await store.deadLetter('mm_to_relay', { purpose: row.purpose, mmPostId: row.mmPostId, mmChannelId: row.mmChannelId, authorMmUserId: row.authorMmUserId, meta: row.meta, event }, message, row.attempts + 1, tx);
        await store.deleteOutbox(event.id, tx);
      });
      return false;
    }
    const complete = this.#deps.completions[row.purpose];
    await withTransaction(this.#deps.pool, async (tx) => {
      if (complete) await complete(row, tx);
      await store.deleteOutbox(event.id, tx);
    });
    metrics.mirrored.inc({ direction: 'mm_to_relay', kind: String(event.kind) });
    // History (backfill) is old by design; it would only distort the lag.
    if (!isBackfill(event)) metrics.mirrorLag.observe({ direction: 'mm_to_relay' }, Math.max(0, Date.now() - messageTimeMs(event)) / 1000);
    return true;
  }

  /** Publish everything left in the outbox, for example after a crash. */
  async drain(): Promise<void> {
    for (const row of await this.#deps.store.listOutbox()) await this.publishRow(row);
  }
}
