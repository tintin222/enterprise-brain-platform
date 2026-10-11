// Nostr primitives: events, signers, tag helpers and deterministic ids.
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export type NostrEvent = Event;

export interface UnsignedEvent {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/** Something that can sign events as one pubkey. */
export interface Signer {
  readonly pubkey: string;
  sign(event: UnsignedEvent): NostrEvent;
}

export class SecretKeySigner implements Signer {
  readonly pubkey: string;
  readonly #secretKey: Uint8Array;

  constructor(secretKey: Uint8Array) {
    this.#secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
  }

  sign(event: UnsignedEvent): NostrEvent {
    return finalizeEvent(event, this.#secretKey);
  }
}

export function signerFromHex(secretKeyHex: string): Signer {
  return new SecretKeySigner(hexToBytes(secretKeyHex));
}

export function generateSecretKeyBytes(): Uint8Array {
  return generateSecretKey();
}

export function pubkeyOfSecret(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

export { bytesToHex, hexToBytes, verifyEvent };

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function tagValue(event: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function tagValues(event: Pick<NostrEvent, 'tags'>, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name && tag[1] !== undefined).map((tag) => tag[1] as string);
}

/** The event this kind 9 replies to (the `e` tag marked `reply`), if any. */
export function replyTarget(event: Pick<NostrEvent, 'tags'>): string | undefined {
  return event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'reply')?.[1];
}

/** The thread root (the `e` tag marked `root`, else the `reply` target). */
export function threadRoot(event: Pick<NostrEvent, 'tags'>): string | undefined {
  return event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root')?.[1] ?? replyTarget(event);
}

/** When a message was written: the Mattermost time in `mm_ts` (ms) when present (spike A5), else created_at. */
export function messageTimeSeconds(event: Pick<NostrEvent, 'tags' | 'created_at'>): number {
  const mmTs = Number(tagValue(event, 'mm_ts'));
  return Number.isFinite(mmTs) && mmTs > 0 ? Math.floor(mmTs / 1000) : event.created_at;
}

/** History mirrored by the bridge (backfill or old thread roots); agents never answer it. */
export function isBackfill(event: Pick<NostrEvent, 'tags'>): boolean {
  return tagValue(event, 'backfill') === '1';
}

/** RFC 4122 version 5 UUID: deterministic for a namespace and name. */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error(`Invalid namespace UUID: ${namespace}`);
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Namespace for relay channel ids derived from Mattermost channel ids (D18). Never change it. */
export const RELAY_CHANNEL_NAMESPACE = 'dcf6c884-31d3-4200-8171-0e49a0bd2155';

export function relayChannelIdFor(mmChannelId: string): string {
  return uuidv5(mmChannelId, RELAY_CHANNEL_NAMESPACE);
}
