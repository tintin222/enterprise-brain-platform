import { verifyEvent, type Event } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { newIdentity } from './nostr.ts';
import { blossomHeader, nip98Header, sha256Hex } from './relay.ts';

function decode(header: string): Event {
  expect(header.startsWith('Nostr ')).toBe(true);
  return JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString()) as Event;
}

const tag = (event: Event, name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1];

describe('nip98Header', () => {
  const identity = newIdentity();
  const url = 'http://localhost:3000/events';
  const body = '{"kind":9}';

  it('signs a kind 27235 event with u, method, payload and nonce tags', () => {
    const event = decode(nip98Header(identity, url, 'post', body));
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(27235);
    expect(event.pubkey).toBe(identity.pubkey);
    expect(tag(event, 'u')).toBe(url);
    expect(tag(event, 'method')).toBe('POST');
    expect(tag(event, 'payload')).toBe(sha256Hex(body));
    expect(tag(event, 'nonce')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives two requests in the same second different auth ids thanks to the nonce', () => {
    const createdAt = 1_800_000_000;
    const a = decode(nip98Header(identity, url, 'POST', body, { createdAt }));
    const b = decode(nip98Header(identity, url, 'POST', body, { createdAt }));
    expect(a.id).not.toBe(b.id);
  });

  it('without a nonce, the same request in the same second has the same auth id (relay replay guard)', () => {
    const createdAt = 1_800_000_000;
    const a = decode(nip98Header(identity, url, 'POST', body, { nonce: false, createdAt }));
    const b = decode(nip98Header(identity, url, 'POST', body, { nonce: false, createdAt }));
    expect(a.id).toBe(b.id);
  });
});

describe('blossomHeader', () => {
  it('signs a kind 24242 event with t, x and a future expiration', () => {
    const sha = sha256Hex('blob');
    const event = decode(blossomHeader(newIdentity(), 'upload', sha));
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(24242);
    expect(tag(event, 't')).toBe('upload');
    expect(tag(event, 'x')).toBe(sha);
    expect(Number(tag(event, 'expiration'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(event.content).not.toBe('');
  });
});
