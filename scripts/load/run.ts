// pnpm load-test [--people 500] [--channels 300] [--agents 50] [--members 25] [--rate 5] [--seconds 120]
// Phase 6 load test at the scale of Q7 (docs/load-test.md). Needs a Mostlymatter stack (`pnpm dev:up
// --mostlymatter`: Team Edition stops at 250 users), `pnpm dev:seed`, and the bridge, agent-runtime and
// ingestion running as separate processes; their /metrics are read on the configured ops ports.
// Setup is idempotent, so a run can be repeated. Results go to scripts/load/results/ (not committed).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { provisionAgent } from '@brain/agent-runtime';
import { BuzzRelayClient, createPool, KeyStore, MattermostChatClient, relayChannelIdFor, signerFromHex, silentLogger, tagValue, threadDocId } from '@brain/shared';
import { loadEnv, repoRoot, requireValue } from '../lib/env.ts';
import { MattermostApi, MattermostError, type MmPost, type MmUser } from '../lib/mattermost.ts';

const { values } = parseArgs({
  options: {
    people: { type: 'string', default: '500' },
    channels: { type: 'string', default: '300' },
    agents: { type: 'string', default: '50' },
    members: { type: 'string', default: '25' },
    rate: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '120' },
    posters: { type: 'string', default: '100' },
  },
});
const N = { people: Number(values.people), channels: Number(values.channels), agents: Number(values.agents), members: Number(values.members), rate: Number(values.rate), seconds: Number(values.seconds), posters: Number(values.posters) };

/** Agreed targets (D38). */
const TARGETS = {
  onboardingSeconds: 900,
  mirrorP95Seconds: 2,
  replyP95Seconds: 10,
  indexLagP95Seconds: 30 + 15,
};

const env = loadEnv();
const mmUrl = requireValue(env, 'MM_URL');
const admin = new MattermostApi(mmUrl, requireValue(env, 'MM_ADMIN_TOKEN'));
const relay = new BuzzRelayClient(requireValue(env, 'RELAY_HTTP_URL'), { perKeyPerSecond: 15 });
const reader = signerFromHex(requireValue(env, 'READER_SECRET_KEY'));
const opsPorts = { bridge: Number(env.BRIDGE_OPS_PORT || 9101), runtime: Number(env.RUNTIME_OPS_PORT || 9102), ingestion: Number(env.INGESTION_OPS_PORT || 9103) };
const pad = (n: number, width: number): string => String(n).padStart(width, '0');
const log = (message: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items`, `concurrency` at a time. */
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

async function getOrCreate<T>(find: () => Promise<T | undefined>, create: () => Promise<T>): Promise<T> {
  return (await find()) ?? (await create().catch(async (error: unknown) => {
    const found = await find();
    if (found) return found;
    throw error;
  }));
}

// ---------------------------------------------------------------------------------------------- setup
const team = await admin.get<{ id: string }>(`/teams/name/${requireValue(env, 'MM_TEAM_NAME')}`);
const limits: { maxUsersHardLimit?: number } = await admin.get<{ maxUsersHardLimit?: number }>('/limits/server').catch(() => ({}));
if (limits.maxUsersHardLimit && limits.maxUsersHardLimit < N.people + 10) throw new Error(`This server stops at ${limits.maxUsersHardLimit} users: run the load test on Mostlymatter (pnpm dev:up --mostlymatter).`);
const botUserId = (await new MattermostApi(mmUrl, requireValue(env, 'MM_BRIDGE_TOKEN')).get<MmUser>('/users/me')).id;
const password = requireValue(env, 'MM_PERSON_PASSWORD');

let started = Date.now();
const users = await pool(
  Array.from({ length: N.people }, (_, i) => `load-u${pad(i + 1, 4)}`),
  8,
  async (username) => {
    const user = await getOrCreate(
      () => admin.find<MmUser>(`/users/username/${username}`),
      () => admin.post<MmUser>('/users', { username, email: `${username}@load.test`, password, first_name: 'Load', last_name: username.slice(5) }),
    );
    await admin.post(`/teams/${team.id}/members`, { team_id: team.id, user_id: user.id });
    return user;
  },
);
log(`${users.length} people ready (${Math.round((Date.now() - started) / 1000)} s)`);

started = Date.now();
const statePool = createPool(requireValue(env, 'STATE_DATABASE_URL'), 4);
const agents = await pool(
  Array.from({ length: N.agents }, (_, i) => `load-agent-${pad(i + 1, 2)}`),
  4,
  (handle) =>
    provisionAgent(
      {
        pool: statePool,
        chat: new MattermostChatClient(mmUrl, requireValue(env, 'MM_ADMIN_TOKEN'), { requestsPerSecond: 50 }),
        relay,
        keyStore: new KeyStore(statePool, requireValue(env, 'KEY_ENCRYPTION_KEY')),
        bridgeSigner: signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY')),
        teamName: requireValue(env, 'MM_TEAM_NAME'),
        log: silentLogger(),
      },
      { handle, displayName: `Load Agent ${handle.slice(-2)}`, model: 'echo' },
    ),
);
await statePool.end();
log(`${agents.length} agents ready (${Math.round((Date.now() - started) / 1000)} s)`);

interface LoadChannel {
  id: string;
  members: string[];
  agent: (typeof agents)[number];
}

started = Date.now();
const channels: LoadChannel[] = await pool(
  Array.from({ length: N.channels }, (_, i) => i),
  4,
  async (i) => {
    const name = `load-c${pad(i + 1, 4)}`;
    const channel = await getOrCreate(
      () => admin.find<{ id: string }>(`/teams/${team.id}/channels/name/${name}`),
      () => admin.post<{ id: string }>('/channels', { team_id: team.id, name, display_name: `Load ${pad(i + 1, 4)}`, type: i % 5 === 4 ? 'P' : 'O', purpose: 'Load test channel' }),
    );
    const members = Array.from({ length: N.members }, (_, k) => users[(i * 7 + k * 13) % users.length]!.id);
    const agent = agents[i % agents.length]!;
    await admin.post(`/channels/${channel.id}/members`, { user_ids: [...new Set(members), agent.mmBotUserId] });
    return { id: channel.id, members: [...new Set(members)], agent };
  },
);
log(`${channels.length} channels with members ready (${Math.round((Date.now() - started) / 1000)} s)`);

// ------------------------------------------------------------------------------------------ onboarding
const onboardStart = Date.now();
await pool(channels, 8, async (channel) => {
  await admin.post(`/channels/${channel.id}/members`, { user_id: botUserId }).catch((error: unknown) => {
    if (!(error instanceof MattermostError)) throw error;
  });
});
log('@brain added to every channel; waiting for the relay to mirror channels and members');

/** Relay member lists of every channel the reader is in. */
async function relayMembers(): Promise<Map<string, Set<string>>> {
  const lists = new Map<string, Set<string>>();
  for await (const list of relay.queryAll({ kinds: [39002], '#p': [reader.pubkey] }, reader)) {
    const id = tagValue(list, 'd');
    if (id && !lists.has(id)) lists.set(id, new Set(list.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]!)));
  }
  return lists;
}
const expectedMembers = N.members + 1; // people plus the agent, besides the reader and the bridge
let onboardSeconds = Number.POSITIVE_INFINITY;
for (;;) {
  const lists = await relayMembers();
  const complete = channels.filter((channel) => (lists.get(relayChannelIdFor(channel.id))?.size ?? 0) >= expectedMembers + 1).length;
  log(`onboarding: ${complete}/${channels.length} channels complete`);
  if (complete === channels.length) {
    onboardSeconds = (Date.now() - onboardStart) / 1000;
    break;
  }
  if (Date.now() - onboardStart > 3 * TARGETS.onboardingSeconds * 1000) break;
  await sleep(15_000);
}
log(`onboarding took ${onboardSeconds.toFixed(0)} s`);

// ----------------------------------------------------------------------------------------- metrics
async function scrape(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
}

function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const match = /^([a-z_]+)(\{[^}]*\})? ([0-9.e+-]+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const lineLabels = parseLabels(match[2] ?? '');
    if (Object.entries(labels).every(([key, value]) => lineLabels[key] === value)) total += Number(match[3]);
  }
  return total;
}

/** Labels of one exposition line, `{a="1",b="2"}` -> { a: '1', b: '2' }. */
function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of text.matchAll(/(\w+)="([^"]*)"/g)) labels[match[1]!] = match[2]!;
  return labels;
}

/** Cumulative bucket counts of a histogram, by upper bound. */
function histogramBuckets(text: string, name: string, labels: Record<string, string>): Map<number, number> {
  const buckets = new Map<number, number>();
  for (const line of text.split('\n')) {
    const match = /^([a-z_]+)_bucket\{([^}]*)\} ([0-9.e+-]+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const lineLabels = parseLabels(match[2]!);
    if (!Object.entries(labels).every(([key, value]) => lineLabels[key] === value)) continue;
    const le = lineLabels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(lineLabels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + Number(match[3]));
  }
  return buckets;
}

/**
 * A quantile of what a histogram recorded between two scrapes (linear within a bucket), so activity before
 * the load window (a service's catch-up at start) does not count.
 */
function histogramQuantile(beforeText: string, afterText: string, name: string, q: number, labels: Record<string, string> = {}): number | undefined {
  const start = histogramBuckets(beforeText, name, labels);
  const buckets = [...histogramBuckets(afterText, name, labels)].map(([le, count]) => ({ le, count: count - (start.get(le) ?? 0) }));
  buckets.sort((a, b) => a.le - b.le);
  const total = buckets.at(-1)?.count ?? 0;
  if (total === 0) return undefined;
  const rank = q * total;
  let previous = { le: 0, count: 0 };
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) return previous.le;
      const inBucket = bucket.count - previous.count;
      return previous.le + (inBucket === 0 ? 0 : ((rank - previous.count) / inBucket) * (bucket.le - previous.le));
    }
    previous = bucket;
  }
  return previous.le;
}

for (;;) {
  const [runtime, ingestion] = await Promise.all([scrape(opsPorts.runtime), scrape(opsPorts.ingestion)]);
  const subs = [metricValue(runtime, 'brain_runtime_relay_subscriptions'), metricValue(ingestion, 'brain_ingestion_relay_subscriptions')];
  if (subs.every((count) => count >= channels.length)) break;
  log(`waiting for subscriptions: runtime ${subs[0]}, ingestion ${subs[1]} of ${channels.length}`);
  await sleep(5000);
}
const before = { bridge: await scrape(opsPorts.bridge), runtime: await scrape(opsPorts.runtime), ingestion: await scrape(opsPorts.ingestion) };

// ------------------------------------------------------------------------------------------ messages
const posterIds = new Set(users.slice(0, N.posters).map((user) => user.id));
const sessions = new Map<string, MattermostApi>();
await pool(users.slice(0, N.posters), 8, async (user) => {
  sessions.set(user.id, await new MattermostApi(mmUrl).login(user.username, password));
});
const active = channels.filter((channel) => channel.members.some((id) => posterIds.has(id)));
interface Sent {
  post: MmPost;
  mention: boolean;
  root: boolean;
}
const sent: Sent[] = [];
const roots = new Map<string, string[]>();
const loadStart = Date.now();
log(`posting ${N.rate} messages/s for ${N.seconds} s in ${active.length} channels`);
let failures = 0;
const inFlight: Promise<void>[] = [];
for (let i = 0; i < N.rate * N.seconds; i++) {
  const due = loadStart + (i * 1000) / N.rate;
  if (due > Date.now()) await sleep(due - Date.now());
  const channel = active[Math.floor(Math.random() * active.length)]!;
  const candidates = channel.members.filter((id) => posterIds.has(id));
  const author = candidates[Math.floor(Math.random() * candidates.length)]!;
  const mention = Math.random() < 0.1;
  const earlier = roots.get(channel.id) ?? [];
  const rootId = !mention && earlier.length > 0 && Math.random() < 0.2 ? earlier[Math.floor(Math.random() * earlier.length)] : undefined;
  const message = mention ? `@${channel.agent.handle} load question ${i}` : `load message ${i} about topic ${i % 17}`;
  inFlight.push(
    sessions
      .get(author)!
      .post<MmPost>('/posts', { channel_id: channel.id, message, ...(rootId ? { root_id: rootId } : {}) })
      .then((post) => {
        sent.push({ post, mention, root: rootId === undefined });
        if (!rootId) roots.set(channel.id, [...earlier, post.id]);
      })
      .catch(() => void failures++),
  );
}
await Promise.all(inFlight);
const loadSeconds = (Date.now() - loadStart) / 1000;
log(`sent ${sent.length} posts (${failures} failed) in ${loadSeconds.toFixed(0)} s`);

// --------------------------------------------------------------------------------------- correctness
const sinceSeconds = Math.floor(loadStart / 1000) - 5;
const postIds = new Set(sent.map((item) => item.post.id));
const mirroredCount = new Map<string, number>();
const eventIdOfPost = new Map<string, string>();
const deadline = Date.now() + 180_000;
for (;;) {
  mirroredCount.clear();
  for await (const event of relay.queryAll({ kinds: [9], since: sinceSeconds }, reader)) {
    const postId = tagValue(event, 'mm');
    if (postId && postIds.has(postId)) {
      mirroredCount.set(postId, (mirroredCount.get(postId) ?? 0) + 1);
      eventIdOfPost.set(postId, event.id);
    }
  }
  if (mirroredCount.size === postIds.size || Date.now() > deadline) break;
  await sleep(5000);
}
const missing = postIds.size - mirroredCount.size;
const duplicated = [...mirroredCount.values()].filter((count) => count > 1).length;

const mentions = sent.filter((item) => item.mention);
const replyLatencies: number[] = [];
let unanswered = 0;
let doubleAnswered = 0;
await pool(mentions, 8, async ({ post }) => {
  const channel = channels.find((c) => c.id === post.channel_id)!;
  let replies: MmPost[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const thread = await admin.get<{ posts: Record<string, MmPost> }>(`/posts/${post.id}/thread`);
    replies = Object.values(thread.posts).filter((p) => p.user_id === channel.agent.mmBotUserId);
    if (replies.length > 0) break;
    await sleep(2000);
  }
  if (replies.length === 0) unanswered++;
  else {
    if (replies.length > 1) doubleAnswered++;
    replyLatencies.push((Math.min(...replies.map((p) => p.create_at)) - post.create_at) / 1000);
  }
});
// Index lag, exactly: from each new thread's root post to the first write of its brain document.
const rootDocs = new Map(sent.filter((item) => item.root && eventIdOfPost.has(item.post.id)).map((item) => [threadDocId(relayChannelIdFor(item.post.channel_id), eventIdOfPost.get(item.post.id)!), item.post]));
const brainDb = createPool(requireValue(env, 'STATE_DATABASE_URL'), 2);
const firstWritten = new Map<string, Date>();
const indexDeadline = Date.now() + 240_000;
while (firstWritten.size < rootDocs.size && Date.now() < indexDeadline) {
  const found = await brainDb.query<{ id: string; created_at: Date }>('SELECT id, created_at FROM brain.documents WHERE id = ANY($1)', [[...rootDocs.keys()]]);
  for (const row of found.rows) firstWritten.set(row.id, row.created_at);
  if (firstWritten.size < rootDocs.size) await sleep(5000);
}
await brainDb.end();
const indexLags = [...firstWritten].map(([id, at]) => (at.getTime() - rootDocs.get(id)!.create_at) / 1000);

// ------------------------------------------------------------------------------------------- report
const after = { bridge: await scrape(opsPorts.bridge), runtime: await scrape(opsPorts.runtime), ingestion: await scrape(opsPorts.ingestion) };
const quantile = (list: number[], q: number): number | undefined => {
  if (list.length === 0) return undefined;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const delta = (name: string, labels: Record<string, string> = {}): number =>
  (['bridge', 'runtime', 'ingestion'] as const).reduce((sum, service) => sum + metricValue(after[service], name, labels) - metricValue(before[service], name, labels), 0);
const report = {
  scale: N,
  targets: TARGETS,
  onboardingSeconds: Math.round(onboardSeconds),
  posts: { sent: sent.length, failed: failures, perSecond: Number((sent.length / loadSeconds).toFixed(2)), missingOnRelay: missing, duplicatedOnRelay: duplicated },
  mirrorMmToRelaySeconds: { p50: histogramQuantile(before.bridge, after.bridge, 'brain_bridge_mirror_lag_seconds', 0.5, { direction: 'mm_to_relay' }), p95: histogramQuantile(before.bridge, after.bridge, 'brain_bridge_mirror_lag_seconds', 0.95, { direction: 'mm_to_relay' }) },
  mirrorRelayToMmSeconds: { p50: histogramQuantile(before.bridge, after.bridge, 'brain_bridge_mirror_lag_seconds', 0.5, { direction: 'relay_to_mm' }), p95: histogramQuantile(before.bridge, after.bridge, 'brain_bridge_mirror_lag_seconds', 0.95, { direction: 'relay_to_mm' }) },
  agentReplies: { mentions: mentions.length, unanswered, doubleAnswered, p50Seconds: quantile(replyLatencies, 0.5), p95Seconds: quantile(replyLatencies, 0.95), maxSeconds: quantile(replyLatencies, 1) },
  indexLagSeconds: { threads: rootDocs.size, notIndexed: rootDocs.size - firstWritten.size, p50: quantile(indexLags, 0.5), p95: quantile(indexLags, 0.95), max: quantile(indexLags, 1) },
  serviceIndexLagSeconds: { p50: histogramQuantile(before.ingestion, after.ingestion, 'brain_ingestion_index_lag_seconds', 0.5), p95: histogramQuantile(before.ingestion, after.ingestion, 'brain_ingestion_index_lag_seconds', 0.95) },
  relay: { requests: delta('brain_relay_requests_total'), rateLimited: delta('brain_relay_requests_total', { status: '429' }), errors: delta('brain_relay_requests_total', { status: 'error' }), reconnects: delta('brain_relay_reconnects_total') },
  bridge: { newDeadLetters: delta('brain_bridge_dead_letters_total'), retries: delta('brain_bridge_retries_total'), outbox: metricValue(after.bridge, 'brain_bridge_outbox_rows') },
  subscriptions: { bridge: metricValue(after.bridge, 'brain_bridge_relay_subscriptions'), runtime: metricValue(after.runtime, 'brain_runtime_relay_subscriptions'), ingestion: metricValue(after.ingestion, 'brain_ingestion_relay_subscriptions') },
};
const checks = {
  onboarding: report.onboardingSeconds <= TARGETS.onboardingSeconds,
  mirror: (report.mirrorMmToRelaySeconds.p95 ?? Infinity) <= TARGETS.mirrorP95Seconds,
  replies: (report.agentReplies.p95Seconds ?? Infinity) <= TARGETS.replyP95Seconds && unanswered === 0 && doubleAnswered === 0,
  indexing: (report.indexLagSeconds.p95 ?? Infinity) <= TARGETS.indexLagP95Seconds && report.indexLagSeconds.notIndexed === 0,
  noLoss: missing === 0 && duplicated === 0 && failures === 0,
  noDeadLetters: report.bridge.newDeadLetters === 0,
  subscriptions: report.subscriptions.bridge >= channels.length && report.subscriptions.runtime >= channels.length && report.subscriptions.ingestion >= channels.length,
};
const dir = path.join(repoRoot, 'scripts/load/results');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify({ ...report, checks }, null, 2)}\n`);
console.log(JSON.stringify({ ...report, checks }, null, 2));
log(`report written to ${path.relative(repoRoot, file)}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
