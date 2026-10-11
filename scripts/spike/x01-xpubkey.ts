// X1 (found while reading the relay source; not in the A1..A12 list): the HTTP API's X-Pubkey dev
// fallback must not let an unauthenticated caller read as another key.
import type { Event } from '../lib/nostr.ts';
import { addToChannelOk, chatMessage, createChannel, newMember, publishOk } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

export const x01: Spike = {
  id: 'X1',
  title: 'HTTP X-Pubkey header cannot be used to read as another key',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'private');
    const member = await newMember(ctx);
    await addToChannelOk(ctx, ctx.bridge, channel, member.pubkey);
    const secret = await publishOk(ctx, member, chatMessage(member, channel, 'private channel text'));

    const res = await ctx.relayHttp.post('/query', [{ kinds: [9], '#h': [channel] }], null, { 'X-Pubkey': member.pubkey });
    const leaked = Array.isArray(res.body) && (res.body as Event[]).some((e) => e.id === secret.id);
    r.check('an unauthenticated /query claiming a member pubkey in X-Pubkey is refused', !leaked && res.status === 401, `HTTP ${res.status}; ${leaked ? 'PRIVATE CHANNEL EVENT RETURNED' : 'nothing returned'}`);
  },
};
