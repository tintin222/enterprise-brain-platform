// A7: one filter listing many channels in #h; behaviour at the subscription and historical-result
// limits; paging with until.
import { setTimeout as sleep } from 'node:timers/promises';
import { nowSeconds, type Event } from '../lib/nostr.ts';
import type { RelaySocket } from '../lib/relay.ts';
import { chatMessage, connect, createChannel, newMember, publishOk } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

const BULK = 1050;

function liveCount(socket: RelaySocket, subId: string, from: number, ids: Set<string>): number {
  return socket.incoming(from).filter((f) => f[0] === 'EVENT' && f[1] === subId && ids.has((f[2] as Event).id)).length;
}

export const a07: Spike = {
  id: 'A7',
  title: 'Multi-channel filters, subscription and result limits, paging',
  kind: 'assumption',
  async run(ctx, r) {
    const channels = [await createChannel(ctx, ctx.bridge, 'open'), await createChannel(ctx, ctx.bridge, 'open'), await createChannel(ctx, ctx.bridge, 'open')];
    const author = await newMember(ctx);
    const reader = await connect(ctx, ctx.reader);

    for (const ch of channels) await publishOk(ctx, author, chatMessage(author, ch, `history in ${ch}`));
    const history = await reader.query('history', [{ kinds: [9], '#h': channels }]);
    const coveredHistory = channels.filter((ch) => history.events.some((e) => e.tags.some((t) => t[0] === 'h' && t[1] === ch)));
    r.check('one filter naming 3 channels in #h returns stored events from all of them', coveredHistory.length === 3, `${history.events.length} events from ${coveredHistory.length}/3 channels`);

    const since = nowSeconds();
    const multi = await reader.subscribe('multi', [{ kinds: [9], '#h': channels, since }]);
    const single = await Promise.all(channels.map((ch, i) => reader.subscribe(`single-${i}`, [{ kinds: [9], '#h': [ch], since }])));
    const twoFilters = await reader.subscribe('two-filters', [{ kinds: [9], '#h': [channels[0]!], since }, { kinds: [9], '#h': [channels[1]!], since }]);
    const live = new Set<string>();
    for (const ch of channels) live.add((await publishOk(ctx, author, chatMessage(author, ch, `live in ${ch}`))).id);
    await sleep(2000);
    const multiGot = liveCount(reader, 'multi', multi.from, live);
    const singleGot = single.map((s, i) => liveCount(reader, `single-${i}`, s.from, live));
    const twoGot = liveCount(reader, 'two-filters', twoFilters.from, live);
    r.check('one live subscription naming 3 channels in #h receives new events', multiGot === 3, `${multiGot}/3 live events received`);
    r.check('one live subscription per channel receives new events', singleGot.every((n) => n === 1), `per channel: ${singleGot.join(', ')}`);
    r.note(`a REQ with two filters, each naming a different channel, received ${twoGot}/2 live events`);

    const info = (await (await fetch(ctx.relayHttp.baseUrl, { headers: { Accept: 'application/nostr+json' } })).json()) as { limitation?: unknown };
    r.record('nip11Limitation', info.limitation);
    r.note(`NIP-11 limitation: ${shortJson(info.limitation, 400)}`);

    const marker = reader.frames.length;
    reader.send(['REQ', 'eleven', ...Array.from({ length: 11 }, () => ({ kinds: [9], '#h': [channels[0]!] }))]);
    const eleven = await reader.waitFor((f) => f[0] === 'NOTICE' || ((f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === 'eleven'), 5000, marker).catch(() => null);
    r.note(`REQ with 11 filters: ${shortJson(eleven)}`);

    // Historical cap and paging: 1,050 events in one channel from 6 authors (HTTP limit is per key).
    const big = await createChannel(ctx, ctx.bridge, 'open');
    const writers = await Promise.all(Array.from({ length: 6 }, () => newMember(ctx)));
    const perWriter = Math.ceil(BULK / writers.length);
    await Promise.all(
      writers.map(async (writer, w) => {
        for (let i = 0; i < perWriter; i++) await publishOk(ctx, writer, chatMessage(writer, big, `bulk ${w}-${i}`));
      }),
    );
    const total = perWriter * writers.length;
    const capped = await reader.query('capped', [{ kinds: [9], '#h': [big], limit: 5000 }], 60_000);
    const unlimited = await reader.query('no-limit', [{ kinds: [9], '#h': [big] }], 60_000);
    const distinctSeconds = new Set(capped.events.map((e) => e.created_at)).size;
    r.check('historical results per filter are capped', capped.events.length < total, `${capped.events.length} of ${total} returned for limit 5000; ${unlimited.events.length} with no limit`);
    r.record('historicalCap', { requested: 5000, returned: capped.events.length, noLimit: unlimited.events.length, distinctSecondsInPage: distinctSeconds });

    // Paging by created_at with until (inclusive) over WebSocket.
    const seen = new Set<string>();
    let until: number | undefined;
    let pages = 0;
    let repeats = 0;
    for (;;) {
      const page = await reader.query(`page-${pages}`, [{ kinds: [9], '#h': [big], limit: 200, ...(until === undefined ? {} : { until }) }], 30_000);
      pages++;
      let fresh = 0;
      for (const e of page.events) {
        if (seen.has(e.id)) repeats++;
        else {
          seen.add(e.id);
          fresh++;
        }
      }
      if (page.events.length === 0 || fresh === 0 || pages >= 30) break;
      until = Math.min(...page.events.map((e) => e.created_at));
      await sleep(150);
    }
    r.check('paging with until (inclusive) over WebSocket reaches every event', seen.size === total, `${seen.size}/${total} unique in ${pages} pages, ${repeats} repeats`);

    // Paging over HTTP /query with the relay's until + before_id extension.
    const seenHttp = new Set<string>();
    let cursor: { until: number; before_id: string } | undefined;
    let httpPages = 0;
    for (;;) {
      const res = await ctx.relayHttp.post('/query', [{ kinds: [9], '#h': [big], limit: 200, ...(cursor ?? {}) }], ctx.reader);
      const events = Array.isArray(res.body) ? (res.body as Event[]) : [];
      httpPages++;
      const fresh = events.filter((e) => !seenHttp.has(e.id));
      for (const e of fresh) seenHttp.add(e.id);
      const last = events.at(-1);
      if (!last || fresh.length === 0 || httpPages >= 30) break;
      cursor = { until: last.created_at, before_id: last.id };
    }
    r.check('paging over HTTP /query with until + before_id reaches every event', seenHttp.size === total, `${seenHttp.size}/${total} unique in ${httpPages} pages`);

    // Subscriptions per connection, paced under the WebSocket rate limit (50 frames per 5 s).
    const subsKey = await newMember(ctx);
    const subs = await connect(ctx, subsKey);
    let refusedAt = -1;
    let refusal: unknown;
    let rateLimited = 0;
    for (let i = 1; i <= 1030; i++) {
      const res = await subs.subscribe(`s${i}`, [{ kinds: [9], '#h': [channels[0]!], limit: 1 }], 15_000);
      if (res.end[0] === 'CLOSED') {
        if (String(res.end[2]).startsWith('rate-limited')) {
          rateLimited++;
          i--;
          await sleep(5200);
          continue;
        }
        refusedAt = i;
        refusal = res.end;
        break;
      }
      if (i % 40 === 0) await sleep(5100);
    }
    r.check('one connection holds 1024 subscriptions and refuses the 1025th', refusedAt === 1025, refusedAt > 0 ? `refused at #${refusedAt}: ${shortJson(refusal)}; rate-limited retries: ${rateLimited}` : 'never refused');
    subs.close();
    reader.close();
  },
};
