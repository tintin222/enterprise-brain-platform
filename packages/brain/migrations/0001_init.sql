-- Local stand-in for the enterprise brain (Q3, D34), schema "brain": thread documents with Postgres
-- full-text search, and the channel facts needed to scope access at query time (D35).

CREATE TABLE brain.channels (
  channel_id  text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL CHECK (visibility IN ('open', 'private')),
  -- False once the channel is paused or archived: its documents stay but are not retrieved (Q4).
  active      boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brain.documents (
  id            text PRIMARY KEY,
  channel_id    text NOT NULL,
  channel_name  text NOT NULL,
  text          text NOT NULL,
  authors       jsonb NOT NULL,
  first_at      timestamptz NOT NULL,
  last_at       timestamptz NOT NULL,
  source_url    text,
  event_ids     text[] NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (to_tsvector('english', channel_name || ' ' || text)) STORED
);
CREATE INDEX documents_search ON brain.documents USING gin (search);
CREATE INDEX documents_channel ON brain.documents (channel_id);
