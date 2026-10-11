// Phase 0 acceptance: a script publishes a chat event to the relay as key A and reads it back as key B.
import { nowSeconds } from '../lib/nostr.ts';
import { accepted, addToChannelOk, chatMessage, connect, createChannel, newMember, resultMessage } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

export const acceptanceRelay: Spike = {
  id: 'acceptance-relay',
  title: 'Publish a chat event as key A, read it back as key B',
  kind: 'acceptance',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'private');
    const keyA = await newMember(ctx);
    const keyB = await newMember(ctx);
    const keyC = await newMember(ctx);
    await addToChannelOk(ctx, ctx.bridge, channel, keyA.pubkey);
    await addToChannelOk(ctx, ctx.bridge, channel, keyB.pubkey);
    r.record('channel', channel);

    const socketB = await connect(ctx, keyB);
    const sub = await socketB.subscribe('acceptance', [{ kinds: [9], '#h': [channel], since: nowSeconds() - 5 }]);

    const event = chatMessage(keyA, channel, `acceptance ${ctx.runId}`);
    const published = await ctx.relayHttp.publish(keyA, event);
    r.check('key A publishes a kind 9 chat event over HTTP with NIP-98', accepted(published), resultMessage(published));

    const live = await socketB.waitForEvent('acceptance', (e) => e.id === event.id, 5000, sub.from).catch(() => undefined);
    r.check('key B receives it live over WebSocket after NIP-42 auth', live?.pubkey === keyA.pubkey && live.content === event.content);

    const stored = await ctx.relayHttp.query(keyB, [{ ids: [event.id] }]);
    r.check('key B reads it back with an HTTP query', stored.events.some((e) => e.id === event.id && e.sig === event.sig));

    const outsider = await ctx.relayHttp.query(keyC, [{ kinds: [9], '#h': [channel] }]);
    r.check('key C, a relay member outside the private channel, cannot read it', !outsider.events.some((e) => e.id === event.id), `${outsider.events.length} events visible to C`);
    socketB.close();
  },
};
