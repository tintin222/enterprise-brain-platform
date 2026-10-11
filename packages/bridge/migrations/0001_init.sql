-- Bridge state (docs/bridge-spec.md section 3), schema "bridge" of our state database.
-- The identity map and key store live in the shared "identity" schema (D19).

CREATE TABLE bridge.channel_map (
  mm_channel_id     text PRIMARY KEY,
  mm_team_id        text NOT NULL,
  relay_channel_id  uuid NOT NULL UNIQUE,
  visibility        text NOT NULL CHECK (visibility IN ('open', 'private')),
  state             text NOT NULL CHECK (state IN ('active', 'paused', 'archived')),
  enabled_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The loop-prevention source of truth. mm_post_id is null while a relay -> Mattermost post is in flight.
CREATE TABLE bridge.message_map (
  relay_event_id     text PRIMARY KEY,
  mm_post_id         text UNIQUE,
  origin             text NOT NULL CHECK (origin IN ('mm', 'relay')),
  mm_channel_id      text NOT NULL,
  author_mm_user_id  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Signed events waiting for the relay (spike A5): retries resend the exact event.
CREATE TABLE bridge.relay_outbox (
  relay_event_id     text PRIMARY KEY,
  purpose            text NOT NULL,
  mm_post_id         text,
  mm_channel_id      text NOT NULL,
  author_mm_user_id  text NOT NULL,
  signed_event       jsonb NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX relay_outbox_post_purpose ON bridge.relay_outbox (mm_post_id, purpose) WHERE mm_post_id IS NOT NULL;

-- One row per stream: "mm:<channel id>" holds a Mattermost time (ms) before which every post was processed.
CREATE TABLE bridge.cursors (
  stream      text PRIMARY KEY,
  position    bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bridge.dead_letter (
  id           bigserial PRIMARY KEY,
  direction    text NOT NULL CHECK (direction IN ('mm_to_relay', 'relay_to_mm')),
  payload      jsonb NOT NULL,
  error        text NOT NULL,
  attempts     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  replayed_at  timestamptz
);
