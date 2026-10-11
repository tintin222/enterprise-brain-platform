// Mattermost WebSocket event stream with automatic reconnect. Consumers run REST catch-up from
// `onConnected`, which fires after every (re)authentication, because events can be lost while offline.
import { backoffDelay } from '../async.ts';
import type { Logger } from '../logger.ts';
import type { ChatEvent, MmChannel, MmPost, MmReaction } from './types.ts';

export interface ChatEventHandlers {
  onEvent(event: ChatEvent): void;
  onConnected?(): void;
  onDisconnected?(): void;
}

export interface ChatEventStream {
  close(): void;
  readonly connected: boolean;
}

export class MattermostEventStream implements ChatEventStream {
  readonly #url: string;
  readonly #token: string;
  readonly #handlers: ChatEventHandlers;
  readonly #log: Logger;
  #socket: WebSocket | undefined;
  #closed = false;
  #attempt = 0;
  #connected = false;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(baseUrl: string, token: string, handlers: ChatEventHandlers, logger: Logger) {
    this.#url = `${baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
    this.#token = token;
    this.#handlers = handlers;
    this.#log = logger;
    this.#open();
  }

  get connected(): boolean {
    return this.#connected;
  }

  #open(): void {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: this.#token } }));
    });
    socket.addEventListener('message', (message: MessageEvent) => {
      let frame: Partial<ChatEvent> & { status?: string; seq_reply?: number };
      try {
        frame = JSON.parse(String(message.data)) as typeof frame;
      } catch {
        return;
      }
      if (frame.seq_reply === 1 && frame.status !== 'OK') {
        this.#log.error({ status: frame.status }, 'Mattermost WebSocket authentication failed');
        socket.close();
        return;
      }
      if (typeof frame.event !== 'string') return;
      if (frame.event === 'hello') {
        this.#attempt = 0;
        this.#connected = true;
        this.#log.info('Mattermost WebSocket connected');
        this.#handlers.onConnected?.();
        return;
      }
      this.#handlers.onEvent({ event: frame.event, data: frame.data ?? {}, broadcast: frame.broadcast ?? {}, seq: frame.seq ?? 0 });
    });
    socket.addEventListener('close', () => {
      const wasConnected = this.#connected;
      this.#connected = false;
      if (wasConnected) this.#handlers.onDisconnected?.();
      if (this.#closed) return;
      const delay = Math.max(500, backoffDelay(this.#attempt++, 1000, 30_000));
      this.#log.warn({ delayMs: delay }, 'Mattermost WebSocket closed; reconnecting');
      this.#reconnectTimer = setTimeout(() => this.#open(), delay);
    });
    socket.addEventListener('error', () => {
      // A close event always follows; reconnect happens there.
    });
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
  }
}

/** The post carried by `posted`, `post_edited` and `post_deleted` (a JSON string on the wire). */
export function postFromEvent(event: ChatEvent): MmPost | undefined {
  return parsedField<MmPost>(event, 'post');
}

function parsedField<T>(event: ChatEvent, field: string): T | undefined {
  const raw = event.data[field];
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** The reaction carried by `reaction_added` and `reaction_removed`. */
export function reactionFromEvent(event: ChatEvent): MmReaction | undefined {
  return parsedField<MmReaction>(event, 'reaction');
}

/** The channel carried by `channel_updated`. */
export function channelFromEvent(event: ChatEvent): MmChannel | undefined {
  return parsedField<MmChannel>(event, 'channel');
}
