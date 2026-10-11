// Phase 0 acceptance checks, run through the same spike code as `pnpm spike`.
import { createContext, runSpike } from '@brain/scripts/spike/run.ts';
import type { SpikeContext } from '@brain/scripts/spike/lib/spike.ts';
import { beforeAll, describe, expect, it } from 'vitest';

describe('Phase 0 acceptance', () => {
  let ctx: SpikeContext;
  beforeAll(async () => {
    ctx = await createContext();
  });

  it.each(['acceptance-relay', 'acceptance-mm'])('%s passes against the local stack', async (id) => {
    const report = await runSpike(id, ctx);
    const failed = report.checks.filter((check) => !check.ok);
    expect(report.error, report.error).toBeUndefined();
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });
});
