// Signed, stateless tokens: the session cookie after a Mattermost sign-in, and the state carried through
// Mattermost dialogs and buttons (plan section 8). HMAC-SHA256 under BRAIN_SESSION_SECRET; nothing is stored.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** Mattermost user id. */
  uid: string;
  /** Unix seconds. */
  exp: number;
  /** What the token is for: a browser session or a callback state. */
  use: 'session' | 'state';
  /** Free data for callback states (purpose, channel, container). */
  data?: Record<string, string>;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export class TokenSigner {
  readonly #key: Buffer;

  constructor(secretHex: string) {
    this.#key = Buffer.from(secretHex, 'hex');
    if (this.#key.length !== 32) throw new Error('BRAIN_SESSION_SECRET must be 32 bytes as hex');
  }

  sign(payload: SessionPayload): string {
    const body = encode(payload);
    return `${body}.${createHmac('sha256', this.#key).update(body).digest('base64url')}`;
  }

  /** The payload when the signature holds and the token has not expired. */
  verify(token: string | undefined, use: SessionPayload['use'], now = Date.now()): SessionPayload | undefined {
    if (!token) return undefined;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = createHmac('sha256', this.#key).update(body).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
      if (payload.use !== use || typeof payload.uid !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 < now) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }
}
