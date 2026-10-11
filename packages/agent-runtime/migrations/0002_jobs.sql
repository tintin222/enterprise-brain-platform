-- Dispatch jobs (docs/agents-and-ingestion.md, A.3): one per (agent, triggering event). The unique key is
-- the record of processed events; at most one job runs per (agent, thread) at a time.

CREATE TABLE runtime.jobs (
  id                bigserial PRIMARY KEY,
  agent_id          text NOT NULL REFERENCES runtime.agents (agent_id),
  relay_channel_id  text NOT NULL,
  thread_root_id    text NOT NULL,
  trigger_event_id  text NOT NULL,
  trigger_event     jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts          integer NOT NULL DEFAULT 0,
  reply_event_id    text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, trigger_event_id)
);

CREATE INDEX jobs_open ON runtime.jobs (status) WHERE status IN ('pending', 'running');
CREATE INDEX jobs_thread ON runtime.jobs (agent_id, thread_root_id, created_at);
