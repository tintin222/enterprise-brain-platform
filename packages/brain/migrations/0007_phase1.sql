-- Phase 1 (docs/brain/02-phase1-plan.md sections 6, 10, 11, 14): uploaded files, the brain API's recurring
-- jobs, word statistics for the keyword fallback, and indexes on the typed fields Phase 1 filters by.

-- Uploaded files (D63): the bytes live in the database, deduplicated by hash; documents reference them by id.
-- Nothing is deleted here; a document's versions each keep their file.
CREATE TABLE brain.files (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sha256      text NOT NULL UNIQUE,
  size        bigint NOT NULL,
  media_type  text NOT NULL,
  bytes       bytea NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Recurring work of the brain API (reminders, stale projects, people sync, word statistics, extraction retries):
-- one row per job and period; the insert is the lock, so two API processes never run the same period twice.
CREATE TABLE brain.jobs (
  name         text NOT NULL,
  period_key   text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  result       jsonb,
  PRIMARY KEY (name, period_key)
);
CREATE INDEX jobs_started ON brain.jobs (started_at DESC);

-- How many chunks hold each lexeme (Q24, D61): the keyword fallback for a question keeps its rarest words.
CREATE TABLE brain.lexeme_stats (
  lexeme  text PRIMARY KEY,
  chunks  integer NOT NULL
);

-- Typed fields Phase 1 filters and sorts by live in data (spec section 9); expression indexes keep them fast.
CREATE INDEX entities_task_due ON brain.entities ((data->>'dueAt')) WHERE type = 'task';
CREATE INDEX entities_task_assignee ON brain.entities ((data->>'assigneeId')) WHERE type = 'task';
CREATE INDEX entities_task_state ON brain.entities ((data->>'state')) WHERE type = 'task';
CREATE INDEX entities_document_file ON brain.entities ((data->>'fileId')) WHERE type = 'document';
CREATE INDEX links_member_role ON brain.links ((data->>'role')) WHERE kind = 'member_of';
