// pnpm spike [id ...]: run spike scripts against the local stack (needs `pnpm dev:up && pnpm dev:seed`).
// Prints each check and a summary table; writes full evidence to scripts/spike/results/<id>.json.
// Without ids it runs every spike except the opt-in ones.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, requireValue } from '../lib/env.ts';
import { MattermostApi } from '../lib/mattermost.ts';
import { identityFromHex } from '../lib/nostr.ts';
import { RelayHttp } from '../lib/relay.ts';
import { waitForStack } from '../lib/stack.ts';
import { spikes } from './index.ts';
import { Reporter, type SpikeContext, type SpikeReport } from './lib/spike.ts';

export async function createContext(): Promise<SpikeContext> {
  const env = loadEnv();
  await waitForStack(env, 60_000);
  const mmUrl = requireValue(env, 'MM_URL');
  const anonymous = new MattermostApi(mmUrl);
  return {
    env,
    runId: Date.now().toString(36),
    relayHttp: new RelayHttp(requireValue(env, 'RELAY_HTTP_URL')),
    relayWsUrl: requireValue(env, 'RELAY_WS_URL'),
    bridge: identityFromHex(requireValue(env, 'BRIDGE_SECRET_KEY')),
    reader: identityFromHex(requireValue(env, 'READER_SECRET_KEY')),
    mmAdmin: await anonymous.login(requireValue(env, 'MM_ADMIN_USERNAME'), requireValue(env, 'MM_ADMIN_PASSWORD')),
    mmBot: anonymous.withToken(requireValue(env, 'MM_BRIDGE_TOKEN')),
  };
}

export async function runSpike(id: string, ctx: SpikeContext): Promise<SpikeReport> {
  const spike = spikes.find((s) => s.id === id);
  if (!spike) throw new Error(`Unknown spike ${id}. Known: ${spikes.map((s) => s.id).join(', ')}`);
  const reporter = new Reporter();
  const started = Date.now();
  let error: string | undefined;
  try {
    await spike.run(ctx, reporter);
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  }
  return {
    id: spike.id,
    title: spike.title,
    kind: spike.kind,
    verdict: error ? 'ERROR' : reporter.verdict(),
    checks: reporter.checks,
    notes: reporter.notes,
    evidence: reporter.evidence,
    ...(error ? { error } : {}),
    durationMs: Date.now() - started,
  };
}

function print(report: SpikeReport): void {
  console.log(`\n=== ${report.id} ${report.title}: ${report.verdict} (${(report.durationMs / 1000).toFixed(1)}s)`);
  for (const check of report.checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  for (const note of report.notes) console.log(`  note  ${note}`);
  if (report.error) console.log(`  error ${report.error}`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : spikes.filter((s) => !s.optIn).map((s) => s.id);
  const ctx = await createContext();
  const resultsDir = path.join(import.meta.dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const reports: SpikeReport[] = [];
  for (const id of ids) {
    const report = await runSpike(id, ctx);
    reports.push(report);
    print(report);
    writeFileSync(path.join(resultsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log('\nSummary');
  for (const r of reports) console.log(`  ${r.verdict.padEnd(7)} ${r.id.padEnd(18)} ${r.title}`);
  const failed = reports.filter((r) => r.verdict === 'ERROR' || (r.kind === 'acceptance' && r.verdict !== 'PASS'));
  process.exitCode = failed.length > 0 ? 1 : 0;
}
