// A3: a mention is a ["p", pubkey] tag on kind 9; how mentions are written and delivered.
import { nowSeconds, type Event } from '../lib/nostr.ts';
import { addToChannelOk, chatMessage, connect, createChannel, newMember, publishOk } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a03: Spike = {
  id: 'A3',
  title: 'Mentions are p tags on kind 9; delivery to a reader',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'private');
    const person = await newMember(ctx);
    const agent = await newMember(ctx);
    for (const pubkey of [person.pubkey, agent.pubkey, ctx.reader.pubkey]) await addToChannelOk(ctx, ctx.bridge, channel, pubkey);

    const reader = await connect(ctx, ctx.reader);
    const perChannel = await reader.subscribe('per-channel', [{ kinds: [9], '#h': [channel], since: nowSeconds() - 5 }]);
    const byMention = await reader.subscribe('by-mention', [{ kinds: [9], '#p': [agent.pubkey], since: nowSeconds() - 5 }]);

    const mention = chatMessage(person, channel, '@Finance Bot what did we decide on Q3 pricing?', [['p', agent.pubkey]]);
    await publishOk(ctx, person, mention);

    const live = await reader.waitForEvent('per-channel', (e) => e.id === mention.id, 5000, perChannel.from).catch(() => undefined);
    r.check('kind 9 with ["p", agent] is accepted and delivered live to a per-channel #h subscription', live !== undefined, live ? shortJson(live.tags) : 'not delivered');
    r.check('the p tag arrives intact, so the dispatcher can match mentioned agents', live?.tags.some((t) => t[0] === 'p' && t[1] === agent.pubkey) === true);

    const viaP = await reader.waitForEvent('by-mention', (e) => e.id === mention.id, 3000, byMention.from).catch(() => undefined);
    r.check('a live subscription by #p alone (no #h) does not receive channel messages', viaP === undefined, viaP ? 'delivered' : 'not delivered within 3 s');

    const history = await ctx.relayHttp.query(ctx.reader, [{ kinds: [9], '#p': [agent.pubkey] }]);
    const stored = history.events.find((e) => e.id === mention.id);
    r.check('a historical query by #p finds the mention', stored !== undefined, `${history.events.length} events`);
    r.check('content is stored as sent; the relay does not rewrite mentions', stored?.content === mention.content, JSON.stringify(stored?.content));

    const feed = await ctx.relayHttp.post('/query', [{ feed_types: ['mentions'], limit: 20 }], agent);
    const feedEvents = Array.isArray(feed.body) ? (feed.body as Event[]) : [];
    r.note(`/query with feed_types ["mentions"] as the agent: HTTP ${feed.status}, ${feedEvents.some((e) => e.id === mention.id) ? 'includes' : 'does not include'} the mention`);
    r.note('Buzz desktop writes a mention as plain "@DisplayName" in content plus one ["p", hex] tag per mentioned member (desktop/src/features/messages/lib/useMentions.ts and desktop/src-tauri/src/events.rs at relay-v0.2.1).');
    reader.close();
  },
};
