import { generateSecretKeyBytes, nowSeconds, SecretKeySigner, type NostrEvent } from '@brain/shared';
import { describe, expect, it } from 'vitest';
import { toConversation } from './context.ts';
import type { AgentRecord } from './registry.ts';
import { knowledgeQuery } from './runtime.ts';
import { evaluateTriggers, mentionsExplicitly } from './triggers.ts';

const person = new SecretKeySigner(generateSecretKeyBytes());
const agentKey = new SecretKeySigner(generateSecretKeyBytes());
const otherKey = new SecretKeySigner(generateSecretKeyBytes());

function agent(handle: string, pubkey: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { agentId: handle, handle, displayName: handle.toUpperCase(), avatarUrl: null, instructions: '', provider: '', model: 'echo', tools: [], knowledgeScope: [], nostrPubkey: pubkey, mmBotUserId: `bot-${handle}`, status: 'active', ...overrides };
}

const finance = agent('finance', agentKey.pubkey);
const helper = agent('helper', otherKey.pubkey);

function message(author: SecretKeySigner, content: string, tags: string[][], createdAt = nowSeconds()): NostrEvent {
  return author.sign({ kind: 9, tags: [['h', 'channel'], ...tags], content, created_at: createdAt });
}

const base = { activeAgents: [finance, helper], agentPubkeys: new Set([agentKey.pubkey, otherKey.pubkey]), nowSeconds: nowSeconds(), maxEventAgeSeconds: 600 };

describe('evaluateTriggers', () => {
  it('triggers a mentioned agent that is a channel member', () => {
    const event = message(person, '@finance what did we decide?', [['p', agentKey.pubkey]]);
    const result = evaluateTriggers({ ...base, event, members: new Set([agentKey.pubkey]) });
    expect(result.triggered.map((a) => a.handle)).toEqual(['finance']);
  });

  it('does not trigger an agent that is not a channel member', () => {
    const event = message(person, '@finance hello', [['p', agentKey.pubkey]]);
    const result = evaluateTriggers({ ...base, event, members: new Set() });
    expect(result.triggered).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('not a channel member');
  });

  it('fails closed while membership is unknown', () => {
    const event = message(person, '@finance hello', [['p', agentKey.pubkey]]);
    expect(evaluateTriggers({ ...base, event, members: undefined }).skipped[0]?.reason).toBe('membership unknown');
  });

  it('ignores old messages, using mm_ts when present', () => {
    const now = nowSeconds();
    const fresh = message(person, '@finance hi', [['p', agentKey.pubkey], ['mm_ts', String((now - 30) * 1000)]], now);
    const stale = message(person, '@finance hi', [['p', agentKey.pubkey], ['mm_ts', String((now - 3600) * 1000)]], now);
    const members = new Set([agentKey.pubkey]);
    expect(evaluateTriggers({ ...base, event: fresh, members }).triggered).toHaveLength(1);
    expect(evaluateTriggers({ ...base, event: stale, members }).eventSkip).toBe('too old');
  });

  it('never triggers on backfilled history', () => {
    const event = message(person, '@finance hi', [['p', agentKey.pubkey], ['backfill', '1']]);
    expect(evaluateTriggers({ ...base, event, members: new Set([agentKey.pubkey]) }).eventSkip).toBe('history (backfill)');
  });

  it('lets an agent trigger another agent only with an explicit mention in the text', () => {
    const members = new Set([agentKey.pubkey, otherKey.pubkey]);
    const tagOnly = message(otherKey, 'echo: thanks', [['p', agentKey.pubkey]]);
    const explicit = message(otherKey, 'asking @finance to check', [['p', agentKey.pubkey]]);
    expect(evaluateTriggers({ ...base, event: tagOnly, members }).skipped[0]?.reason).toBe('agent author without an explicit mention');
    expect(evaluateTriggers({ ...base, event: explicit, members }).triggered.map((a) => a.handle)).toEqual(['finance']);
  });

  it('never triggers an agent on its own message', () => {
    const event = message(agentKey, '@finance talking to myself', [['p', agentKey.pubkey]]);
    expect(evaluateTriggers({ ...base, event, members: new Set([agentKey.pubkey]) }).skipped[0]?.reason).toBe('own message');
  });

  it('matches handles and display names case-insensitively', () => {
    expect(mentionsExplicitly('Hey @FINANCE', finance)).toBe(true);
    expect(mentionsExplicitly('hey finance', finance)).toBe(false);
  });
});

describe('toConversation', () => {
  it('keeps the first and the most recent messages within the budget', () => {
    const events = Array.from({ length: 10 }, (_, i) => message(person, `message ${i} ${'x'.repeat(100)}`, [], 1_000 + i));
    const turns = toConversation(events, new Map([[person.pubkey, 'Alice']]), new Set(), agentKey.pubkey, 600);
    expect(turns[0]?.text).toContain('message 0');
    expect(turns[1]?.text).toBe('[earlier messages omitted]');
    expect(turns.at(-1)?.text).toContain('message 9');
    expect(turns.length).toBeLessThan(10);
  });

  it('marks agents and the agent itself', () => {
    const events = [message(person, 'hi', [], 1), message(agentKey, 'hello', [], 2)];
    const turns = toConversation(events, new Map(), new Set([agentKey.pubkey]), agentKey.pubkey, 10_000);
    expect(turns.map((t) => [t.role, t.self ?? false])).toEqual([
      ['person', false],
      ['agent', true],
    ]);
  });
});

describe('knowledgeQuery', () => {
  it('drops @mentions, which name agents rather than topics', () => {
    expect(knowledgeQuery('@finance-bot when is the  budget review? cc @alice.b')).toBe('when is the budget review? cc');
  });
});
