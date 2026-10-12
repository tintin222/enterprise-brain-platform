// Recurring work of the brain API (plan section 11): one tick per minute looks at every registered job, asks it
// which period it owes now, and runs it once per period. The row in brain.jobs is the lock, so two API
// processes never run the same period twice; a failed run frees the row and is retried on the next tick.
import type { Pool } from '@brain/shared';
import { counter, errorFields, histogram, type Logger } from '@brain/shared';

const runs = counter('brain_jobs_total', 'Job runs by name and outcome', ['job', 'outcome']);
const seconds = histogram('brain_job_seconds', 'Job duration', ['job'], [0.1, 0.5, 1, 5, 15, 60, 300]);

export interface JobSpec {
  name: string;
  /** The period this job owes at `now` (a day, a minute slot, …), or undefined when nothing is due. */
  due(now: Date): string | undefined;
  /** Do the work; the result is stored with the run. */
  run(period: string): Promise<Record<string, unknown>>;
}

export interface JobRunner {
  register(job: JobSpec): void;
  /** Run every job that is due now (tests); resolves with the names that ran. */
  tick(now?: Date): Promise<string[]>;
  /** Run one job now whatever its schedule (an administrator's request, tests); its result when it ran. */
  runNow(name: string): Promise<Record<string, unknown> | undefined>;
  stop(): void;
}

export function startJobRunner(options: { pool: Pool; log: Logger; tickMs: number; enabled?: boolean }): JobRunner {
  const { pool, log } = options;
  const jobs: JobSpec[] = [];
  let ticking: Promise<string[]> | undefined;

  async function claim(job: JobSpec, period: string): Promise<boolean> {
    const r = await pool.query('INSERT INTO brain.jobs (name, period_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [job.name, period]);
    return r.rowCount === 1;
  }

  async function runOne(job: JobSpec, period: string): Promise<Record<string, unknown> | undefined> {
    const started = Date.now();
    try {
      const result = await job.run(period);
      await pool.query('UPDATE brain.jobs SET finished_at = now(), result = $3 WHERE name = $1 AND period_key = $2', [job.name, period, JSON.stringify(result)]);
      runs.inc({ job: job.name, outcome: 'ok' });
      log.info({ job: job.name, period, ms: Date.now() - started, ...result }, 'Job ran');
      return result;
    } catch (error) {
      // Free the period so the next tick tries again; the failure stays in the log and the metric.
      await pool.query('DELETE FROM brain.jobs WHERE name = $1 AND period_key = $2', [job.name, period]).catch(() => undefined);
      runs.inc({ job: job.name, outcome: 'error' });
      log.warn({ job: job.name, period, ...errorFields(error) }, 'Job failed; it will be retried');
      return undefined;
    } finally {
      seconds.observe({ job: job.name }, (Date.now() - started) / 1000);
    }
  }

  async function tickNow(now: Date): Promise<string[]> {
    const ran: string[] = [];
    for (const job of jobs) {
      const period = job.due(now);
      if (!period) continue;
      if (await claim(job, period)) {
        await runOne(job, period);
        ran.push(job.name);
      }
    }
    return ran;
  }

  const tick = (now = new Date()): Promise<string[]> => {
    ticking ??= tickNow(now).finally(() => (ticking = undefined));
    return ticking;
  };

  const timer = options.enabled === false ? undefined : setInterval(() => void tick().catch((error: unknown) => log.error(errorFields(error), 'Job tick failed')), options.tickMs);
  return {
    register: (job) => {
      jobs.push(job);
    },
    tick,
    runNow: async (name) => {
      const job = jobs.find((candidate) => candidate.name === name);
      if (!job) throw new Error(`No job named ${name}`);
      const period = `manual:${new Date().toISOString()}`;
      return (await claim(job, period)) ? runOne(job, period) : undefined;
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
