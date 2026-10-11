// A6: the bridge key adds relay members (kind 9030, as relay owner) and channel members (kind 9000,
// as channel owner), including agent keys; channel_add_policy; how membership changes are observed.
import { newIdentity, nowSeconds, sign } from '../lib/nostr.ts';
import { canAuthenticate, ensureRelayMember, listRelayMembers } from '../lib/relay-admin.ts';
import { accepted, addToChannel, addToChannelOk, chatMessage, connect, createChannel, newMember, publishOk, resultMessage } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a06: Spike = {
  id: 'A6',
  title: 'Bridge key adds relay members (9030) and channel members (9000), incl. agents',
  kind: 'assumption',
  async run(ctx, r) {
    const { env, bridge } = ctx;

    // --- Relay membership ---
    const stranger = newIdentity();
    r.check('a key that is not a relay member cannot authenticate', !(await canAuthenticate(env, stranger)));
    await ensureRelayMember(env, bridge, stranger.pubkey);
    r.check('after a 9030 signed by the bridge (relay owner) the key can authenticate', await canAuthenticate(env, stranger));

    const plain = await newMember(ctx);
    const denied = await ctx.relayHttp.publish(plain, sign(plain, 9030, [['p', newIdentity().pubkey]]));
    r.check('a plain relay member cannot add relay members', !accepted(denied), resultMessage(denied));

    const concurrent = Array.from({ length: 10 }, () => newIdentity());
    await Promise.all(concurrent.map((id) => ensureRelayMember(env, bridge, id.pubkey)));
    const authResults = await Promise.all(concurrent.map((id) => canAuthenticate(env, id)));
    const roster = await listRelayMembers(env, bridge);
    r.check('10 concurrent 9030 adds: every key can authenticate', authResults.every(Boolean), `${authResults.filter(Boolean).length}/10`);
    r.check('10 concurrent 9030 adds: the latest 13534 roster lists every key', concurrent.every((id) => roster.has(id.pubkey)), `${concurrent.filter((id) => roster.has(id.pubkey)).length}/10 present, roster size ${roster.size}`);

    // --- Channel membership in a private channel owned by the bridge ---
    const channel = await createChannel(ctx, bridge, 'private');
    const person = await newMember(ctx);
    const agent = await newMember(ctx); // never publishes kind 10100
    const addPerson = await addToChannel(ctx, bridge, channel, person.pubkey);
    const addAgent = await addToChannel(ctx, bridge, channel, agent.pubkey);
    r.check('the channel owner adds a person key to a private channel', accepted(addPerson), resultMessage(addPerson));
    r.check('the channel owner adds an agent key that never published kind 10100', accepted(addAgent), resultMessage(addAgent));

    const members = await ctx.relayHttp.query(bridge, [{ kinds: [39002], '#d': [channel] }]);
    const listed = members.events[0]?.tags.filter((t) => t[0] === 'p').map((t) => t[1]) ?? [];
    r.check('kind 39002 lists the added members', [person.pubkey, agent.pubkey].every((pk) => listed.includes(pk)), shortJson(members.events[0]?.tags));

    const byMember = await addToChannel(ctx, person, channel, (await newMember(ctx)).pubkey);
    r.check('a plain channel member cannot add others to a private channel', !accepted(byMember), resultMessage(byMember));

    const notMember = newIdentity();
    const addNonRelayMember = await addToChannel(ctx, bridge, channel, notMember.pubkey);
    r.note(`adding a key that is not a relay member to a channel: ${resultMessage(addNonRelayMember)}`);

    // --- channel_add_policy (kind 10100, published by the target) ---
    const guarded = await newMember(ctx);
    await publishOk(ctx, guarded, sign(guarded, 10100, [], JSON.stringify({ channel_add_policy: 'nobody' })));
    const blocked = await addToChannel(ctx, bridge, channel, guarded.pubkey);
    r.check('a key whose channel_add_policy is "nobody" cannot be added', !accepted(blocked), resultMessage(blocked));
    await publishOk(ctx, guarded, sign(guarded, 10100, [], JSON.stringify({ channel_add_policy: 'anyone' }), nowSeconds() + 1));
    const allowed = await addToChannel(ctx, bridge, channel, guarded.pubkey);
    r.check('after the key switches its policy to "anyone" the add succeeds', accepted(allowed), resultMessage(allowed));

    // --- Observing membership changes as the reader ---
    await addToChannelOk(ctx, bridge, channel, ctx.reader.pubkey);
    const watcher = await connect(ctx, ctx.reader);
    const roster39002 = await watcher.subscribe('roster', [{ kinds: [39002], '#h': [channel], since: nowSeconds() }]);
    const ownNotices = await watcher.subscribe('own-44100', [{ kinds: [44100, 44101], '#p': [ctx.reader.pubkey], since: nowSeconds() }]);
    const late = await newMember(ctx);
    await addToChannelOk(ctx, bridge, channel, late.pubkey);
    const live39002 = await watcher.waitForEvent('roster', (e) => e.tags.some((t) => t[0] === 'p' && t[1] === late.pubkey), 5000, roster39002.from).catch(() => undefined);
    r.check('a reader subscribed with #h sees the updated 39002 live when an agent is added', live39002 !== undefined);

    const second = await createChannel(ctx, bridge, 'private');
    await addToChannelOk(ctx, bridge, second, ctx.reader.pubkey);
    const own = await watcher.waitForEvent('own-44100', (e) => e.tags.some((t) => t[0] === 'h' && t[1] === second), 5000, ownNotices.from).catch(() => undefined);
    r.check('the reader receives a 44100 when it is itself added to a channel', own !== undefined, own ? shortJson({ tags: own.tags, content: own.content }) : 'not received');
    const spy = await watcher.subscribe('spy', [{ kinds: [44100, 44101], '#p': [agent.pubkey] }]);
    r.check("the reader cannot subscribe to another key's 44100/44101", spy.end[0] === 'CLOSED', shortJson(spy.end));

    // --- Removal (9031) and already-open sockets ---
    const removable = await newMember(ctx);
    const openSocket = await connect(ctx, removable);
    await publishOk(ctx, bridge, sign(bridge, 9031, [['p', removable.pubkey]]));
    const openChannel = await createChannel(ctx, bridge, 'open');
    const stillOpen = await openSocket.publish(chatMessage(removable, openChannel, 'sent after my relay membership was removed')).catch((e: unknown) => ({ accepted: false, message: String(e) }));
    r.note(`after 9031 removed it, the key's already-open socket could ${stillOpen.accepted ? 'STILL PUBLISH' : `not publish (${stillOpen.message})`}`);
    r.check('after 9031 a new connection by the removed key is refused', !(await canAuthenticate(env, removable)));
    openSocket.close();
    watcher.close();
  },
};
