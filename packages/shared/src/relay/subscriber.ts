// Live relay subscriptions over WebSocket with NIP-42 auth (docs/bridge-spec.md section 6).
// The relay delivers channel events live only to subscriptions naming a single channel in #h (spike A7),
// so callers hold one subscription per channel. Subscriptions use `limit: 0` (no stored events; live
// delivery still includes back-dated events). Callers run catch-up for a key from `onActive`, which fires
// once the relay has confirmed the subscription (EOSE): anything published before that moment is found by
// catch-up, anything after arrives live. It fires again after every re-subscription (reconnects, retries).
import { backoffDelay } from '../async.ts';
import type { Logger } from '../logger.ts';
import { metrics } from '../metrics.ts';
import { nowSeconds, type NostrEvent, type Signer } from '../nostr.ts';
import type { Filter } from './client.ts';

export interface RelaySubscriberOptions {
  url: string;
  signer: Signer;
  onEvent(key: string, event: NostrEvent): void;
  /** The relay confirmed the subscription for `key` (EOSE). Run catch-up for that key here. */
  onActive?(key: string): void;
  /** After every (re)authentication. */
  onConnected?(): void;
  log: Logger;
  /** The service, for metrics labels. */
  name?: string;
  /** Subscriptions per connection before another connection is opened (relay limit: 1024). */
  maxPerConnection?: number;
  /** REQ frames per second per connection (relay limit per key, D20: 50/s). */
  reqPerSecond?: number;
}

interface Subscription {
  key: string;
  filter: Filter;
  connection: Connection;
}

type Frame = unknown[];

class Connection {
  readonly subs = new Map<string, Subscription>();
  /** Keys the relay has confirmed (EOSE) on the current socket. */
  readonly active = new Set<string>();
  readonly #owner: RelaySubscriber;
  readonly #opts: RelaySubscriberOptions;
  #socket: WebSocket | undefined;
  #authenticated = false;
  #closed = false;
  #attempt = 0;
  #queue: Frame[] = [];
  #drainTimer: NodeJS.Timeout | undefined;
  #retryTimers = new Set<NodeJS.Timeout>();

  constructor(owner: RelaySubscriber, opts: RelaySubscriberOptions) {
    this.#owner = owner;
    this.#opts = opts;
    this.#open();
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  #open(): void {
    const socket = new WebSocket(this.#opts.url);
    this.#socket = socket;
    this.#authenticated = false;
    socket.addEventListener('message', (message: MessageEvent) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(message.data)) as Frame;
      } catch {
        return;
      }
      this.#onFrame(socket, frame);
    });
    socket.addEventListener('close', () => {
      this.#authenticated = false;
      this.active.clear();
      if (this.#closed) return;
      metrics.relayReconnects.inc({ service: this.#opts.name ?? 'unknown' });
      const delay = Math.max(500, backoffDelay(this.#attempt++, 1000, 30_000));
      this.#opts.log.warn({ delayMs: delay }, 'Relay WebSocket closed; reconnecting');
      this.#later(() => this.#open(), delay);
    });
    socket.addEventListener('error', () => {
      // A close event follows; reconnect happens there.
    });
  }

  #onFrame(socket: WebSocket, frame: Frame): void {
    const [type] = frame;
    if (type === 'AUTH' && typeof frame[1] === 'string') {
      const auth = this.#opts.signer.sign({ kind: 22242, tags: [['relay', this.#opts.url], ['challenge', frame[1]]], content: '', created_at: nowSeconds() });
      socket.send(JSON.stringify(['AUTH', auth]));
      return;
    }
    if (type === 'OK' && !this.#authenticated) {
      if (frame[2] === true) {
        this.#authenticated = true;
        this.#attempt = 0;
        this.#queue = [...this.subs.values()].map((sub) => ['REQ', sub.key, sub.filter]);
        this.#drain();
        this.#opts.onConnected?.();
      } else {
        this.#opts.log.error({ reason: frame[3] }, 'Relay rejected NIP-42 auth');
        socket.close();
      }
      return;
    }
    if (type === 'EVENT' && typeof frame[1] === 'string' && frame[2]) {
      if (this.subs.has(frame[1])) this.#opts.onEvent(frame[1], frame[2] as NostrEvent);
      return;
    }
    if (type === 'EOSE' && typeof frame[1] === 'string') {
      this.#opts.log.debug({ key: frame[1] }, 'Relay subscription active');
      if (this.subs.has(frame[1])) {
        this.active.add(frame[1]);
        this.#opts.onActive?.(frame[1]);
      }
      return;
    }
    if (type === 'CLOSED' && typeof frame[1] === 'string') {
      this.#onClosed(frame[1], typeof frame[2] === 'string' ? frame[2] : '');
      return;
    }
    if (type === 'NOTICE') this.#opts.log.warn({ notice: frame[1] }, 'Relay notice');
  }

  #onClosed(key: string, reason: string): void {
    metrics.relaySubscriptionsClosed.inc({ service: this.#opts.name ?? 'unknown', reason: /^[\w-]+/.exec(reason)?.[0] ?? 'unknown' });
    this.active.delete(key);
    const sub = this.subs.get(key);
    if (!sub) return;
    if (reason.includes('too many subscriptions')) {
      this.subs.delete(key);
      this.#owner.reassign(sub);
      return;
    }
    // Rate limits pass quickly; membership may still be on its way (the bridge adds the reader to new channels).
    const delay = reason.startsWith('rate-limited') ? 5000 : 30_000;
    this.#opts.log.warn({ key, reason, delayMs: delay }, 'Relay closed a subscription; retrying');
    this.#later(() => {
      // The subscription may have been closed or moved meanwhile (for example the channel was paused).
      if (this.subs.get(key) === sub) this.send(['REQ', key, sub.filter]);
    }, delay);
  }

  #later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      fn();
    }, ms);
    this.#retryTimers.add(timer);
  }

  send(frame: Frame): void {
    this.#queue.push(frame);
    this.#drain();
  }

  #drain(): void {
    if (this.#drainTimer || !this.#authenticated) return;
    const interval = Math.ceil(1000 / (this.#opts.reqPerSecond ?? 40));
    const tick = (): void => {
      const frame = this.#queue.shift();
      if (!frame || !this.#authenticated || !this.#socket) {
        this.#drainTimer = undefined;
        return;
      }
      if (frame[0] === 'REQ' && !this.subs.has(String(frame[1]))) {
        tick();
        return;
      }
      this.#socket.send(JSON.stringify(frame));
      this.#opts.log.debug({ frame: frame[0], key: frame[1] }, 'Sent to relay');
      this.#drainTimer = setTimeout(tick, interval);
    };
    tick();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#drainTimer);
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#socket?.close();
  }
}

/** Manages subscriptions keyed by caller-chosen keys (for example relay channel ids). */
export class RelaySubscriber {
  readonly #opts: RelaySubscriberOptions;
  readonly #connections: Connection[] = [];
  readonly #subs = new Map<string, Subscription>();
  #closed = false;

  constructor(opts: RelaySubscriberOptions) {
    this.#opts = opts;
  }

  get size(): number {
    return this.#subs.size;
  }

  has(key: string): boolean {
    return this.#subs.has(key);
  }

  /** True once the relay has confirmed the subscription on the current connection. */
  isActive(key: string): boolean {
    const sub = this.#subs.get(key);
    return sub !== undefined && sub.connection.active.has(key);
  }

  /** True when every connection is authenticated (and with no connections yet), for readiness checks. */
  get connected(): boolean {
    return this.#connections.every((connection) => connection.authenticated);
  }

  /** How many subscriptions are confirmed, for health checks. */
  get activeCount(): number {
    let count = 0;
    for (const connection of this.#connections) count += connection.active.size;
    return count;
  }

  /** Subscribe (or replace the filter of) `key`. The key doubles as the relay subscription id. */
  subscribe(key: string, filter: Filter): void {
    if (this.#closed) return;
    const existing = this.#subs.get(key);
    if (existing) {
      existing.filter = filter;
      existing.connection.send(['REQ', key, filter]);
      return;
    }
    const connection = this.#connectionWithRoom();
    const sub: Subscription = { key, filter, connection };
    this.#subs.set(key, sub);
    connection.subs.set(key, sub);
    if (connection.authenticated) connection.send(['REQ', key, filter]);
  }

  unsubscribe(key: string): void {
    const sub = this.#subs.get(key);
    if (!sub) return;
    this.#subs.delete(key);
    sub.connection.subs.delete(key);
    sub.connection.active.delete(key);
    if (sub.connection.authenticated) sub.connection.send(['CLOSE', key]);
  }

  /** Move a subscription the relay refused for lack of room to another connection. */
  reassign(sub: Subscription): void {
    const connection = this.#connectionWithRoom(sub.connection);
    sub.connection = connection;
    connection.subs.set(sub.key, sub);
    if (connection.authenticated) connection.send(['REQ', sub.key, sub.filter]);
  }

  #connectionWithRoom(exclude?: Connection): Connection {
    const max = this.#opts.maxPerConnection ?? 1000;
    const found = this.#connections.find((c) => c !== exclude && c.subs.size < max);
    if (found) return found;
    const connection = new Connection(this, this.#opts);
    this.#connections.push(connection);
    return connection;
  }

  close(): void {
    this.#closed = true;
    for (const connection of this.#connections) connection.close();
    this.#connections.length = 0;
    this.#subs.clear();
  }
}
