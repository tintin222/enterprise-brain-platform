import { describe, expect, it } from 'vitest';
import { buildCreateChannelEvent, buildPostEvent, chooseCreatedAt, ORIGINAL_TIMESTAMP_WINDOW_MS } from './events.ts';
import { extractMentionUsernames } from './mentions.ts';

describe('chooseCreatedAt', () => {
  const now = 1_800_000_000_000;

  it('keeps a recent Mattermost timestamp', () => {
    expect(chooseCreatedAt(now - 5_000, now)).toBe(Math.floor((now - 5_000) / 1000));
  });

  it('uses the current time for anything outside the window', () => {
    expect(chooseCreatedAt(now - ORIGINAL_TIMESTAMP_WINDOW_MS - 1, now)).toBe(now / 1000);
    expect(chooseCreatedAt(now - 86_400_000, now)).toBe(now / 1000);
  });
});

describe('buildPostEvent', () => {
  const base = { relayChannelId: 'c0ffee00-0000-5000-8000-000000000000', post: { id: 'post1', message: 'hi @bob', create_at: 1_800_000_000_000 }, nowMs: 1_800_000_001_000 };

  it('builds a root message with channel, provenance and mention tags', () => {
    const event = buildPostEvent({ ...base, mentionPubkeys: ['pk1', 'pk1', 'pk2'] });
    expect(event.kind).toBe(9);
    expect(event.content).toBe('hi @bob');
    expect(event.tags).toEqual([
      ['h', base.relayChannelId],
      ['mm', 'post1'],
      ['mm_ts', '1800000000000'],
      ['p', 'pk1'],
      ['p', 'pk2'],
    ]);
    expect(event.created_at).toBe(1_800_000_000);
  });

  it('adds a reply tag and a backfill marker', () => {
    const event = buildPostEvent({ ...base, rootEventId: 'root', mentionPubkeys: [], backfill: true });
    expect(event.tags).toContainEqual(['e', 'root', '', 'reply']);
    expect(event.tags).toContainEqual(['backfill', '1']);
  });
});

describe('buildCreateChannelEvent', () => {
  it('carries the chosen id, name, visibility and about', () => {
    const event = buildCreateChannelEvent({ relayChannelId: 'id', name: 'Town Square', visibility: 'private', about: 'purpose', nowMs: 1_000 });
    expect(event).toMatchObject({ kind: 9007, created_at: 1 });
    expect(event.tags).toEqual([
      ['h', 'id'],
      ['name', 'Town Square'],
      ['visibility', 'private'],
      ['about', 'purpose'],
    ]);
  });
});

describe('extractMentionUsernames', () => {
  it('finds mentions, lowercases them and drops trailing punctuation', () => {
    expect(extractMentionUsernames('Hey @Bob, ask @finance-bot. Thanks @alice.')).toEqual(['bob', 'finance-bot', 'alice']);
  });

  it('ignores special mentions, emails and code', () => {
    expect(extractMentionUsernames('@channel @here @all mail me at a@b.com `@inline` ```\n@fenced\n```')).toEqual([]);
  });

  it('deduplicates', () => {
    expect(extractMentionUsernames('@bob @bob @BOB')).toEqual(['bob']);
  });
});
