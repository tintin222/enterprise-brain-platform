// Phase 5 acceptance: the five ingestion tests (docs/agents-and-ingestion.md B.5), purges (B.4), and an agent
// answer that uses an earlier thread in the same channel and cites its source link. The real-model variant
// runs when ANTHROPIC_API_KEY is set.
import { randomBytes } from 'node:crypto';
import type { AgentRecord } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { purgeAuthor, purgeChannel, type Ingestion } from '@brain/ingestion';
import { nowSeconds, relayChannelIdFor, threadDocId, type BrainDocument, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

const DEBOUNCE_SECONDS = 2;
/** The debounce plus time for the bridge, the relay and indexing. */
const INDEX_WITHIN_MS = (DEBOUNCE_SECONDS + 6) * 1000;

describe('ingestion and retrieval', () => {
  let stack: Stack;
  let bridge: Bridge;
  let ingestion: Ingestion;
  let alice: MmSession;
  let bob: MmSession;
  let admin: MmSession;
  let agent: AgentRecord;

  beforeAll(async () => {
    stack = new Stack({ INGEST_DEBOUNCE_SECONDS: String(DEBOUNCE_SECONDS) });
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    admin = await stack.login(stack.env.MM_ADMIN_USERNAME ?? '');
    agent = await stack.provision({ handle: 'agent-a', displayName: 'Agent A', model: 'echo' });
    bridge = await stack.startBridge();
    ingestion = await stack.startIngestion();
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await ingestion?.stop();
    await bridge?.stop();
    await stack?.close();
  });

  async function enabledChannel(label: string, type: 'O' | 'P' = 'O', members: string[] = [bob.user.id]): Promise<{ id: string }> {
    const channel = await stack.createChannel(alice, type, label, members);
    await stack.enable(alice, channel.id);
    return channel;
  }

  /** A thread root in Mattermost and its relay event id. */
  async function thread(channelId: string, text: string): Promise<{ root: MmPost; rootEventId: string; docId: string }> {
    const root = await stack.post(alice, channelId, text);
    const rootEventId = (await stack.waitForEventForPost(channelId, root.id)).id;
    return { root, rootEventId, docId: threadDocId(relayChannelIdFor(channelId), rootEventId) };
  }

  /** Wait until the brain has the document and its text passes `check`. */
  async function documentWith(docId: string, check: (text: string) => boolean, timeoutMs = INDEX_WITHIN_MS): Promise<BrainDocument> {
    return waitFor(async () => {
      const doc = await stack.brain.getDocument(docId);
      return doc && check(doc.text) ? doc : undefined;
    }, timeoutMs);
  }

  const token = (): string => `t${randomBytes(4).toString('hex')}`;

  it('B.5 test 1: a new thread appears in the brain within the debounce window', async () => {
    const channel = await enabledChannel('p5-new');
    const { root, docId } = await thread(channel.id, 'Kickoff notes for project heron');
    const onRelay = Date.now();
    await stack.post(bob, channel.id, 'Bob adds the budget', root.id);
    const doc = await documentWith(docId, (text) => text.includes('Bob adds the budget'));
    expect(Date.now() - onRelay).toBeLessThan(INDEX_WITHIN_MS);
    expect(doc.text.split('\n')).toHaveLength(2);
    expect(doc.text).toMatch(/^.+: Kickoff notes for project heron\n.+: Bob adds the budget$/);
    expect(doc.sourceUrl).toBe(`${stack.config.MM_URL}/_redirect/pl/${root.id}`);
    expect(doc.channelId).toBe(relayChannelIdFor(channel.id));
    expect(doc.authors).toHaveLength(2);
  });

  it('B.5 test 2: editing a message changes the indexed text', async () => {
    const channel = await enabledChannel('p5-edit');
    const { root, docId } = await thread(channel.id, 'The offsite is in Lisbon');
    await documentWith(docId, (text) => text.includes('Lisbon'));
    await alice.api.put(`/posts/${root.id}/patch`, { message: 'The offsite is in Porto' });
    const doc = await documentWith(docId, (text) => text.includes('Porto'));
    expect(doc.text).not.toContain('Lisbon');
  });

  it('B.5 test 3: deleting a message removes its text; deleting the last message removes the document', async () => {
    const channel = await enabledChannel('p5-delete');
    const { root, docId } = await thread(channel.id, 'Draft agenda');
    const reply = await stack.post(bob, channel.id, 'Remove this reply later', root.id);
    await documentWith(docId, (text) => text.includes('Remove this reply later'));
    await bob.api.delete(`/posts/${reply.id}`);
    await documentWith(docId, (text) => !text.includes('Remove this reply later') && text.includes('Draft agenda'));
    await alice.api.delete(`/posts/${root.id}`);
    await waitFor(async () => (await stack.brain.getDocument(docId)) === undefined, INDEX_WITHIN_MS);
  });

  it('B.5 test 4: restarting ingestion neither loses nor duplicates documents', { timeout: 180_000 }, async () => {
    const channel = await enabledChannel('p5-restart');
    const relayChannelId = relayChannelIdFor(channel.id);
    const a = await thread(channel.id, 'Thread A before the restart');
    await documentWith(a.docId, (text) => text.includes('Thread A'));

    // Changes while ingestion is down are found by catch-up.
    await ingestion.stop();
    const b = await thread(channel.id, 'Thread B while ingestion is down');
    await stack.post(bob, channel.id, 'A reply to A while ingestion is down', a.root.id);
    await alice.api.put(`/posts/${a.root.id}/patch`, { message: 'Thread A, edited while ingestion is down' });
    await stack.waitForEventForPost(channel.id, a.root.id, [40003]);
    ingestion = await stack.startIngestion();
    await documentWith(b.docId, (text) => text.includes('Thread B'), 60_000);
    await documentWith(a.docId, (text) => text.includes('edited while ingestion is down') && text.includes('A reply to A'), 60_000);

    // A thread still waiting out its debounce when ingestion stops is indexed after the restart.
    const c = await thread(channel.id, 'Thread C pending at the restart');
    await waitFor(async () => (await ingestion.store.pendingCount()) > 0);
    await ingestion.stop();
    ingestion = await stack.startIngestion();
    await documentWith(c.docId, (text) => text.includes('Thread C'), 60_000);

    await ingestion.catchUp();
    await ingestion.flush();
    expect(await stack.brain.documentIds(relayChannelId)).toEqual([a.docId, b.docId, c.docId].sort());
  });

  it('B.5 test 5: a search in channel X never returns content from private channel Y', { timeout: 120_000 }, async () => {
    const word = token();
    const channelX = await enabledChannel('p5-x');
    const channelY = await enabledChannel('p5-y', 'P');
    const channelZ = await enabledChannel('p5-z');
    const y = await thread(channelY.id, `Private plan ${word}: the acquisition closes in May`);
    const z = await thread(channelZ.id, `Public note ${word}: the roadmap is on the wiki`);
    await documentWith(y.docId, (text) => text.includes(word));
    await documentWith(z.docId, (text) => text.includes(word));
    const search = (channelId: string): Promise<string[]> => stack.brain.search({ query: word, channelId: relayChannelIdFor(channelId), limit: 20 }).then((found) => found.map((p) => p.id));

    expect(await search(channelX.id)).toEqual([z.docId]);
    expect((await search(channelY.id)).sort()).toEqual([y.docId, z.docId].sort());

    // Making Z private takes it out of other channels' results.
    await admin.api.put(`/channels/${channelZ.id}/privacy`, { privacy: 'P' });
    await waitFor(async () => (await search(channelX.id)).length === 0, 20_000);
    expect(await search(channelZ.id)).toEqual([z.docId]);
  });

  it('B.4: purging an author or a channel removes their content and keeps it out', { timeout: 120_000 }, async () => {
    const channel = await enabledChannel('p5-purge');
    const relayChannelId = relayChannelIdFor(channel.id);
    const { root, docId } = await thread(channel.id, 'A thread about the purge');
    // A throwaway author, so the purge does not exclude a real test user from later runs.
    const outsider = await stack.outsider();
    await stack.relay.publish(stack.bridgeSigner.sign({ kind: 9000, tags: [['h', relayChannelId], ['p', outsider.pubkey]], content: '', created_at: nowSeconds() }), stack.bridgeSigner);
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const said = outsider.sign({ kind: 9, tags: [['h', relayChannelId], ['e', rootEvent.id, '', 'reply']], content: 'Words to purge', created_at: nowSeconds() });
    await stack.relay.publish(said, outsider);
    await documentWith(docId, (text) => text.includes('Words to purge'));

    await purgeAuthor({ pool: stack.pool, brain: stack.brain }, outsider.pubkey);
    const doc = await documentWith(docId, (text) => !text.includes('Words to purge') && text.includes('A thread about the purge'));
    expect(doc.authors.map((author) => author.id)).not.toContain(outsider.pubkey);

    await purgeChannel({ pool: stack.pool, brain: stack.brain }, relayChannelId);
    expect(await stack.brain.documentIds(relayChannelId)).toEqual([]);
    const later = await thread(channel.id, 'Posted after the channel purge');
    await new Promise((resolve) => setTimeout(resolve, INDEX_WITHIN_MS));
    expect(await stack.brain.getDocument(later.docId)).toBeUndefined();
  });

  it('an agent answers using an earlier thread in the same channel and cites its source link', { timeout: 120_000 }, async () => {
    const word = token();
    const channel = await enabledChannel('p5-answer', 'O', [bob.user.id, agent.mmBotUserId]);
    const earlier = await thread(channel.id, `The ${word} security review happens on the first Tuesday of each month.`);
    await documentWith(earlier.docId, (text) => text.includes(word));
    const runtime = await stack.startRuntime({}, stack.brain);
    try {
      const question = await stack.post(bob, channel.id, `@agent-a when does the ${word} security review happen?`);
      const reply = await waitFor(async () => (await stack.thread(bob, question.id)).find((post) => post.user_id === agent.mmBotUserId), 60_000);
      expect(reply.message).toContain('first Tuesday of each month');
      expect(reply.message).toContain(`${stack.config.MM_URL}/_redirect/pl/${earlier.root.id}`);
    } finally {
      await runtime.stop();
    }
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)('a real model answers from an earlier thread and cites it', { timeout: 240_000 }, async () => {
    const word = token();
    const helper = await stack.provision({ handle: 'claude-helper', displayName: 'Claude Helper', model: '', instructions: 'You answer briefly.' });
    const channel = await enabledChannel('p5-model', 'O', [helper.mmBotUserId]);
    const earlier = await thread(channel.id, `Decision: the ${word} service moves to the Frankfurt region in March.`);
    await documentWith(earlier.docId, (text) => text.includes(word));
    const runtime = await stack.startRuntime({}, stack.brain);
    try {
      const question = await stack.post(alice, channel.id, `@claude-helper Which region does the ${word} service move to? Cite your source.`);
      const reply = await waitFor(async () => (await stack.thread(alice, question.id)).find((post) => post.user_id === helper.mmBotUserId), 180_000, 1000);
      expect(reply.message).toContain('Frankfurt');
      expect(reply.message).toContain(`/_redirect/pl/${earlier.root.id}`);
    } finally {
      await runtime.stop();
    }
  });
});
