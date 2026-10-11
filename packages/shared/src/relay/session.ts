// A short-lived WebSocket session authenticated as one key, for events the relay only accepts over
// WebSocket: ephemeral kinds such as typing (kind 20002) are refused over HTTP ("restricted: unknown
// event kind"), but accepted over an authenticated socket and delivered live on #h subscriptions.
import { nowSeconds, type NostrEvent, type Signer, type UnsignedEvent } from '../nostr.ts';

export class RelaySession {
  readonly #socket: WebSocket;
  readonly #signer: Signer;

  private constructor(socket: WebSocket, signer: Signer) {
    this.#socket = socket;
    this.#signer = signer;
  }

  /** Open a socket and complete NIP-42 auth as `signer`. */
  static open(url: string, signer: Signer, timeoutMs = 10_000): Promise<RelaySession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let authId: string | undefined;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Relay session timed out during auth'));
      }, timeoutMs);
      socket.addEventListener('message', (message: MessageEvent) => {
        const frame = JSON.parse(String(message.data)) as unknown[];
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
          const auth = signer.sign({ kind: 22242, tags: [['relay', url], ['challenge', frame[1]]], content: '', created_at: nowSeconds() });
          authId = auth.id;
          socket.send(JSON.stringify(['AUTH', auth]));
        } else if (frame[0] === 'OK' && frame[1] === authId) {
          clearTimeout(timer);
          if (frame[2] === true) resolve(new RelaySession(socket, signer));
          else {
            socket.close();
            reject(new Error(`Relay refused auth: ${String(frame[3])}`));
          }
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Relay session failed to connect'));
      });
    });
  }

  /** Sign and send an event without waiting for the relay's answer (used for ephemeral events). */
  send(event: Omit<UnsignedEvent, 'created_at'>): NostrEvent {
    const signed = this.#signer.sign({ ...event, created_at: nowSeconds() });
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(['EVENT', signed]));
    return signed;
  }

  close(): void {
    this.#socket.close();
  }
}
