import { describe, expect, it } from 'vitest';
import { emojiForName, nameForEmoji } from './emoji.ts';
import {
  buildArchiveEvent,
  buildChannelMetadataEvent,
  buildCreateChannelEvent,
  buildDeletionEvent,
  buildEditEvent,
  buildPostEvent,
  buildReactionEvent,
  channelMetadata,
  chooseCreatedAt,
  metadataHash,
  ORIGINAL_TIMESTAMP_WINDOW_MS,
  postContent,
} from './events.ts';
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

describe('postContent', () => {
  it('appends attachment names and the permalink', () => {
    expect(postContent('see this', ['a.pdf', 'b.png'], 'http://mm/team/pl/p1')).toBe('see this\n\n📎 Attachments: a.pdf, b.png (http://mm/team/pl/p1)');
    expect(postContent('', ['a.pdf'], 'http://mm/team/pl/p1')).toBe('📎 Attachments: a.pdf (http://mm/team/pl/p1)');
    expect(postContent('plain', [], 'unused')).toBe('plain');
  });
});

describe('edit, deletion and reaction events', () => {
  const nowMs = 1_800_000_100_000;

  it('builds an edit with the target, provenance and the edit time', () => {
    const event = buildEditEvent({ relayChannelId: 'ch', targetEventId: 'ev1', postId: 'p1', content: 'new text', editAtMs: 1_800_000_099_000, mentionPubkeys: ['pk'], nowMs });
    expect(event).toMatchObject({ kind: 40003, content: 'new text', created_at: 1_800_000_099 });
    expect(event.tags).toEqual([
      ['h', 'ch'],
      ['e', 'ev1'],
      ['mm', 'p1'],
      ['mm_ts', '1800000099000'],
      ['p', 'pk'],
    ]);
  });

  it('builds deletions as the author (5) or as the channel owner (9005)', () => {
    expect(buildDeletionEvent(5, 'ch', 'ev1', nowMs)).toEqual({ kind: 5, tags: [['h', 'ch'], ['e', 'ev1']], content: '', created_at: 1_800_000_100 });
    expect(buildDeletionEvent(9005, 'ch', 'ev1', nowMs).kind).toBe(9005);
  });

  it('builds a reaction with the target author', () => {
    const event = buildReactionEvent({ relayChannelId: 'ch', targetEventId: 'ev1', targetAuthorPubkey: 'author', emoji: '👍', nowMs });
    expect(event).toMatchObject({ kind: 7, content: '👍' });
    expect(event.tags).toEqual([
      ['h', 'ch'],
      ['e', 'ev1'],
      ['p', 'author'],
    ]);
  });
});

describe('channel metadata', () => {
  const channel = { name: 'town-square', display_name: 'Town Square', purpose: ' Company news ', header: 'Links: wiki', type: 'P' as const };

  it('combines purpose and header into the about text', () => {
    expect(channelMetadata(channel)).toEqual({ name: 'Town Square', about: 'Company news\n\nLinks: wiki', visibility: 'private' });
    expect(channelMetadata({ ...channel, display_name: ' ', purpose: '', header: '', type: 'O' })).toEqual({ name: 'town-square', about: '', visibility: 'open' });
  });

  it('changes the hash when any published field changes', () => {
    const base = metadataHash(channelMetadata(channel));
    expect(metadataHash(channelMetadata({ ...channel }))).toBe(base);
    expect(metadataHash(channelMetadata({ ...channel, header: 'other' }))).not.toBe(base);
    expect(metadataHash(channelMetadata({ ...channel, type: 'O' }))).not.toBe(base);
  });

  it('publishes an empty about to clear it, and archive flags', () => {
    const event = buildChannelMetadataEvent({ relayChannelId: 'ch', name: 'N', about: '', visibility: 'open', nowMs: 1_000 });
    expect(event.tags).toEqual([
      ['h', 'ch'],
      ['name', 'N'],
      ['about', ''],
      ['visibility', 'open'],
    ]);
    expect(buildArchiveEvent('ch', true, 1_000).tags).toEqual([
      ['h', 'ch'],
      ['archived', 'true'],
    ]);
  });
});

describe('emoji', () => {
  it('maps Mattermost names to emoji, including aliases and skin tones', () => {
    expect(emojiForName('+1')).toBe('👍');
    expect(emojiForName('thumbsup')).toBe('👍');
    expect(emojiForName('tada')).toBe('🎉');
    expect(emojiForName('+1_light_skin_tone')).toBe('👍🏻');
    expect(emojiForName('heart')).toBe('❤️');
  });

  it('keeps custom emoji as :name:', () => {
    expect(emojiForName('company-logo')).toBe(':company-logo:');
    expect(nameForEmoji(':company-logo:')).toBe('company-logo');
  });

  it('maps relay content back to the primary Mattermost name', () => {
    expect(nameForEmoji('👍')).toBe('+1');
    expect(nameForEmoji('❤')).toBe('heart');
    expect(nameForEmoji('❤️')).toBe('heart');
    expect(nameForEmoji('👍🏻')).toBe('+1_light_skin_tone');
    expect(nameForEmoji('+')).toBe('+1');
    expect(nameForEmoji('')).toBe('+1');
    expect(nameForEmoji('-')).toBe('-1');
    expect(nameForEmoji('not an emoji')).toBeUndefined();
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
