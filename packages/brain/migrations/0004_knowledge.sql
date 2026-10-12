-- The knowledge model (docs/COMPANY_BRAIN_SPEC.md section 3 and 9, adapted to our conventions; docs/brain/01-phase0-plan.md
-- section 4). One installation per customer: no tenant column anywhere.

-- Project, Topic and the one General container (FR-1.10). kind 'general' has exactly one row, id 'general'.
CREATE TABLE brain.containers (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind        text NOT NULL CHECK (kind IN ('project', 'topic', 'general')),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  owner_id    text,                        -- a person entity id (Phase 1 fills it)
  channel_id  text UNIQUE,                 -- the home channel (Mattermost id) of a topic or project
  data        jsonb NOT NULL DEFAULT '{}', -- goal, client, stage, dates, kind internal/external, spawned_from, ...
  version     integer NOT NULL DEFAULT 1,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO brain.containers (id, kind, slug, title, created_by) VALUES ('general', 'general', 'general', 'General', 'system');

-- Which container a Mattermost channel feeds (D50, FR-1.7, FR-1.2). One container per channel; a container may
-- have several channels. The relay channel id is derived from the Mattermost id (D18), so ingestion, which only
-- knows relay ids, attributes conversations without any Mattermost call.
CREATE TABLE brain.channel_links (
  mm_channel_id     text PRIMARY KEY,
  relay_channel_id  text NOT NULL UNIQUE,
  container_id      text NOT NULL REFERENCES brain.containers (id),
  role              text NOT NULL CHECK (role IN ('home', 'requirements', 'agent', 'linked')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_links_container ON brain.channel_links (container_id);

-- Every entity (spec section 3). `text` is the free text that is chunked and embedded; `data` holds the typed fields.
-- `visibility`: public (everyone signed in), members (members of channel_id), container (members of container_id).
-- Conversations keep the relay channel id in channel_id.
CREATE TABLE brain.entities (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type          text NOT NULL CHECK (type IN ('person', 'system', 'requirement', 'document', 'credential_ref', 'task', 'decision', 'conversation', 'meeting', 'package', 'agent', 'agent_note')),
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  owner_id      text,
  container_id  text NOT NULL REFERENCES brain.containers (id),
  external_key  text UNIQUE,              -- idempotent producers: 'thread:<relay channel>:<root event>' for conversations
  channel_id    text,
  visibility    text NOT NULL DEFAULT 'container' CHECK (visibility IN ('public', 'members', 'container')),
  data          jsonb NOT NULL DEFAULT '{}',
  text          text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1,
  source_kind   text NOT NULL CHECK (source_kind IN ('api', 'web', 'chat', 'upload', 'mail', 'meeting', 'migration', 'system')),
  source_ref    text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz               -- nothing is deleted; agents cannot archive (spec section 5)
);
CREATE INDEX entities_container_type ON brain.entities (container_id, type);
CREATE INDEX entities_type_updated ON brain.entities (type, updated_at DESC);
CREATE INDEX entities_owner ON brain.entities (owner_id);
CREATE INDEX entities_channel ON brain.entities (channel_id);
CREATE INDEX entities_data ON brain.entities USING gin (data jsonb_path_ops);
CREATE INDEX entities_title_trgm ON brain.entities USING gin (title gin_trgm_ops);

-- Every create and update, with actor and source (spec section 3, rules). Nothing is overwritten silently.
CREATE TABLE brain.entity_versions (
  entity_id     text NOT NULL REFERENCES brain.entities (id),
  version       integer NOT NULL,
  title         text NOT NULL,
  status        text NOT NULL,
  owner_id      text,
  container_id  text NOT NULL,
  visibility    text NOT NULL,
  data          jsonb NOT NULL,
  text          text NOT NULL,
  actor_id      text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
  source_kind   text NOT NULL,
  source_ref    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, version)
);

-- Typed, bidirectional links between entities and containers (either end may be a container id).
CREATE TABLE brain.links (
  id          bigserial PRIMARY KEY,
  from_id     text NOT NULL,
  to_id       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('belongs_to', 'raised_by', 'implements', 'depends_on', 'supersedes', 'mentioned_in', 'owns', 'member_of', 'attached_to', 'spawned_from')),
  data        jsonb NOT NULL DEFAULT '{}',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX links_from ON brain.links (from_id, kind);
CREATE INDEX links_to ON brain.links (to_id, kind);

-- Retrieval units (FR-9.1, FR-9.2): the keyword index is immediate, the embedding is filled by the worker (D53).
-- container_id, channel_id, visibility and entity_type are copied from the entity so search filters need no join.
CREATE TABLE brain.chunks (
  id               text PRIMARY KEY,       -- '<entity id>:<ordinal>'
  entity_id        text NOT NULL REFERENCES brain.entities (id) ON DELETE CASCADE,
  entity_type      text NOT NULL,
  container_id     text NOT NULL,
  channel_id       text,
  visibility       text NOT NULL,
  ordinal          integer NOT NULL,
  text             text NOT NULL,
  tokens           integer,
  metadata         jsonb NOT NULL DEFAULT '{}',   -- message anchors (post ids, authors, times), doc_id, source_url
  search           tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  embedding        vector(1536),
  embedding_model  text,
  embedded_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_search ON brain.chunks USING gin (search);
CREATE INDEX chunks_embedding ON brain.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_entity ON brain.chunks (entity_id);
CREATE INDEX chunks_container ON brain.chunks (container_id);
CREATE INDEX chunks_channel ON brain.chunks (channel_id);
CREATE INDEX chunks_to_embed ON brain.chunks (updated_at) WHERE embedded_at IS NULL;

-- Append-only (spec section 7): a trigger refuses UPDATE and DELETE.
CREATE TABLE brain.audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
  action        text NOT NULL,             -- entity.create, entity.update, link.create, search, export, ...
  entity_id     text,
  container_id  text,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  request_id    text
);
CREATE INDEX audit_entity ON brain.audit_log (entity_id, at DESC);
CREATE INDEX audit_actor ON brain.audit_log (actor_id, at DESC);
CREATE INDEX audit_at ON brain.audit_log (at DESC);

CREATE FUNCTION brain.audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'brain.audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON brain.audit_log FOR EACH ROW EXECUTE FUNCTION brain.audit_log_is_append_only();

-- Internal event bus (spec section 9 events), consumed by workers and, in Phase 4, outbound webhooks.
CREATE TABLE brain.events (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,             -- entity.created, entity.updated, conversation.ingested, ...
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE INDEX events_pending ON brain.events (id) WHERE delivered_at IS NULL;
