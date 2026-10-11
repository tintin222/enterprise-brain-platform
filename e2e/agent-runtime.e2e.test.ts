// Phase 3 acceptance (docs/build-plan.md): replies in the thread, no agent loops, membership checks, and
// the age limit after a restart. Agents use the deterministic "echo" model; one test uses a real model
// when ANTHROPIC_API_KEY is set.
import type { AgentRecord, AgentRuntime } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { MattermostSocket, type MmPost } from '@brain/scripts/lib/mattermost.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

const quiet = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('agent runtime', () => {
  let stack: Stack;
  let bridge: Bridge;
  let runtime: AgentRuntime | undefined;
  let alice: MmSession;
  let agentA: AgentRecord;
  let agentB: AgentRecord;
  let agentC: AgentRecord;

  const repliesFrom = async (agent: AgentRecord, rootId: string): Promise<MmPost[]> => (await stack.thread(alice, rootId)).filter((post) => post.user_id === agent.mmBotUserId);

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    agentA = await stack.provision({ handle: 'agent-a', displayName: 'Agent A', model: 'echo' });
    agentB = await stack.provision({ handle: 'agent-b', displayName: 'Agent B', model: 'echo' });
    agentC = await stack.provision({ handle: 'agent-c', displayName: 'Agent C', model: 'echo' });
    bridge = await stack.startBridge();
    runtime = await stack.startRuntime({ MAX_REPLIES_PER_THREAD: '3' });
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await runtime?.stop();
    await bridge?.stop();
    await stack?.close();
  });

  it('mentioning an agent produces one reply in the thread, and its typing shows in Mattermost', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p3-reply', [agentA.mmBotUserId]);
    await stack.enable(alice, channel.id);
    // Typing is ephemeral: it only reaches Mattermost once the bridge's relay subscription is live.
    await waitFor(() => bridge.relaySubscriptionActive(channel.id), 30_000);
    const socket = await MattermostSocket.connect(stack.config.MM_URL, alice.api.token ?? '');
    try {
      const mention = await stack.post(alice, channel.id, '@agent-a what is the status?');
      await waitFor(async () => (await repliesFrom(agentA, mention.id)).length > 0, 30_000);
      const [reply] = await repliesFrom(agentA, mention.id);
      expect(reply?.message).toBe('echo: @agent-a what is the status?');
      expect(reply?.root_id).toBe(mention.id);
      await socket.waitFor((event) => event.event === 'typing' && event.data.user_id === agentA.mmBotUserId, 10_000);
      await quiet(3000);
      expect(await repliesFrom(agentA, mention.id)).toHaveLength(1);
    } finally {
      socket.close();
    }
  });

  it('two agents in one channel do not loop: the per-thread reply cap stops them', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p3-loop', [agentA.mmBotUserId, agentB.mmBotUserId]);
    await stack.enable(alice, channel.id);
    // Each echo reply names the other agent, so they keep asking each other until the cap (3 here).
    const mention = await stack.post(alice, channel.id, '@agent-a and @agent-b, talk to each other');
    await waitFor(async () => (await repliesFrom(agentA, mention.id)).length > 0 && (await repliesFrom(agentB, mention.id)).length > 0, 30_000);

    let last = -1;
    await waitFor(async () => {
      const total = (await stack.thread(alice, mention.id)).length;
      const settled = total === last;
      last = total;
      return settled;
    }, 60_000, 6000);
    expect((await repliesFrom(agentA, mention.id)).length).toBeLessThanOrEqual(3);
    expect((await repliesFrom(agentB, mention.id)).length).toBeLessThanOrEqual(3);
    const capped = await stack.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM runtime.jobs WHERE status = 'skipped' AND error = 'reply cap reached' AND agent_id IN ('agent-a', 'agent-b')");
    expect(capped.rows[0]?.n).toBeGreaterThan(0);
  });

  it('an agent that is not a member of the channel does not respond when mentioned', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p3-member', [agentA.mmBotUserId]);
    await stack.enable(alice, channel.id);
    const mention = await stack.post(alice, channel.id, '@agent-c are you here?');
    const event = await stack.waitForEventForPost(channel.id, mention.id);
    expect(event.tags).toContainEqual(['p', agentC.nostrPubkey]);
    await quiet(8000);
    expect(await repliesFrom(agentC, mention.id)).toHaveLength(0);
    const jobs = await stack.pool.query('SELECT 1 FROM runtime.jobs WHERE agent_id = $1 AND trigger_event_id = $2', ['agent-c', event.id]);
    expect(jobs.rowCount).toBe(0);
  });

  it('mentions older than the age limit are ignored after a restart', { timeout: 180_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'p3-age', [agentA.mmBotUserId]);
    await stack.enable(alice, channel.id);
    await runtime?.stop();
    runtime = undefined;

    const old = await stack.post(alice, channel.id, '@agent-a this waits while you are down');
    await stack.waitForEventForPost(channel.id, old.id);
    await quiet(8000);
    runtime = await stack.startRuntime({ MAX_EVENT_AGE_SECONDS: '5', MAX_REPLIES_PER_THREAD: '3' });
    await quiet(8000);
    expect(await repliesFrom(agentA, old.id)).toHaveLength(0);

    const fresh = await stack.post(alice, channel.id, '@agent-a and now?');
    await waitFor(async () => (await repliesFrom(agentA, fresh.id)).length > 0, 30_000);
    expect(await repliesFrom(agentA, old.id)).toHaveLength(0);
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)('a real model gives a relevant reply in the thread', { timeout: 180_000 }, async () => {
    const helper = await stack.provision({ handle: 'claude-helper', displayName: 'Claude Helper', model: '', instructions: 'You answer briefly.' });
    const channel = await stack.createChannel(alice, 'O', 'p3-model', [helper.mmBotUserId]);
    await stack.enable(alice, channel.id);
    const question = await stack.post(alice, channel.id, '@claude-helper What is 2 + 2? Answer with just the number.');
    await waitFor(async () => (await repliesFrom(helper, question.id)).length > 0, 120_000, 1000);
    expect((await repliesFrom(helper, question.id))[0]?.message).toContain('4');
  });
});
