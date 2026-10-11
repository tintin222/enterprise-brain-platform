// A2: kind 9007 creates a channel; how the UUID is chosen and learned; visibility values; ownership.
import { sign } from '../lib/nostr.ts';
import { accepted, newChannelId, resultMessage, uniqueName } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a02: Spike = {
  id: 'A2',
  title: 'Kind 9007 channel creation: UUID, visibility, ownership',
  kind: 'assumption',
  async run(ctx, r) {
    const bridge = ctx.bridge;

    // Without an h tag the relay picks the UUID.
    const autoName = uniqueName(ctx, 'a2-auto');
    const auto = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['name', autoName], ['visibility', 'open']]));
    const groups = await ctx.relayHttp.query(bridge, [{ kinds: [39000], limit: 1000 }]);
    const autoMeta = groups.events.find((e) => e.tags.some((t) => t[0] === 'name' && t[1] === autoName));
    const autoId = autoMeta?.tags.find((t) => t[0] === 'd')?.[1];
    r.check('without an h tag the channel is created, but the response does not contain its UUID', accepted(auto) && autoId !== undefined && !JSON.stringify(auto.body).includes(autoId), resultMessage(auto));
    r.check('the relay-generated UUID can be found in kind 39000 by name', autoId !== undefined, autoId ?? 'not found');
    const notices = await ctx.relayHttp.query(bridge, [{ kinds: [44100], '#p': [bridge.pubkey], limit: 20 }]);
    const notice = notices.events.find((e) => e.tags.some((t) => t[0] === 'h' && t[1] === autoId));
    r.check('the creator also receives a 44100 naming the new channel', notice !== undefined, notice ? shortJson({ tags: notice.tags, content: notice.content }) : 'none');

    // A client-chosen UUID.
    const chosen = newChannelId();
    const created = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['h', chosen], ['name', uniqueName(ctx, 'a2-chosen')], ['visibility', 'private'], ['about', 'chosen id']]));
    const chosenMeta = await ctx.relayHttp.query(bridge, [{ kinds: [39000], '#d': [chosen] }]);
    r.check('a UUID supplied in an h tag becomes the channel id', accepted(created) && chosenMeta.events.length === 1, `${resultMessage(created)}; 39000 found: ${chosenMeta.events.length}`);
    r.record('privateChannel39000', chosenMeta.events[0]);

    const again = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['h', chosen], ['name', 'again'], ['visibility', 'private']]));
    r.check('creating the same UUID again is refused as a duplicate, so creation can be retried safely', !accepted(again) && resultMessage(again).includes('duplicate'), resultMessage(again));

    const privateTags = chosenMeta.events[0]?.tags ?? [];
    const openTags = autoMeta?.tags ?? [];
    r.check('visibility "private" shows as a private tag in 39000', privateTags.some((t) => t[0] === 'private'), shortJson(privateTags));
    r.check('visibility "open" shows as a public tag in 39000', openTags.some((t) => t[0] === 'public') && !openTags.some((t) => t[0] === 'private'), shortJson(openTags));

    const invalid = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['h', newChannelId()], ['name', 'bad'], ['visibility', 'secret']]));
    r.check('an unknown visibility value is rejected', !accepted(invalid), resultMessage(invalid));

    const admins = await ctx.relayHttp.query(bridge, [{ kinds: [39001], '#d': [chosen] }]);
    const ownerTag = admins.events[0]?.tags.find((t) => t[0] === 'p' && t[1] === bridge.pubkey);
    r.check('the signer becomes the channel owner (39001)', ownerTag?.[2] === 'owner', shortJson(admins.events[0]?.tags));

    const sameName = uniqueName(ctx, 'a2-same-name');
    const n1 = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['h', newChannelId()], ['name', sameName]]));
    const n2 = await ctx.relayHttp.publish(bridge, sign(bridge, 9007, [['h', newChannelId()], ['name', sameName]]));
    r.note(`two channels with the same name: first ${resultMessage(n1)}, second ${resultMessage(n2)}`);
  },
};
