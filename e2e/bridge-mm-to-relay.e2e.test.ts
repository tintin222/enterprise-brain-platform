// Phase 1 acceptance: bridge-spec tests 1, 2, 4, 5, 7 and 8 (docs/bridge-spec.md section 11).
import type { Bridge } from '@brain/bridge';
import type { ChatEvent } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

describe('bridge: Mattermost -> relay', () => {
  let stack: Stack;
  let bridge: Bridge;
  let alice: MmSession;
  let bob: MmSession;

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    bridge = await stack.startBridge();
  });

  afterAll(async () => {
    await bridge?.stop();
    await stack?.close();
  });

  it('test 1: a post in an enabled channel becomes exactly one relay event, signed by its author, in the mapped channel', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p1-t1', [bob.user.id]);
    await stack.enable(alice, channel.id);
    const post = await stack.post(alice, channel.id, 'hello relay, @bob');

    const event = await stack.waitForEventForPost(channel.id, post.id);
    const mapping = await stack.store.getChannel(channel.id);
    const aliceIdentity = await stack.identities.get(alice.user.id);
    const bobIdentity = await stack.identities.get(bob.user.id);
    expect(event.pubkey).toBe(aliceIdentity?.pubkey);
    expect(event.tags).toContainEqual(['h', mapping?.relayChannelId]);
    expect(event.tags).toContainEqual(['p', bobIdentity?.pubkey]);
    expect(event.content).toBe('hello relay, @bob');

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await stack.eventsForPost(channel.id, post.id)).toHaveLength(1);
  });

  it('test 2: a thread reply arrives with the correct parent reference', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p1-t2', [bob.user.id]);
    await stack.enable(alice, channel.id);
    const root = await stack.post(alice, channel.id, 'thread root');
    const reply = await stack.post(bob, channel.id, 'a reply', root.id);

    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const replyEvent = await stack.waitForEventForPost(channel.id, reply.id);
    expect(replyEvent.tags).toContainEqual(['e', rootEvent.id, '', 'reply']);
    expect(replyEvent.pubkey).toBe((await stack.identities.get(bob.user.id))?.pubkey);
  });

  it('test 5: handling the same Mattermost event twice gives one relay event', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p1-t5');
    await stack.enable(alice, channel.id);
    const post = await stack.post(alice, channel.id, 'replayed event');
    await stack.waitForEventForPost(channel.id, post.id);

    const event: ChatEvent = { event: 'posted', data: { post: JSON.stringify(post), channel_type: 'O' }, broadcast: { channel_id: channel.id }, seq: 0 };
    await Promise.all([bridge.handleEvent(event), bridge.handleEvent(event)]);
    await bridge.handleEvent(event);
    expect(await stack.eventsForPost(channel.id, post.id)).toHaveLength(1);
  });

  it('test 7: a post in a channel without @brain produces no relay event', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p1-t7', [bob.user.id]);
    const post = await stack.post(alice, channel.id, 'nobody is mirroring this');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(await stack.store.getChannel(channel.id)).toBeUndefined();
    expect(await stack.eventsForPost(channel.id, post.id)).toHaveLength(0);
  });

  it('test 8: a private channel cannot be read by a key that is not a member', async () => {
    const channel = await stack.createChannel(alice, 'P', 'p1-t8');
    await stack.enable(alice, channel.id);
    const post = await stack.post(alice, channel.id, 'private text');
    await stack.waitForEventForPost(channel.id, post.id);

    const mapping = await stack.store.getChannel(channel.id);
    expect(mapping?.visibility).toBe('private');
    const [metadata] = await stack.relay.query([{ kinds: [39000], '#d': [mapping!.relayChannelId] }], stack.reader);
    expect(metadata?.tags).toContainEqual(['private']);

    const outsider = await stack.outsider();
    expect(await stack.eventsForPost(channel.id, post.id, [9], outsider)).toHaveLength(0);
    expect(await stack.relay.query([{ kinds: [9], '#h': [mapping!.relayChannelId] }], outsider)).toHaveLength(0);
  });

  it('test 4: restarting the bridge mid-stream loses nothing and duplicates nothing', async () => {
    const channel = await stack.createChannel(alice, 'O', 'p1-t4', [bob.user.id]);
    await stack.enable(alice, channel.id);
    const before = [await stack.post(alice, channel.id, 'before restart 1'), await stack.post(bob, channel.id, 'before restart 2')];
    for (const post of before) await stack.waitForEventForPost(channel.id, post.id);

    await bridge.stop();
    const root = await stack.post(alice, channel.id, 'while stopped 1');
    const during = [root, await stack.post(bob, channel.id, 'while stopped 2'), await stack.post(bob, channel.id, 'reply while stopped', root.id)];
    bridge = await stack.startBridge();
    const after = [await stack.post(alice, channel.id, 'after restart')];

    const all = [...before, ...during, ...after];
    for (const post of all) await stack.waitForEventForPost(channel.id, post.id);
    // Run both catch-ups over the same posts again: still no duplicates.
    await bridge.catchUpAll();
    await bridge.relayCatchUp();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const post of all) expect(await stack.eventsForPost(channel.id, post.id), post.message).toHaveLength(1);

    const replyEvent = (await stack.eventsForPost(channel.id, during[2]!.id))[0];
    const rootEvent = (await stack.eventsForPost(channel.id, root.id))[0];
    expect(replyEvent?.tags).toContainEqual(['e', rootEvent?.id, '', 'reply']);
    await waitFor(async () => (await stack.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM bridge.relay_outbox')).rows[0]?.n === 0);
  });
});
