-- Catch-up re-reads an overlap window; a change already handled must not mark its thread again (Phase 6 load test).
CREATE TABLE ingestion.seen_changes (
  event_id    text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- When the thread first changed, so the index lag is measured from there even if indexing is retried.
ALTER TABLE ingestion.pending ADD COLUMN first_at timestamptz NOT NULL DEFAULT now();
