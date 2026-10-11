-- Agent registry (docs/agents-and-ingestion.md, A.1), schema "runtime". Secrets (the agent's Nostr key
-- and bot token) live in the shared key store (D19), not here.

CREATE TABLE runtime.agents (
  agent_id         text PRIMARY KEY,
  handle           text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  avatar_url       text,
  instructions     text NOT NULL DEFAULT '',
  model            text NOT NULL DEFAULT '',
  tools            jsonb NOT NULL DEFAULT '[]',
  knowledge_scope  jsonb NOT NULL DEFAULT '[]',
  nostr_pubkey     text NOT NULL UNIQUE,
  mm_bot_user_id   text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
