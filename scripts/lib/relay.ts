// Buzz relay access for scripts: HTTP with per-request NIP-98 auth, and WebSocket with NIP-42 auth.
// Every frame is recorded so spikes can report exactly what the relay said.
// Product code uses RelayClient in @brain/shared instead (CLAUDE.md rule 6).
import { createHash, randomBytes } from 'node:crypto';
import type { Filter } from 'nostr-tools/filter';
import { nowSeconds, sign, type Event, type Identity } from './nostr.ts';

export type { Filter };

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function authHeader(event: Event): string {
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

/**
 * Build a NIP-98 `Authorization` header for one HTTP request. The relay accepts each auth event id
 * once (120 s replay guard), so a random nonce tag keeps two identical requests in the same second
 * from colliding. Pass `nonce: false` to reproduce that collision.
 */
export function nip98Header(identity: Identity, url: string, method: string, body?: string, options: { nonce?: boolean; createdAt?: number } = {}): string {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (body !== undefined) tags.push(['payload', sha256Hex(body)]);
  if (options.nonce !== false) tags.push(['nonce', randomBytes(8).toString('hex')]);
  return authHeader(sign(identity, 27235, tags, '', options.createdAt));
}

/** Blossom (BUD-01/02) authorization, kind 24242, used by the relay's media endpoints. */
export function blossomHeader(identity: Identity, verb: 'upload' | 'get', sha256: string, expiresInSeconds = 300): string {
  const tags = [
    ['t', verb],
    ['x', sha256],
    ['expiration', String(nowSeconds() + expiresInSeconds)],
  ];
  return authHeader(sign(identity, 24242, tags, `${verb} ${sha256}`));
}

export interface HttpResult {
  status: number;
  body: unknown;
}

async function toResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  return { status: response.status, body: parsed };
}

export class RelayHttp {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * POST a JSON body to a relay endpoint. Auth is NIP-98 for `identity` unless `headers` carries its
   * own Authorization (or `identity` is null for an unauthenticated request).
   */
  async post(path: string, payload: unknown, identity: Identity | null, headers: Record<string, string> = {}): Promise<HttpResult> {
    const url = `${this.baseUrl}${path}`;
    const body = JSON.stringify(payload);
    const allHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
    if (identity && !allHeaders.Authorization) allHeaders.Authorization = nip98Header(identity, url, 'POST', body);
    return toResult(await fetch(url, { method: 'POST', headers: allHeaders, body }));
  }

  /** Raw request for media endpoints. */
  async request(method: string, path: string, headers: Record<string, string>, body?: Uint8Array): Promise<HttpResult & { bytes?: Uint8Array }> {
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    if (response.ok && !(response.headers.get('content-type') ?? '').includes('json')) {
      return { status: response.status, body: null, bytes: new Uint8Array(await response.arrayBuffer()) };
    }
    return toResult(response);
  }

  publish(identity: Identity, event: Event): Promise<HttpResult> {
    return this.post('/events', event, identity);
  }

  /** POST /query takes an array of filters and returns an array of events. */
  async query(identity: Identity, filters: Filter[]): Promise<{ status: number; events: Event[]; body: unknown }> {
    const result = await this.post('/query', filters, identity);
    return { ...result, events: Array.isArray(result.body) ? (result.body as Event[]) : [] };
  }
}

export interface OkResult {
  accepted: boolean;
  message: string;
}

type Frame = unknown[];

/** One WebSocket connection to the relay, authenticated with NIP-42 when an identity is given. */
export class RelaySocket {
  readonly frames: { direction: 'in' | 'out'; frame: Frame }[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private readonly socket: WebSocket;
  readonly url: string;

  private constructor(socket: WebSocket, url: string) {
    this.socket = socket;
    this.url = url;
    socket.addEventListener('message', (message: MessageEvent) => {
      this.frames.push({ direction: 'in', frame: JSON.parse(String(message.data)) as Frame });
      this.wake();
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const wake of this.waiters) wake();
  }

  static async connect(url: string, identity?: Identity, timeoutMs = 10_000): Promise<RelaySocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`WebSocket to ${url} failed to open`)), { once: true });
    });
    const relay = new RelaySocket(socket, url);
    if (identity) await relay.authenticate(identity, timeoutMs);
    return relay;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: Frame): void {
    this.frames.push({ direction: 'out', frame });
    this.socket.send(JSON.stringify(frame));
  }

  /** Wait for an incoming frame (past or future) that matches. */
  waitFor(match: (frame: Frame) => boolean, timeoutMs: number, startIndex = 0): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const found = this.frames.slice(startIndex).find((entry) => entry.direction === 'in' && match(entry.frame));
        if (found) {
          cleanup();
          resolve(found.frame);
        } else if (this.closed) {
          cleanup();
          reject(new Error('Relay connection closed while waiting'));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No matching relay frame within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  async authenticate(identity: Identity, timeoutMs = 10_000): Promise<OkResult> {
    const challengeFrame = await this.waitFor((f) => f[0] === 'AUTH' && typeof f[1] === 'string', timeoutMs);
    const auth = sign(identity, 22242, [
      ['relay', this.url],
      ['challenge', String(challengeFrame[1])],
    ]);
    const result = await this.publishFrame('AUTH', auth, timeoutMs);
    if (!result.accepted) throw new Error(`NIP-42 auth rejected: ${result.message}`);
    return result;
  }

  private async publishFrame(verb: 'EVENT' | 'AUTH', event: Event, timeoutMs: number): Promise<OkResult> {
    const start = this.frames.length;
    this.send([verb, event]);
    const ok = await this.waitFor((f) => f[0] === 'OK' && f[1] === event.id, timeoutMs, start);
    return { accepted: ok[2] === true, message: typeof ok[3] === 'string' ? ok[3] : '' };
  }

  publish(event: Event, timeoutMs = 10_000): Promise<OkResult> {
    return this.publishFrame('EVENT', event, timeoutMs);
  }

  /** Run a REQ until EOSE or CLOSED; returns stored events and how the subscription ended. */
  async query(subId: string, filters: Filter[], timeoutMs = 10_000): Promise<{ events: Event[]; end: Frame }> {
    const start = this.frames.length;
    this.send(['REQ', subId, ...filters]);
    const end = await this.waitFor((f) => (f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === subId, timeoutMs, start);
    const events = this.frames
      .slice(start)
      .filter((entry) => entry.direction === 'in' && entry.frame[0] === 'EVENT' && entry.frame[1] === subId)
      .map((entry) => entry.frame[2] as Event);
    return { events, end };
  }

  /** Open a live subscription; returns the frame index to wait from and the EOSE/CLOSED frame. */
  async subscribe(subId: string, filters: Filter[], timeoutMs = 10_000): Promise<{ from: number; end: Frame }> {
    const from = this.frames.length;
    this.send(['REQ', subId, ...filters]);
    const end = await this.waitFor((f) => (f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === subId, timeoutMs, from);
    return { from, end };
  }

  /** Wait for a live EVENT on a subscription that matches. */
  async waitForEvent(subId: string, match: (event: Event) => boolean, timeoutMs: number, from = 0): Promise<Event> {
    const frame = await this.waitFor((f) => f[0] === 'EVENT' && f[1] === subId && match(f[2] as Event), timeoutMs, from);
    return frame[2] as Event;
  }

  /** Incoming frames after `from`, for evidence. */
  incoming(from = 0): Frame[] {
    return this.frames.slice(from).filter((entry) => entry.direction === 'in').map((entry) => entry.frame);
  }

  close(): void {
    this.socket.close();
  }
}
