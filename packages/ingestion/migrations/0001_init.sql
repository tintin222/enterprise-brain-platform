-- Ingestion state (docs/agents-and-ingestion.md part B), schema "ingestion". Its own cursors: nothing here
-- depends on the bridge's state.

CREATE TABLE ingestion.cursors (
  stream      text PRIMARY KEY,
  position    bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every chat message seen and its thread. Edits and deletions name only their target, and the relay hides
-- deleted events, so this is how a deletion finds the thread to re-index.
CREATE TABLE ingestion.messages (
  event_id    text PRIMARY KEY,
  channel_id  text NOT NULL,
  root_id     text NOT NULL,
  author      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread ON ingestion.messages (channel_id, root_id);
CREATE INDEX messages_author ON ingestion.messages (author);

-- Threads that have documents in the brain, and their document ids (one, or one per chunk).
CREATE TABLE ingestion.threads (
  channel_id  text NOT NULL,
  root_id     text NOT NULL,
  doc_ids     text[] NOT NULL,
  indexed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, root_id)
);

-- Threads waiting to be indexed. The first change sets due_at (the debounce); later changes only bump
-- version, so a change that lands while the thread is being indexed keeps the row for another pass.
CREATE TABLE ingestion.pending (
  channel_id  text NOT NULL,
  root_id     text NOT NULL,
  due_at      timestamptz NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (channel_id, root_id)
);
CREATE INDEX pending_due ON ingestion.pending (due_at);

-- Purges (B.4): content from these channels or authors is removed and never indexed again.
CREATE TABLE ingestion.exclusions (
  kind        text NOT NULL CHECK (kind IN ('channel', 'author')),
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);
