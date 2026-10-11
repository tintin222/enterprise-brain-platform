// A4: exact shape of the kind 40003 edit and the kind 40002 rich-content events.
import { nowSeconds, sign } from '../lib/nostr.ts';
import { accepted, chatMessage, connect, createChannel, newMember, publishOk, resultMessage } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

export const a04: Spike = {
  id: 'A4',
  title: 'Kind 40003 edit and kind 40002 rich content',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'open');
    const author = await newMember(ctx);
    const other = await newMember(ctx);
    const original = await publishOk(ctx, author, chatMessage(author, channel, 'original text'));

    const edit = sign(author, 40003, [['h', channel], ['e', original.id]], 'edited text');
    const res = await ctx.relayHttp.publish(author, edit);
    r.check('40003 with ["h", channel], ["e", target] and the new text as content is accepted', accepted(res), resultMessage(res));

    const q = await ctx.relayHttp.query(ctx.reader, [{ ids: [original.id] }, { kinds: [40003], '#e': [original.id] }]);
    const storedOriginal = q.events.find((e) => e.id === original.id);
    const storedEdit = q.events.find((e) => e.id === edit.id);
    r.check('the edit is stored as a separate event and the original is unchanged', storedOriginal?.content === 'original text' && storedEdit?.content === 'edited text', `original "${storedOriginal?.content}", edit "${storedEdit?.content}"`);
    r.check('edits of a message are found with {kinds:[40003], #e:[id]}', storedEdit !== undefined);

    const foreign = await ctx.relayHttp.publish(other, sign(other, 40003, [['h', channel], ['e', original.id]], 'not mine'));
    r.check('an edit by a key other than the author is rejected', !accepted(foreign), resultMessage(foreign));

    const otherChannel = await createChannel(ctx, ctx.bridge, 'open');
    const cross = await ctx.relayHttp.publish(author, sign(author, 40003, [['h', otherChannel], ['e', original.id]], 'wrong channel'));
    r.check('an edit whose h tag names another channel than its target is rejected', !accepted(cross), resultMessage(cross));

    const noH = await ctx.relayHttp.publish(author, sign(author, 40003, [['e', original.id]], 'no h tag'));
    r.note(`40003 without an h tag: ${resultMessage(noH)}`);

    const rich = sign(author, 40002, [['h', channel]], JSON.stringify({ blocks: [{ type: 'text', text: 'hi' }] }));
    const richRes = await ctx.relayHttp.publish(author, rich);
    r.check('40002 with an h tag is accepted; no content schema is enforced', accepted(richRes), resultMessage(richRes));

    const socket = await connect(ctx, ctx.reader);
    const sub = await socket.subscribe('edits', [{ kinds: [9, 40003], '#h': [channel], since: nowSeconds() }]);
    const edit2 = await publishOk(ctx, author, sign(author, 40003, [['h', channel], ['e', original.id]], 'edited again'));
    const live = await socket.waitForEvent('edits', (e) => e.id === edit2.id, 5000, sub.from).catch(() => undefined);
    r.check('edits are delivered live on the channel subscription', live !== undefined);
    socket.close();
  },
};
