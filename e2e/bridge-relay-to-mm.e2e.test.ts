// Phase 2 acceptance: bridge-spec test 3, the echo agent loop, and restarts without loss or duplicates.
import type { AgentRecord, EchoAgent } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { nowSeconds, relayChannelIdFor, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

describe('bridge: relay -> Mattermost and the echo agent', () => {
  let stack: Stack;
  let bridge: Bridge;
  let echoAgent: EchoAgent | undefined;
  let echo: AgentRecord;
  let alice: MmSession;
  let bob: MmSession;

  /** Echo replies to a mention, as seen in Mattermost. */
  async function echoReplies(mention: MmPost): Promise<MmPost[]> {
    const posts = await stack.thread(alice, mention.root_id || mention.id);
    return posts.filter((post) => post.user_id === echo.mmBotUserId && post.message === `echo: ${mention.message}`);
  }

  async function channelWithEcho(label: string): Promise<{ id: string }> {
    const channel = await stack.createChannel(alice, 'O', label, [bob.user.id, echo.mmBotUserId]);
    await stack.enable(alice, channel.id);
    return channel;
  }

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    echo = await stack.provision({ handle: 'echo', displayName: 'Echo', model: 'echo' });
    bridge = await stack.startBridge();
    // Running throughout: it only answers mentions, which test 3 does not contain.
    echoAgent = await stack.startEcho(echo);
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await echoAgent?.stop();
    await bridge?.stop();
    await stack?.close();
  });

  it('test 3: an agent-authored relay event appears once in Mattermost, as the agent bot, in the right thread', async () => {
    const channel = await channelWithEcho('p2-t3');
    const root = await stack.post(alice, channel.id, 'question for the agent');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);

    const signer = await stack.keyStore().signerFor(echo.nostrPubkey);
    const relayChannelId = relayChannelIdFor(channel.id);
    const answer = signer.sign({ kind: 9, tags: [['h', relayChannelId], ['e', rootEvent.id, '', 'reply']], content: 'an answer from the agent', created_at: nowSeconds() });
    await stack.relay.publish(answer, signer);

    const mirrored = await waitFor(async () => (await stack.thread(alice, root.id)).find((post) => post.props?.relay_event_id === answer.id));
    expect(mirrored.user_id).toBe(echo.mmBotUserId);
    expect(mirrored.root_id).toBe(root.id);
    expect(mirrored.message).toBe('an answer from the agent');

    await Promise.all([bridge.handleRelayEvent(relayChannelId, answer), bridge.handleRelayEvent(relayChannelId, answer)]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect((await stack.thread(alice, root.id)).filter((post) => post.props?.relay_event_id === answer.id)).toHaveLength(1);
    // The agent's post must not travel back to the relay as a new event.
    expect(await stack.eventsForPost(channel.id, mirrored.id)).toHaveLength(0);
  });

  it('a person mentions the echo agent and sees exactly one reply in the thread', async () => {
    const channel = await channelWithEcho('p2-echo');
    const mention = await stack.post(alice, channel.id, '@echo ping');
    await waitFor(async () => (await echoReplies(mention)).length > 0, 30_000);

    const inThread = await stack.post(bob, channel.id, '@echo again, in the thread', mention.id);
    await waitFor(async () => (await echoReplies(inThread)).length > 0, 30_000);
    const reply = (await echoReplies(inThread))[0];
    expect(reply?.root_id).toBe(mention.id);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await echoReplies(mention)).toHaveLength(1);
    expect(await echoReplies(inThread)).toHaveLength(1);
  });

  it('restarting the echo agent, the bridge or the relay mid-conversation loses nothing and duplicates nothing', { timeout: 300_000 }, async () => {
    const channel = await channelWithEcho('p2-restart');
    const mentions: MmPost[] = [];
    const ask = async (text: string): Promise<MmPost> => {
      const post = await stack.post(alice, channel.id, text);
      mentions.push(post);
      return post;
    };

    await ask('@echo before any restart');
    await waitFor(async () => (await echoReplies(mentions[0]!)).length > 0, 30_000);

    await echoAgent?.stop();
    await ask('@echo while the echo agent is down');
    echoAgent = await stack.startEcho(echo);

    await bridge.stop();
    await ask('@echo while the bridge is down');
    bridge = await stack.startBridge();

    await stack.restartRelay();
    await ask('@echo right after the relay restarted');

    for (const mention of mentions) await waitFor(async () => (await echoReplies(mention)).length > 0, 90_000);
    // Give catch-up and retries time to produce any duplicate.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    for (const mention of mentions) {
      expect(await echoReplies(mention), mention.message).toHaveLength(1);
      expect(await stack.eventsForPost(channel.id, mention.id), mention.message).toHaveLength(1);
    }
  });

  it('restarting Mattermost mid-conversation loses nothing and duplicates nothing', { timeout: 300_000 }, async () => {
    const channel = await channelWithEcho('p2-mm-restart');
    const before = await stack.post(alice, channel.id, '@echo before Mattermost restarts');
    await waitFor(async () => (await echoReplies(before)).length > 0, 30_000);

    await stack.restartMattermost();
    alice = await stack.login('alice');
    const after = await stack.post(alice, channel.id, '@echo after Mattermost restarted');
    await waitFor(async () => (await echoReplies(after)).length > 0, 90_000);

    await new Promise((resolve) => setTimeout(resolve, 8000));
    for (const mention of [before, after]) {
      expect(await echoReplies(mention), mention.message).toHaveLength(1);
      expect(await stack.eventsForPost(channel.id, mention.id), mention.message).toHaveLength(1);
    }
  });
});
