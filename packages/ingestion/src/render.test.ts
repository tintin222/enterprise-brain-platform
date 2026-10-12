import { describe, expect, it } from 'vitest';
import { permalinkFor } from './ingestion.ts';
import { buildThreadDocuments, chunk, type ThreadMessage } from './render.ts';

const message = (id: string, pubkey: string, content: string, mmTs: number): ThreadMessage => ({ id, pubkey, content, created_at: 1_900_000_000, tags: [['mm_ts', String(mmTs)]] });

describe('chunk', () => {
  it('keeps items that fit together and overlaps consecutive chunks by one item', () => {
    expect(chunk(['aaaa', 'bbbb', 'cccc', 'dddd'], 9)).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it('gives an oversized item its own chunk and always makes progress', () => {
    expect(chunk(['a', 'x'.repeat(50), 'b'], 10)).toEqual([[0], [1], [2]]);
    expect(chunk(['one'], 10)).toEqual([[0]]);
  });
});

describe('buildThreadDocuments', () => {
  const names = new Map([
    ['alice', 'Alice'],
    ['bob', 'Bob'],
  ]);

  it('renders a thread as "Author: message" lines in message-time order', () => {
    const [doc, ...rest] = buildThreadDocuments({
      channelId: 'ch',
      channelName: 'General',
      rootId: 'r',
      messages: [message('x', 'bob', 'a reply', 2_000_000), message('r', 'alice', 'the question', 1_000_000)],
      names,
      sourceUrl: 'http://mm/_redirect/pl/p1',
      chunkChars: 6000,
    });
    expect(rest).toHaveLength(0);
    expect(doc).toMatchObject({
      id: 'thread:ch:r',
      text: 'Alice: the question\nBob: a reply',
      channelName: 'General',
      sourceUrl: 'http://mm/_redirect/pl/p1',
      eventIds: ['r', 'x'],
      authors: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
    });
    expect(doc?.firstAt).toEqual(new Date(1_000_000));
    expect(doc?.lastAt).toEqual(new Date(2_000_000));
  });

  it('puts the root first and orders same-second replies by their Mattermost time in ms', () => {
    const sameSecond = (id: string, mmTs: number): ThreadMessage => ({ id, pubkey: 'alice', content: id, created_at: 1_900_000_000, tags: [['mm_ts', String(mmTs)]] });
    const [doc] = buildThreadDocuments({ channelId: 'ch', channelName: 'General', rootId: 'zz-root', messages: [sameSecond('b', 1_900_000_000_900), sameSecond('a', 1_900_000_000_500), sameSecond('zz-root', 1_900_000_000_100)], names, chunkChars: 6000 });
    expect(doc?.eventIds).toEqual(['zz-root', 'a', 'b']);
  });

  it('splits long threads into numbered chunks', () => {
    const messages = Array.from({ length: 6 }, (_, i) => message(`m${i}`, 'alice', 'x'.repeat(400), i * 1000));
    const docs = buildThreadDocuments({ channelId: 'ch', channelName: 'General', rootId: 'm0', messages, names, chunkChars: 1000 });
    expect(docs.map((doc) => doc.id)).toEqual(['thread:ch:m0:0', 'thread:ch:m0:1', 'thread:ch:m0:2', 'thread:ch:m0:3', 'thread:ch:m0:4']);
    expect(docs.every((doc) => doc.text.length <= 1000)).toBe(true);
    expect(docs[1]?.eventIds[0]).toBe(docs[0]?.eventIds.at(-1));
  });

  it('has no document for an empty thread', () => {
    expect(buildThreadDocuments({ channelId: 'ch', channelName: 'General', rootId: 'r', messages: [], names, chunkChars: 6000 })).toEqual([]);
  });
});

describe('permalinkFor', () => {
  it('needs no team name', () => {
    expect(permalinkFor('http://localhost:8065/', 'abc')).toBe('http://localhost:8065/_redirect/pl/abc');
  });
});
