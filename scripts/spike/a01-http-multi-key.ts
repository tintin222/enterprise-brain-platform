// A1: POST /events accepts a per-request NIP-98 header, so one process can publish as many keys.
import { nowSeconds } from '../lib/nostr.ts';
import { nip98Header } from '../lib/relay.ts';
import { accepted, chatMessage, connect, createChannel, newMember, resultMessage } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

export const a01: Spike = {
  id: 'A1',
  title: 'One process publishes as many keys via POST /events with per-request NIP-98',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'open');
    const authors = await Promise.all(Array.from({ length: 5 }, () => newMember(ctx)));
    const [first, second] = authors as [(typeof authors)[number], (typeof authors)[number]];

    const results = await Promise.all(authors.map((a, i) => ctx.relayHttp.publish(a, chatMessage(a, channel, `A1 message ${i}`))));
    r.check('5 keys publish kind 9 over HTTP from one process, no WebSocket', results.every(accepted), results.map(resultMessage).join('; '));

    const { events } = await ctx.relayHttp.query(ctx.reader, [{ kinds: [9], '#h': [channel] }]);
    const authorsSeen = new Set(events.map((e) => e.pubkey));
    r.check('each stored event carries its own author pubkey', authors.every((a) => authorsSeen.has(a.pubkey)), `${events.length} events from ${authorsSeen.size} authors`);

    const mismatch = await ctx.relayHttp.post('/events', chatMessage(second, channel, 'signed by one key, auth by another'), first);
    r.check('an auth key different from event.pubkey is rejected', !accepted(mismatch), resultMessage(mismatch));

    // Replay guard: each NIP-98 auth event is single-use.
    const url = `${ctx.relayHttp.baseUrl}/events`;
    const event = chatMessage(first, channel, 'replay test');
    const header = nip98Header(first, url, 'POST', JSON.stringify(event));
    const once = await ctx.relayHttp.post('/events', event, null, { Authorization: header });
    const twice = await ctx.relayHttp.post('/events', event, null, { Authorization: header });
    r.check('a reused NIP-98 header is rejected', accepted(once) && twice.status === 401, `first ${resultMessage(once)}; reuse ${resultMessage(twice)}`);

    // Without a nonce, two auth headers for the same body in the same second are identical events.
    const retry = chatMessage(first, channel, 'same-second retry');
    const body = JSON.stringify(retry);
    const createdAt = nowSeconds();
    const h1 = nip98Header(first, url, 'POST', body, { nonce: false, createdAt });
    const h2 = nip98Header(first, url, 'POST', body, { nonce: false, createdAt });
    // Schnorr signatures differ (random aux data) but the event id, which the replay guard keys on, does not.
    const authId = (header: string): string => (JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString()) as { id: string }).id;
    await ctx.relayHttp.post('/events', retry, null, { Authorization: h1 });
    const collided = await ctx.relayHttp.post('/events', retry, null, { Authorization: h2 });
    r.check('without a nonce tag, a same-second retry hits the replay guard', authId(h1) === authId(h2) && collided.status === 401, `same auth event id: ${authId(h1) === authId(h2)}; ${resultMessage(collided)}`);
    const withNonce = await ctx.relayHttp.publish(first, retry);
    r.check('with a nonce tag the same retry goes through (reported as a duplicate)', accepted(withNonce), resultMessage(withNonce));

    // HTTP rate limit, measured on a throwaway key with cheap /count calls. The limit is a fixed
    // 60 s window per key, so a window boundary can push the first 429 past limit + 1.
    const httpLimit = Number(ctx.env.BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN ?? 300);
    const burst = await newMember(ctx);
    const started = Date.now();
    let limitedAt = -1;
    let limitedBody: unknown;
    for (let i = 1; i <= 2 * httpLimit; i++) {
      const res = await ctx.relayHttp.post('/count', [{ kinds: [9], '#h': [channel] }], burst);
      if (res.status === 429) {
        limitedAt = i;
        limitedBody = res.body;
        break;
      }
    }
    r.check(`HTTP calls are rate-limited per key at the configured ${httpLimit} per minute`, limitedAt > httpLimit && limitedAt <= 2 * httpLimit, limitedAt > 0 ? `429 on call ${limitedAt} after ${Date.now() - started} ms: ${JSON.stringify(limitedBody)}` : `no 429 within ${2 * httpLimit} calls`);
    const other = await ctx.relayHttp.publish(second, chatMessage(second, channel, 'other key while one is limited'));
    r.check('other keys are unaffected while one key is limited', accepted(other), resultMessage(other));

    // WebSocket rate limit: REQ frames per key over a 5 s window, sent as one burst.
    const wsPerSecond = Number(ctx.env.BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC ?? 10);
    const wsWindow = wsPerSecond * 5;
    const socket = await connect(ctx, await newMember(ctx));
    const from = socket.frames.length;
    for (let i = 1; i <= wsWindow + 30; i++) socket.send(['REQ', `b${i}`, { kinds: [9], '#h': [channel], limit: 1 }]);
    await socket.waitFor((f) => f[1] === `b${wsWindow + 30}` && (f[0] === 'EOSE' || f[0] === 'CLOSED'), 15_000, from).catch(() => undefined);
    const firstLimited = socket
      .incoming(from)
      .filter((f) => f[0] === 'CLOSED' && String(f[2]).startsWith('rate-limited'))
      .map((f) => Number(String(f[1]).slice(1)))
      .sort((a, b) => a - b)[0];
    r.check(`WebSocket frames are rate-limited per key at the configured ${wsPerSecond} per second (${wsWindow} per 5 s)`, firstLimited !== undefined && firstLimited > wsWindow && firstLimited <= 2 * wsWindow, firstLimited ? `first rate-limited REQ: #${firstLimited}` : 'no REQ was rate-limited');
    socket.close();
  },
};
