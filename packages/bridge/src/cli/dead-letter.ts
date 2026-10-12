// pnpm dead-letter list [--direction mm_to_relay|relay_to_mm] [--all] [--limit <n>]
// pnpm dead-letter show <id>
// pnpm dead-letter replay <id> [<id> ...] | --all
// Inspect and replay events the bridge gave up on (docs/bridge-spec.md section 9). Replays are idempotent
// and safe while the bridge runs.
import { parseArgs } from 'node:util';
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, MattermostChatClient, parseConfig } from '@brain/shared';
import { Bridge } from '../bridge.ts';
import { bridgeConfigSchema } from '../config.ts';
import type { DeadLetterDirection, DeadLetterRow } from '../store.ts';

const USAGE = 'Usage: pnpm dead-letter list [--direction mm_to_relay|relay_to_mm] [--all] [--limit <n>] | show <id> | replay <id> [<id> ...] | replay --all';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { direction: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } },
});
const [command, ...ids] = positionals;
if (!command || !['list', 'show', 'replay'].includes(command) || (values.direction && !['mm_to_relay', 'relay_to_mm'].includes(values.direction))) {
  console.error(USAGE);
  process.exit(2);
}

/** One line per dead letter: what failed, never the message text. */
function summary(row: DeadLetterRow): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const event = row.payload.event as { id?: string; kind?: number } | undefined;
  const postId = text(row.payload.mmPostId);
  const subject = [text(row.payload.purpose) || text(row.payload.step) || text(row.payload.source), postId ? `post ${postId}` : '', event?.id ? `event ${event.id.slice(0, 12)} kind ${event.kind}` : '']
    .filter(Boolean)
    .join(', ');
  const state = row.replayedAt ? ` replayed ${row.replayedAt.toISOString()}` : '';
  return `#${row.id}  ${row.direction}  ${row.createdAt.toISOString()}  attempts ${row.attempts}  ${subject}${state}\n      ${row.error.slice(0, 200)}`;
}

loadDotEnv();
const config = parseConfig(bridgeConfigSchema);
const pool = createPool(config.STATE_DATABASE_URL);
const log = createLogger('dead-letter', config.LOG_LEVEL === 'info' ? 'warn' : config.LOG_LEVEL);
const bridge = new Bridge({
  config,
  pool,
  chat: new MattermostChatClient(config.MM_URL, config.MM_BRIDGE_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND }),
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
  keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
  log,
});
let failed = false;
try {
  if (command === 'list') {
    const rows = await bridge.store.listDeadLetters({
      ...(values.direction ? { direction: values.direction as DeadLetterDirection } : {}),
      includeReplayed: values.all ?? false,
      limit: Number(values.limit ?? 100),
    });
    console.log(rows.length === 0 ? 'No dead letters.' : rows.map(summary).join('\n'));
  } else if (command === 'show') {
    const row = ids[0] ? await bridge.store.getDeadLetter(Number(ids[0])) : undefined;
    if (!row) throw new Error(`No dead letter ${ids[0] ?? ''}`);
    console.log(summary(row));
    console.log(JSON.stringify(row.payload, null, 2));
  } else {
    const targets = values.all ? (await bridge.store.listDeadLetters({ limit: 10_000 })).map((row) => row.id) : ids.map(Number);
    if (targets.length === 0) console.log('Nothing to replay.');
    for (const id of targets) {
      try {
        console.log(`#${id}: ${await bridge.replayDeadLetter(id)}`);
      } catch (error) {
        failed = true;
        console.log(`#${id}: failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} finally {
  await pool.end();
}
process.exit(failed ? 1 : 0);
