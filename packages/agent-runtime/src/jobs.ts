// Persistent job queue in Postgres (docs/agents-and-ingestion.md, A.3).
import type { NostrEvent, Queryable } from '@brain/shared';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface Job {
  id: number;
  agentId: string;
  relayChannelId: string;
  threadRootId: string;
  triggerEventId: string;
  triggerEvent: NostrEvent;
  status: JobStatus;
  attempts: number;
  replyEventId: string | null;
}

interface JobRow {
  id: string;
  agent_id: string;
  relay_channel_id: string;
  thread_root_id: string;
  trigger_event_id: string;
  trigger_event: NostrEvent;
  status: JobStatus;
  attempts: number;
  reply_event_id: string | null;
}

const COLUMNS = 'id, agent_id, relay_channel_id, thread_root_id, trigger_event_id, trigger_event, status, attempts, reply_event_id';

const toJob = (r: JobRow): Job => ({
  id: Number(r.id),
  agentId: r.agent_id,
  relayChannelId: r.relay_channel_id,
  threadRootId: r.thread_root_id,
  triggerEventId: r.trigger_event_id,
  triggerEvent: r.trigger_event,
  status: r.status,
  attempts: r.attempts,
  replyEventId: r.reply_event_id,
});

export class JobStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** Insert a job unless this agent already has one for the trigger. Returns the new job, if any. */
  async enqueue(job: Pick<Job, 'agentId' | 'relayChannelId' | 'threadRootId' | 'triggerEvent'>, status: JobStatus = 'pending', error?: string): Promise<Job | undefined> {
    const r = await this.#db.query<JobRow>(
      `INSERT INTO runtime.jobs (agent_id, relay_channel_id, thread_root_id, trigger_event_id, trigger_event, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (agent_id, trigger_event_id) DO NOTHING RETURNING ${COLUMNS}`,
      [job.agentId, job.relayChannelId, job.threadRootId, job.triggerEvent.id, JSON.stringify(job.triggerEvent), status, error ?? null],
    );
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }

  async get(id: number): Promise<Job | undefined> {
    const r = await this.#db.query<JobRow>(`SELECT ${COLUMNS} FROM runtime.jobs WHERE id = $1`, [id]);
    return r.rows[0] ? toJob(r.rows[0]) : undefined;
  }

  async open(): Promise<Job[]> {
    const r = await this.#db.query<JobRow>(`SELECT ${COLUMNS} FROM runtime.jobs WHERE status IN ('pending', 'running') ORDER BY id`);
    return r.rows.map(toJob);
  }

  async markRunning(id: number): Promise<number> {
    const r = await this.#db.query<{ attempts: number }>("UPDATE runtime.jobs SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1 RETURNING attempts", [id]);
    return r.rows[0]?.attempts ?? 0;
  }

  async finish(id: number, status: JobStatus, fields: { replyEventId?: string; error?: string } = {}): Promise<void> {
    await this.#db.query('UPDATE runtime.jobs SET status = $2, reply_event_id = COALESCE($3, reply_event_id), error = $4, updated_at = now() WHERE id = $1', [
      id,
      status,
      fields.replyEventId ?? null,
      fields.error ?? null,
    ]);
  }

  /** Replies this agent has made or is about to make in a thread since a time (the reply-cap guard). */
  async repliesSince(agentId: string, threadRootId: string, since: Date): Promise<number> {
    const r = await this.#db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM runtime.jobs WHERE agent_id = $1 AND thread_root_id = $2 AND status IN ('pending', 'running', 'done') AND created_at >= $3",
      [agentId, threadRootId, since],
    );
    return r.rows[0]?.n ?? 0;
  }
}
