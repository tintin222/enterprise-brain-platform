// Key and event helpers for scripts. Product code uses RelayClient in @brain/shared instead (CLAUDE.md rule 6).
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';

export type { Event };

export interface Identity {
  secretKey: Uint8Array;
  pubkey: string;
}

export function newSecretKeyHex(): string {
  return bytesToHex(generateSecretKey());
}

export function pubkeyOf(secretKeyHex: string): string {
  return getPublicKey(hexToBytes(secretKeyHex));
}

export function identityFromHex(secretKeyHex: string): Identity {
  const secretKey = hexToBytes(secretKeyHex);
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function newIdentity(): Identity {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sign an event. created_at defaults to now; pass it explicitly for deterministic ids. */
export function sign(
  identity: Identity,
  kind: number,
  tags: string[][],
  content = '',
  createdAt: number = nowSeconds(),
): Event {
  const template: EventTemplate = { kind, tags, content, created_at: createdAt };
  return finalizeEvent(template, identity.secretKey);
}
