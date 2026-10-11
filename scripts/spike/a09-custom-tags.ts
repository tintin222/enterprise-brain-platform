// A9: extra custom tags on kind 9 events are accepted and preserved.
import { sign } from '../lib/nostr.ts';
import { accepted, createChannel, newMember, resultMessage } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a09: Spike = {
  id: 'A9',
  title: 'Custom tags on kind 9 are accepted and preserved',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'open');
    const author = await newMember(ctx);
    const tags = [['h', channel], ['mm', 'k3j4h5g6f7d8s9a0p1o2i3u4y5'], ['mm_ts', '1791750000123'], ['x-custom', 'a', 'b', 'c']];
    const event = sign(author, 9, tags, 'message with provenance tags');
    const res = await ctx.relayHttp.publish(author, event);
    r.check('kind 9 with custom tags is accepted', accepted(res), resultMessage(res));

    const q = await ctx.relayHttp.query(ctx.reader, [{ ids: [event.id] }]);
    r.check('the custom tags come back unchanged and in order', JSON.stringify(q.events[0]?.tags) === JSON.stringify(tags), shortJson(q.events[0]?.tags));

    // A filter value that no event carries: a relay that applies the filter returns nothing.
    const byTag = await ctx.relayHttp.query(ctx.reader, [{ kinds: [9], '#h': [channel], '#mm': ['no-event-has-this-value'] }]);
    r.note(`a "#mm" filter with a value no event carries returned ${byTag.events.length} event(s): ${byTag.events.length > 0 ? 'the relay ignores multi-letter tag filters' : 'the relay applies multi-letter tag filters'} (NIP-01 only defines single-letter ones)`);
  },
};
