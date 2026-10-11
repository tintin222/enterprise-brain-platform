// Phase 4 acceptance: bridge-spec test 6 (edits and deletions in both directions), reactions round-trip,
// channel metadata, pause and archive, membership reconciliation within one interval, backfill that agents
// ignore, and attachments as permalinks.
import type { AgentRecord } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { nowSeconds, relayChannelIdFor, tagValue, type MmPost, type MmReaction, type Signer } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

const RECONCILE_INTERVAL_SECONDS = 20;
const quiet = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('bridge: edits, deletions, reactions, channel lifecycle, backfill', () => {
  let stack: Stack;
  let bridge: Bridge;
  let alice: MmSession;
  let bob: MmSession;
  let admin: MmSession;
  let agent: AgentRecord;
  let agentSigner: Signer;

  beforeAll(async () => {
    stack = new Stack({ BACKFILL_DAYS: '1', RECONCILE_INTERVAL_SECONDS: String(RECONCILE_INTERVAL_SECONDS) });
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    admin = await stack.login(stack.env.MM_ADMIN_USERNAME ?? '');
    agent = await stack.provision({ handle: 'agent-a', displayName: 'Agent A', model: 'echo' });
    agentSigner = await stack.keyStore().signerFor(agent.nostrPubkey);
    bridge = await stack.startBridge();
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await bridge?.stop();
    await stack?.close();
  });

  async function enabledChannel(label: string, type: 'O' | 'P' = 'O'): Promise<{ id: string }> {
    const channel = await stack.createChannel(alice, type, label, [bob.user.id, agent.mmBotUserId]);
    await stack.enable(alice, channel.id);
    return channel;
  }

  async function personKey(session: MmSession): Promise<string> {
    return waitFor(async () => (await stack.identities.get(session.user.id))?.pubkey);
  }

  /** The agent replies on the relay; returns the event and its Mattermost copy. */
  async function agentReply(channelId: string, rootEventId: string, rootPostId: string, text: string): Promise<{ eventId: string; post: MmPost }> {
    const event = agentSigner.sign({ kind: 9, tags: [['h', relayChannelIdFor(channelId)], ['e', rootEventId, '', 'reply']], content: text, created_at: nowSeconds() });
    await stack.relay.publish(event, agentSigner);
    const post = await waitFor(async () => (await stack.thread(alice, rootPostId)).find((p) => p.props?.relay_event_id === event.id));
    return { eventId: event.id, post };
  }

  async function reactionsInMm(postId: string): Promise<MmReaction[]> {
    return (await alice.api.get<MmReaction[] | null>(`/posts/${postId}/reactions`)) ?? [];
  }

  it('test 6a: edits and deletions in Mattermost reach the relay, including a deleted root’s replies', async () => {
    const channel = await enabledChannel('p4-edit-mm');
    const root = await stack.post(alice, channel.id, 'first version');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const reply = await stack.post(bob, channel.id, 'a reply', root.id);
    const replyEvent = await stack.waitForEventForPost(channel.id, reply.id);

    await alice.api.put(`/posts/${root.id}/patch`, { message: 'second version' });
    const edit = await waitFor(async () => (await stack.relay.query([{ kinds: [40003], '#e': [rootEvent.id] }], stack.reader))[0]);
    expect(edit.pubkey).toBe(rootEvent.pubkey);
    expect(edit.content).toBe('second version');
    expect(tagValue(edit, 'h')).toBe(relayChannelIdFor(channel.id));

    // Mattermost deletes a root's replies with it but sends an event only for the root.
    await alice.api.delete(`/posts/${root.id}`);
    await waitFor(async () => (await stack.relay.query([{ ids: [rootEvent.id, replyEvent.id] }], stack.reader)).length === 0);
    const deletions = await stack.relay.query([{ kinds: [5], '#e': [rootEvent.id, replyEvent.id] }], stack.reader);
    expect(deletions.map((event) => event.pubkey).sort()).toEqual([rootEvent.pubkey, replyEvent.pubkey].sort());
  });

  it('test 6b: agent edits and deletions on the relay reach Mattermost, and are not echoed back', async () => {
    const channel = await enabledChannel('p4-edit-agent');
    const relayChannelId = relayChannelIdFor(channel.id);
    const root = await stack.post(alice, channel.id, 'a question');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const { eventId, post } = await agentReply(channel.id, rootEvent.id, root.id, 'draft answer');

    const edit = agentSigner.sign({ kind: 40003, tags: [['h', relayChannelId], ['e', eventId]], content: 'final answer', created_at: nowSeconds() + 1 });
    await stack.relay.publish(edit, agentSigner);
    await waitFor(async () => (await alice.api.get<MmPost>(`/posts/${post.id}`)).message === 'final answer');

    // An older edit that arrives late does not win.
    const stale = agentSigner.sign({ kind: 40003, tags: [['h', relayChannelId], ['e', eventId]], content: 'stale answer', created_at: nowSeconds() - 60 });
    await stack.relay.publish(stale, agentSigner);
    await bridge.handleRelayEvent(relayChannelId, stale);
    expect((await alice.api.get<MmPost>(`/posts/${post.id}`)).message).toBe('final answer');
    // The bridge's own edit of the agent's post is not mirrored back.
    expect(await stack.relay.query([{ kinds: [40003], '#e': [eventId] }], stack.reader)).toHaveLength(2);

    const deletion = agentSigner.sign({ kind: 5, tags: [['h', relayChannelId], ['e', eventId]], content: '', created_at: nowSeconds() });
    await stack.relay.publish(deletion, agentSigner);
    await waitFor(async () => (await alice.api.find(`/posts/${post.id}`)) === undefined);
    await quiet(2000);
    expect(await stack.relay.query([{ kinds: [9005], '#e': [eventId] }], stack.reader)).toHaveLength(0);
  });

  it('test 6c: an admin deleting an agent message in Mattermost removes it from the relay as the channel owner', async () => {
    const channel = await enabledChannel('p4-delete-agent');
    const root = await stack.post(alice, channel.id, 'another question');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const { eventId, post } = await agentReply(channel.id, rootEvent.id, root.id, 'an answer alice will remove');

    // Deleting others' posts takes a system or team admin in Team Edition (a channel creator may not).
    await admin.api.delete(`/posts/${post.id}`);
    const moderation = await waitFor(async () => (await stack.relay.query([{ kinds: [9005], '#e': [eventId] }], stack.reader))[0]);
    expect(moderation.pubkey).toBe(stack.bridgeSigner.pubkey);
    expect(await stack.relay.query([{ ids: [eventId] }], stack.reader)).toHaveLength(0);
  });

  it('reactions round-trip between Mattermost and the relay', async () => {
    const channel = await enabledChannel('p4-react');
    const relayChannelId = relayChannelIdFor(channel.id);
    const root = await stack.post(alice, channel.id, 'react to me');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const relayReactions = (): ReturnType<typeof stack.relay.query> => stack.relay.query([{ kinds: [7], '#e': [rootEvent.id] }], stack.reader);

    await bob.api.post('/reactions', { user_id: bob.user.id, post_id: root.id, emoji_name: '+1' });
    const like = await waitFor(async () => (await relayReactions()).find((event) => event.content === '👍'));
    expect(like.pubkey).toBe(await personKey(bob));
    expect(like.tags).toContainEqual(['p', rootEvent.pubkey]);

    // Two Mattermost names for one emoji are one relay reaction, which stays until both are gone.
    await bob.api.post('/reactions', { user_id: bob.user.id, post_id: root.id, emoji_name: 'thumbsup' });
    await bob.api.delete(`/users/${bob.user.id}/posts/${root.id}/reactions/+1`);
    await quiet(2000);
    expect((await relayReactions()).filter((event) => event.content === '👍')).toHaveLength(1);
    await bob.api.delete(`/users/${bob.user.id}/posts/${root.id}/reactions/thumbsup`);
    await waitFor(async () => (await relayReactions()).length === 0);

    const tada = agentSigner.sign({ kind: 7, tags: [['h', relayChannelId], ['e', rootEvent.id], ['p', rootEvent.pubkey]], content: '🎉', created_at: nowSeconds() });
    await stack.relay.publish(tada, agentSigner);
    await waitFor(async () => (await reactionsInMm(root.id)).some((reaction) => reaction.user_id === agent.mmBotUserId && reaction.emoji_name === 'tada'));
    await quiet(2000);
    // The agent's reaction in Mattermost is not mirrored back as another relay reaction.
    expect((await relayReactions()).filter((event) => event.content === '🎉')).toHaveLength(1);

    const undo = agentSigner.sign({ kind: 5, tags: [['h', relayChannelId], ['e', tada.id]], content: '', created_at: nowSeconds() });
    await stack.relay.publish(undo, agentSigner);
    await waitFor(async () => !(await reactionsInMm(root.id)).some((reaction) => reaction.user_id === agent.mmBotUserId));
  });

  it('renames, purpose and header changes, privacy changes, archive and restore follow Mattermost', async () => {
    const channel = await enabledChannel('p4-meta', 'P');
    await admin.api.put(`/channels/${channel.id}/patch`, { display_name: 'Renamed In MM', purpose: 'The purpose', header: 'The header' });
    await waitFor(async () => {
      const metadata = await stack.relayMetadata(channel.id);
      return metadata && tagValue(metadata, 'name') === 'Renamed In MM' && tagValue(metadata, 'about') === 'The purpose\n\nThe header';
    });

    await admin.api.put(`/channels/${channel.id}/privacy`, { privacy: 'O' });
    await waitFor(async () => (await stack.relayMetadata(channel.id))?.tags.some((tag) => tag[0] === 'public'));
    await admin.api.put(`/channels/${channel.id}/privacy`, { privacy: 'P' });
    await waitFor(async () => (await stack.relayMetadata(channel.id))?.tags.some((tag) => tag[0] === 'private'));

    await admin.api.delete(`/channels/${channel.id}`);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'archived');
    expect((await stack.relayMembers(channel.id)).has(stack.reader.pubkey)).toBe(false);
    expect((await stack.relayMetadata(channel.id))?.tags).toContainEqual(['archived', 'true']);

    await admin.api.post(`/channels/${channel.id}/restore`);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'active');
    expect((await stack.relayMembers(channel.id)).has(stack.reader.pubkey)).toBe(true);
    expect((await stack.relayMetadata(channel.id))?.tags).not.toContainEqual(['archived', 'true']);
    const after = await stack.post(alice, channel.id, 'mirrored again after the restore');
    await stack.waitForEventForPost(channel.id, after.id);
  });

  it('removing @brain pauses the channel: the reader leaves the relay channel and mirroring stops', async () => {
    const channel = await enabledChannel('p4-pause');
    await alice.api.delete(`/channels/${channel.id}/members/${await stack.botUserId()}`);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'paused');
    expect((await stack.relayMembers(channel.id)).has(stack.reader.pubkey)).toBe(false);
    const post = await stack.post(alice, channel.id, 'not mirrored while paused');
    await quiet(2000);
    expect(await stack.eventsForPost(channel.id, post.id, [9], stack.bridgeSigner)).toHaveLength(0);
  });

  it('reconciliation repairs private-channel membership changed while the bridge was down, within one interval', { timeout: 180_000 }, async () => {
    const channel = await enabledChannel('p4-reconcile', 'P');
    const bobKey = await personKey(bob);
    await waitFor(async () => (await stack.relayMembers(channel.id)).has(bobKey));

    await bridge.stop();
    await alice.api.delete(`/channels/${channel.id}/members/${bob.user.id}`);
    await alice.api.post(`/channels/${channel.id}/members`, { user_id: admin.user.id });
    const restarted = Date.now();
    bridge = await stack.startBridge();

    await waitFor(async () => !(await stack.relayMembers(channel.id)).has(bobKey), RECONCILE_INTERVAL_SECONDS * 1000);
    const adminKey = await personKey(admin);
    await waitFor(async () => (await stack.relayMembers(channel.id)).has(adminKey), RECONCILE_INTERVAL_SECONDS * 1000);
    expect(Date.now() - restarted).toBeLessThan(RECONCILE_INTERVAL_SECONDS * 1000);

    // bob's key can no longer read the private channel.
    const post = await stack.post(alice, channel.id, 'after bob left');
    await stack.waitForEventForPost(channel.id, post.id);
    const bobSigner = await stack.keyStore().signerFor(bobKey);
    expect(await stack.relay.query([{ kinds: [9], '#h': [relayChannelIdFor(channel.id)] }], bobSigner)).toHaveLength(0);
  });

  it('backfilled history is mirrored with its original time but never triggers agents', { timeout: 180_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'p4-backfill', [bob.user.id, agent.mmBotUserId]);
    const old = await stack.post(alice, channel.id, '@agent-a an old question from before the channel was enabled');
    const oldReply = await stack.post(bob, channel.id, 'an old reply', old.id);
    const runtime = await stack.startRuntime();
    try {
      await stack.enable(alice, channel.id);
      const event = await stack.waitForEventForPost(channel.id, old.id);
      expect(event.tags).toContainEqual(['backfill', '1']);
      expect(event.tags).toContainEqual(['p', agent.nostrPubkey]);
      expect(tagValue(event, 'mm_ts')).toBe(String(old.create_at));
      expect((await stack.waitForEventForPost(channel.id, oldReply.id)).tags).toContainEqual(['backfill', '1']);

      // A mention after enablement is answered, so the agent could have answered the old one.
      const live = await stack.post(alice, channel.id, '@agent-a a new question');
      await waitFor(async () => (await stack.thread(alice, live.id)).some((post) => post.user_id === agent.mmBotUserId), 60_000);
      await quiet(3000);
      expect((await stack.thread(alice, old.id)).filter((post) => post.user_id === agent.mmBotUserId)).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('attachments are mirrored as file names and the post permalink', async () => {
    const channel = await enabledChannel('p4-files');
    const fileId = await stack.uploadFile(alice, channel.id, 'report.txt', 'quarterly numbers');
    const post = await alice.api.post<MmPost>('/posts', { channel_id: channel.id, message: 'see attached', file_ids: [fileId] });
    const event = await stack.waitForEventForPost(channel.id, post.id);
    expect(event.content).toBe(`see attached\n\n📎 Attachments: report.txt (${stack.config.MM_URL}/${stack.env.MM_TEAM_NAME}/pl/${post.id})`);
  });
});
