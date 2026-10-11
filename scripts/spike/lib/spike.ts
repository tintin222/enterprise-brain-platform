// Spike framework: each spike records checks, notes and evidence, and gets a verdict.
// An assumption that fails is a valid finding, not a crash; only exceptions and failed acceptance
// checks make the runner exit non-zero.
import type { EnvValues } from '../../lib/env.ts';
import type { MattermostApi } from '../../lib/mattermost.ts';
import type { Identity } from '../../lib/nostr.ts';
import type { RelayHttp } from '../../lib/relay.ts';

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'ERROR';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SpikeReport {
  id: string;
  title: string;
  kind: 'assumption' | 'acceptance';
  verdict: Verdict;
  checks: Check[];
  notes: string[];
  evidence: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface SpikeContext {
  env: EnvValues;
  runId: string;
  relayHttp: RelayHttp;
  relayWsUrl: string;
  bridge: Identity;
  reader: Identity;
  /** Mattermost API as the seeded system admin. */
  mmAdmin: MattermostApi;
  /** Mattermost API as the @brain bot (MM_BRIDGE_TOKEN). */
  mmBot: MattermostApi;
}

export class Reporter {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];
  readonly evidence: Record<string, unknown> = {};
  verdictOverride?: Verdict;

  check(name: string, ok: boolean, detail = ''): boolean {
    this.checks.push({ name, ok, detail });
    return ok;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  record(key: string, value: unknown): void {
    this.evidence[key] = value;
  }

  verdict(): Verdict {
    if (this.verdictOverride) return this.verdictOverride;
    if (this.checks.length === 0) return 'FAIL';
    const passed = this.checks.filter((c) => c.ok).length;
    if (passed === this.checks.length) return 'PASS';
    return passed === 0 ? 'FAIL' : 'PARTIAL';
  }
}

export interface Spike {
  id: string;
  title: string;
  kind: 'assumption' | 'acceptance';
  /** Heavy or state-changing spikes run only when named explicitly. */
  optIn?: boolean;
  run(ctx: SpikeContext, report: Reporter): Promise<void>;
}

export function shortJson(value: unknown, max = 300): string {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
