// Phase 6 relay rebuild drill: wipe the relay, rebuild it from Mattermost, and confirm the bridge, agents and
// ingestion recover. Opt-in (E2E_RELAY_DRILL=1) because it deletes the local relay's data.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AgentRecord, AgentRuntime } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import type { Ingestion } from '@brain/ingestion';
import { isBackfill, relayChannelIdFor, tagValue, threadDocId, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pnpm = (...args: string[]): string => execFileSync('pnpm', ['--silent', ...args], { cwd: repoRoot, encoding: 'utf8' });

describe.skipIf(!process.env.E2E_RELAY_DRILL)('relay rebuild drill', () => {
  let stack: Stack;
  let bridge: Bridge | undefined;
  let runtime: AgentRuntime | undefined;
  let ingestion: Ingestion | undefined;
  let alice: MmSession;
  let bob: MmSession;
  let agent: AgentRecord;

  beforeAll(async () => {
    stack = new Stack({ INGEST_DEBOUNCE_SECONDS: '2' });
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    agent = await stack.provision({ handle: 'agent-a', displayName: 'Agent A', model: 'echo' });
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await runtime?.stop();
    await ingestion?.stop();
    await bridge?.stop();
    await stack?.close();
  });

  async function startAll(): Promise<void> {
    bridge = await stack.startBridge();
    ingestion = await stack.startIngestion();
    runtime = await stack.startRuntime({}, stack.brain);
  }

  async function stopAll(): Promise<void> {
    await runtime?.stop();
    await ingestion?.stop();
    await bridge?.stop();
  }

  const agentReplies = async (post: MmPost): Promise<MmPost[]> => (await stack.thread(alice, post.root_id || post.id)).filter((p) => p.user_id === agent.mmBotUserId);

  it('rebuilds the relay from Mattermost; mirroring, agents and ingestion recover', { timeout: 600_000 }, async () => {
    await startAll();
    const word = `drill${randomBytes(3).toString('hex')}`;
    const channel = await stack.createChannel(alice, 'O', 'p6-drill', [bob.user.id, agent.mmBotUserId]);
    await stack.enable(alice, channel.id);
    const root = await stack.post(alice, channel.id, `The ${word} backup window is Sunday 01:00 UTC`);
    await stack.post(bob, channel.id, 'Confirmed', root.id);
    const mention = await stack.post(alice, channel.id, '@agent-a ping before the drill');
    await waitFor(async () => (await agentReplies(mention)).length === 1, 60_000);
    await alice.api.put(`/posts/${root.id}/patch`, { message: `The ${word} backup window is Sunday 02:00 UTC` });
    await bob.api.post('/reactions', { user_id: bob.user.id, post_id: root.id, emoji_name: '+1' });
    await stack.waitForEventForPost(channel.id, root.id, [40003]);
    const oldRoot = await stack.waitForEventForPost(channel.id, root.id);
    await waitFor(async () => (await stack.brain.getDocument(threadDocId(relayChannelIdFor(channel.id), oldRoot.id)))?.text.includes('02:00'), 30_000);
    const posts = async (): Promise<MmPost[]> =>
      Object.values((await alice.api.get<{ posts: Record<string, MmPost> }>(`/channels/${channel.id}/posts?per_page=200`)).posts).filter((post) => post.type === '' && post.delete_at === 0);
    const before = await posts();

    // The drill: stop everything, wipe the relay, reset our relay-derived state, start again.
    await stopAll();
    pnpm('relay:wipe', '--yes');
    expect(await stack.relay.query([{ kinds: [9], '#h': [relayChannelIdFor(channel.id)] }], stack.bridgeSigner)).toHaveLength(0);
    expect(pnpm('relay:rebuild')).toContain('will be created again and replayed');
    await startAll();

    // Every Mattermost post is on the relay again exactly once, as history, signed by its author.
    for (const post of before) {
      const event = await waitFor(async () => (await stack.eventsForPost(channel.id, post.id))[0], 120_000, 1000);
      expect(await stack.eventsForPost(channel.id, post.id), post.message).toHaveLength(1);
      expect(isBackfill(event), post.message).toBe(true);
      const author = await stack.identities.get(post.user_id);
      expect(event.pubkey).toBe(author?.pubkey);
    }
    const newRoot = (await stack.eventsForPost(channel.id, root.id))[0]!;
    expect(newRoot.content).toContain('02:00');
    await waitFor(async () => (await stack.relay.query([{ kinds: [7], '#e': [newRoot.id] }], stack.reader)).some((event) => event.content === '👍'), 30_000);
    // Nothing was posted to Mattermost twice, and agents did not answer the replayed history.
    expect((await posts()).length).toBe(before.length);
    expect(await agentReplies(mention)).toHaveLength(1);

    // Ingestion re-indexed the rebuilt relay, and agents answer new mentions (with that knowledge).
    const doc = await waitFor(async () => stack.brain.getDocument(threadDocId(relayChannelIdFor(channel.id), newRoot.id)), 60_000);
    expect(doc.text).toContain('02:00');
    expect(tagValue(newRoot, 'mm')).toBe(root.id);
    const after = await stack.post(alice, channel.id, `@agent-a when is the ${word} backup window?`);
    const reply = await waitFor(async () => (await agentReplies(after))[0], 60_000);
    expect(reply.message).toContain('Sunday 02:00 UTC');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await agentReplies(after)).toHaveLength(1);
  });
});
