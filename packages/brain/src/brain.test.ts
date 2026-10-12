import { describe, expect, it } from 'vitest';
import { splitDocId, toPassage } from './brain-client.ts';
import { approximateTokens, chunkEntityText, splitText } from './chunker.ts';
import { Params, scopeSql, toVectorLiteral } from './search.ts';
import { defaultVisibility, slugify } from './store.ts';
import type { SearchResult } from './types.ts';

describe('splitText', () => {
  it('keeps short text whole and splits long text at paragraphs with an overlap', () => {
    expect(splitText('short')).toEqual(['short']);
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`.trim());
    const pieces = splitText(paragraphs.join('\n\n'), 600, 60);
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(600);
    // Every paragraph starts some piece or sits inside one; the overlap repeats the previous tail.
    expect(pieces.join('\n')).toContain('Paragraph 11');
    expect(pieces[1]).toContain('word');
  });

  it('splits an overlong paragraph by sentences and never loses text', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const pieces = splitText(sentences, 120, 0);
    expect(pieces.every((piece) => piece.length <= 120)).toBe(true);
    expect(pieces.join(' ')).toContain('Sentence number 29');
  });

  it('heads the first chunk with the title and gives an empty entity one title chunk', () => {
    expect(chunkEntityText('ERP migration', '')).toEqual([{ ordinal: 0, text: 'ERP migration', tokens: approximateTokens('ERP migration') }]);
    const chunks = chunkEntityText('ERP migration', 'Body text.');
    expect(chunks[0]?.text).toBe('ERP migration\n\nBody text.');
  });
});

describe('slugify and visibility', () => {
  it('makes url-safe slugs', () => {
    expect(slugify('Acme ERP: Phase 2 (Ümlaut)')).toBe('acme-erp-phase-2-umlaut');
    expect(slugify('!!!')).toBe('item');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48);
  });

  it('defaults visibility from the channel and the container', () => {
    expect(defaultVisibility('general', undefined)).toBe('public');
    expect(defaultVisibility('p1', undefined)).toBe('container');
    expect(defaultVisibility('p1', 'relay-channel')).toBe('members');
  });
});

describe('scopeSql', () => {
  it('admits everything for admins and binds channels and containers for people', () => {
    expect(scopeSql({ kind: 'all' }, new Params())).toBe('TRUE');
    const params = new Params();
    const sql = scopeSql({ kind: 'person', channelIds: ['c1'], containerIds: ['p1'] }, params);
    expect(sql).toContain("c.visibility = 'public'");
    expect(sql).toContain('c.channel_id = ANY($1::text[])');
    expect(sql).toContain('c.container_id = ANY($2::text[])');
    expect(params.values).toEqual([['c1'], ['p1']]);
  });

  it('keeps the D35 rule for agents answering in a channel', () => {
    const params = new Params();
    const sql = scopeSql({ kind: 'channel', channelId: 'c1', containerId: 'p1' }, params);
    expect(sql).toContain('c.channel_id = $1');
    expect(sql).toContain('ch.active');
    expect(sql).toContain('c.container_id = $2');
    expect(params.values).toEqual(['c1', 'p1']);
  });

  it('writes vectors as pgvector literals', () => {
    expect(toVectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]');
  });
});

describe('document ids and passages', () => {
  const root = 'a'.repeat(64);

  it('splits thread document ids into the thread and the chunk ordinal', () => {
    expect(splitDocId(`thread:ch:${root}`)).toEqual({ base: `thread:ch:${root}`, ordinal: undefined });
    expect(splitDocId(`thread:ch:${root}:3`)).toEqual({ base: `thread:ch:${root}`, ordinal: 3 });
  });

  it('turns a search result into a passage with the source link and the thread id', () => {
    const result: SearchResult = {
      entityId: 'e1',
      entityType: 'conversation',
      title: 'Alice: hello',
      containerId: 'general',
      channelId: 'ch',
      version: 2,
      updatedAt: new Date('2026-10-12T10:00:00Z'),
      chunkId: 'e1:0',
      docId: `thread:ch:${root}`,
      snippet: 'hello',
      text: 'Alice: hello',
      score: 0.03,
      matched: ['keyword'],
      citation: { kind: 'post', url: 'http://mm/_redirect/pl/p1', postId: 'p1' },
      metadata: { channel_name: 'general' },
    };
    expect(toPassage(result)).toEqual({ id: `thread:ch:${root}`, text: 'Alice: hello', title: 'general, 2026-10-12', sourceUrl: 'http://mm/_redirect/pl/p1', channelId: 'ch', score: 0.03 });
  });
});
