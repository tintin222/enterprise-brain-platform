// RelayClient: the only way our services talk to the Buzz relay over HTTP (CLAUDE.md rule 6).
// Behaviour this relies on was verified in Phase 0 (docs/spike-findings.md, A1 and A7).
import { createHash, randomBytes } from 'node:crypto';
import type { Filter } from 'nostr-tools/filter';
import { nowSeconds, type NostrEvent, type Signer } from '../nostr.ts';

export type { Filter };

export interface PublishResult {
  accepted: boolean;
  /** The relay already had this event (or, for channel creation, the channel). */
  duplicate: boolean;
  message: string;
}

export class RelayError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Delay the relay asked for, from a rate-limit reply. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number; retryAfterMs?: number }) {
    super(message);
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface RelayClient {
  /** Publish a signed event; `signer` authenticates the request and must be the event's author. */
  publish(event: NostrEvent, signer: Signer): Promise<PublishResult>;
  /** One query: an array of filters, results concatenated filter by filter. */
  query(filters: Filter[], signer: Signer): Promise<NostrEvent[]>;
  /** Every stored event matching `filter`, newest first, paged with `until` + `before_id`. */
  queryAll(filter: Filter, signer: Signer, pageSize?: number): AsyncGenerator<NostrEvent>;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** NIP-98 header for one request. The nonce keeps each auth event unique (the relay accepts an id once). */
export function nip98Authorization(signer: Signer, url: string, method: string, body?: string): string {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
    ['nonce', randomBytes(8).toString('hex')],
  ];
  if (body !== undefined) tags.push(['payload', sha256Hex(body)]);
  const auth = signer.sign({ kind: 27235, tags, content: '', created_at: nowSeconds() });
  return `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`;
}

function retryAfterFrom(message: string): number | undefined {
  const match = /retry in (\d+)s/.exec(message);
  return match ? Number(match[1]) * 1000 : undefined;
}

export class BuzzRelayClient implements RelayClient {
  readonly httpUrl: string;
  readonly #timeoutMs: number;

  constructor(httpUrl: string, timeoutMs = 15_000) {
    this.httpUrl = httpUrl.replace(/\/$/, '');
    this.#timeoutMs = timeoutMs;
  }

  async #post(path: string, payload: unknown, signer: Signer): Promise<{ status: number; body: unknown; text: string }> {
    const url = `${this.httpUrl}${path}`;
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: nip98Authorization(signer, url, 'POST', body) },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RelayError(`Relay request ${path} failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, text };
  }

  #error(path: string, status: number, body: unknown, text: string): RelayError {
    const record = (body ?? {}) as { error?: string; message?: string };
    const message = record.message ?? record.error ?? text.slice(0, 200);
    const retryable = status === 429 || status === 503 || status >= 500 || status === 401;
    return new RelayError(`Relay ${path} returned ${status}: ${message}`, { retryable, status, retryAfterMs: retryAfterFrom(message) });
  }

  async publish(event: NostrEvent, signer: Signer): Promise<PublishResult> {
    if (signer.pubkey !== event.pubkey) throw new RelayError('Signer does not match event author', { retryable: false });
    const { status, body, text } = await this.#post('/events', event, signer);
    if (status !== 200) throw this.#error('/events', status, body, text);
    const result = (body ?? {}) as { accepted?: boolean; message?: string };
    const message = result.message ?? '';
    const duplicate = message.startsWith('duplicate:');
    if (result.accepted !== true && !duplicate) {
      throw new RelayError(`Relay rejected kind ${event.kind}: ${message}`, { retryable: message.startsWith('rate-limited'), status, retryAfterMs: retryAfterFrom(message) });
    }
    return { accepted: result.accepted === true, duplicate, message };
  }

  async query(filters: Filter[], signer: Signer): Promise<NostrEvent[]> {
    const { status, body, text } = await this.#post('/query', filters, signer);
    if (status !== 200) throw this.#error('/query', status, body, text);
    return Array.isArray(body) ? (body as NostrEvent[]) : [];
  }

  async *queryAll(filter: Filter, signer: Signer, pageSize = 500): AsyncGenerator<NostrEvent> {
    const seen = new Set<string>();
    let cursor: { until: number; before_id: string } | undefined;
    for (;;) {
      const page = await this.query([{ ...filter, limit: pageSize, ...(cursor ?? {}) }], signer);
      let fresh = 0;
      for (const event of page) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh++;
        yield event;
      }
      const last = page.at(-1);
      if (!last || fresh === 0 || page.length < pageSize) return;
      cursor = { until: last.created_at, before_id: last.id };
    }
  }
}
