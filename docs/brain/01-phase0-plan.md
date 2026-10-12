# Phase 0 plan: Foundation

Plan for Phase 0 of `docs/COMPANY_BRAIN_SPEC.md` (section 11), written on 2026-10-12 after the owner answered the audit's questions (`00-gap-analysis.md` section 9; decisions D49–D55, questions Q18–Q23 in `docs/decisions.md`). Status: **waiting for the owner's approval** (spec section 12, Step 2). Nothing below is built yet.

## 1. Scope and gate

Spec scope for Phase 0: the container model (Project, Topic), the entity, link and version model, the audit log, the brain API, hybrid search, the model-provider abstraction (Anthropic, Gemini), the clean-install script; requirements **FR-9.1, FR-9.2, FR-9.4** and **NFR-1, NFR-9, NFR-12**. Deliverables: migrations, `/api/v1/brain`, container and entity pages in the UI, a search box, an install guide.

Gate: *a clean install from scratch passes its test; any entity is searchable within 5 s of creation.*

Also in this phase because everything later stands on them: the access policy (FR-9.5, so search never shows what a person cannot open), capture of every channel into the store (D50) with conversations attributed to containers, feature flags (D55), the secret check in CI, and `docs/brain/API.md` generated from the routes.

Left to later phases on purpose: project channel groups and home pages (FR-1, Phase 1), people profiles (FR-2), systems (FR-3), documents and files (FR-5), tasks (FR-11), the agents' playbooks, proposals and `/ask` (Phase 2), the vault (Phase 3), connectors and meetings (Phase 4). Their tables are not created early; only the generic entity model that will hold them.

## 2. Architecture after Phase 0

```
 people ── Enterprise Brain chat (Mattermost) ──┬─ WebSocket/REST ──> bridge ──> Buzz relay ──> ingestion ──┐
   │            │  slash commands, dialogs,      │                                   │                      │ conversation entities
   │            │  buttons (HTTP callbacks)      │                            agent-runtime <── search ──┐  │ and chunks
   │            ▼                                ▼                                                      │  ▼
   │       brain-api  <── OAuth 2.0 sign-in ── Mattermost          packages/brain (store, access, search) ── state Postgres (pgvector)
   │            │  /api/v1/brain, pages, /mm callbacks, embedding worker, export
   └── browser ─┘  brain-web (React)
```

| Package | New? | Role |
| --- | --- | --- |
| `packages/models` | new | `LlmProvider` (Anthropic, Gemini, echo) and `EmbeddingProvider` (Gemini, mock), cost table. Moved out of agent-runtime so the brain API can use them too (D54). |
| `packages/brain` | new | The knowledge store: migrations for schema `brain`, repositories (containers, entities with versions, links, chunks, audit, events), chunker, access policy, hybrid search, export; `PostgresBrainClient` re-implemented on it so agents and ingestion keep their `BrainClient` seam. No HTTP, no Mattermost. |
| `packages/brain-api` | new | The service (`pnpm brain-api`, port 9120): Fastify routes under `/api/v1/brain`, Mattermost sign-in and sessions, Mattermost command, dialog and action callbacks under `/mm/*`, the embedding worker, the admin API's routes (moved from agent-runtime), static serving of `brain-web`, `/healthz`, `/readyz`, `/metrics`. |
| `packages/brain-web` | new | React pages (Vite build, FormatJS catalog): search, containers, container page, entity page with versions and backlinks, sign-in. Built into the services image and served by `brain-api`. |
| `packages/shared` | changed | `ChatClient` gains the calls the brain needs (section 10). `PostgresBrainClient` moves to `packages/brain`. |
| `packages/ingestion` | changed | Writes conversation entities and chunks (with message anchors and channel visibility) instead of bare thread documents; attributes them to the container that owns the channel, or to General. |
| `packages/bridge` | changed | Capture of every channel (D50): a sweep that adds `@brain` to channels never captured. |
| `packages/agent-runtime` | changed | Imports providers from `packages/models`; the admin API code leaves. |
| `infra/state-postgres` | new | The pinned Postgres image with pgvector compiled in (D52); used by Compose and by staging. |
| `install/` | new | The clean-install bundle (section 13). |

ESLint's rule-6 fence (`no-restricted-imports`) is extended to `packages/brain`, `brain-api`, `brain-web` and `models`.

## 3. Spikes first

Small scripts under `scripts/spike/` (`pnpm spike B1` …), results recorded in `docs/spike-findings.md` before the code that depends on them (CLAUDE.md rule 2).

| # | Question | Pass when | If it fails |
| --- | --- | --- | --- |
| B1 | Does Mattermost call a slash-command URL on a private address (`http://brain-api:9120` in Compose), and which `AllowedUntrustedInternalConnections` value is needed? | A command registered through the API reaches a probe server by its Compose name, with `user_id`, `channel_id`, `trigger_id`, `token`. | Put the brain API behind a name Mattermost accepts, or route callbacks through the public address. |
| B2 | How long is a `trigger_id` valid, and what is the integration request timeout? | A dialog opened 1 s after the command appears; the limits are measured and written down. | Open dialogs synchronously in the command handler; keep every handler under the timeout and finish work in jobs. |
| B3 | Mattermost's OAuth 2.0 provider end to end: app creation by API, authorization code, token exchange, `GET /api/v4/users/me` with the token, a trusted app skipping the consent screen. | A script completes the flow with alice's session and gets her user id. | Fall back to the same-origin reverse proxy design (gap analysis 6.4, option 2). |
| B4 | Can the `@brain` bot download a file from a channel it is in with its own token? | `GET /api/v4/files/{id}` returns the bytes posted by alice. | Use the admin token for file reads (recorded as an accepted risk). |
| B5 | pgvector compiled onto `postgres:17.11-alpine3.24`; `CREATE EXTENSION vector` from a migration; HNSW index with a scope filter (`hnsw.iterative_scan`). | The image builds under BuildKit, the extension installs on the existing local data directory, a filtered nearest-neighbour query returns the expected rows. | Option B of the audit (the pgvector project's image) with a dump and restore. |
| B6 | The Gemini API through `@google/genai`: a chat call with a tool call and result, and embeddings at 1536 dimensions; the current model ids, input limits and prices. | Both calls succeed against the current SDK; the facts go into `docs/decisions.md`. | Needs a Google key; without one the spike records "not run" and the Gemini provider ships with tests against a fake transport only. |

## 4. Data model (migrations)

All in schema `brain`, applied by `migrate()` at `brain-api` start (the existing files `0001_init.sql` and `0002_document_created_at.sql` move from `packages/shared/migrations/brain/` to `packages/brain/migrations/` unchanged; names are what the migration table tracks, so nothing re-runs). Conventions: `text` ids (UUIDs), `timestamptz`, `jsonb`, `snake_case`, one comment per table naming the spec section or decision. No tenant column anywhere.

`0003_extensions.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;   -- D52
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- title and name matching
```

`0004_knowledge.sql` (spec section 9, adapted)

```sql
-- Project, Topic and the one General container (FR-1.10). kind 'general' has exactly one row, id 'general'.
CREATE TABLE brain.containers (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind        text NOT NULL CHECK (kind IN ('project', 'topic', 'general')),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  owner_id    text,                       -- person entity id (Phase 1 fills it)
  channel_id  text UNIQUE,                -- home channel (Mattermost id) for topics and projects
  data        jsonb NOT NULL DEFAULT '{}',-- goal, client, stage, dates, kind internal/external, spawned_from, ...
  version     integer NOT NULL DEFAULT 1,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO brain.containers (id, kind, slug, title, created_by) VALUES ('general', 'general', 'general', 'General', 'system');

-- Which container a Mattermost channel feeds. One container per channel; a container may have several channels.
CREATE TABLE brain.channel_links (
  mm_channel_id     text PRIMARY KEY,
  relay_channel_id  uuid NOT NULL UNIQUE,  -- relayChannelIdFor(mm_channel_id), so ingestion needs no Mattermost call
  container_id      text NOT NULL REFERENCES brain.containers (id),
  role              text NOT NULL CHECK (role IN ('home', 'requirements', 'agent', 'linked')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Every entity (spec section 3). `text` is the free text that is chunked and embedded; `data` holds the typed fields.
CREATE TABLE brain.entities (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type          text NOT NULL CHECK (type IN ('person','system','requirement','document','credential_ref','task','decision','conversation','meeting','package','agent','agent_note')),
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  owner_id      text,
  container_id  text NOT NULL REFERENCES brain.containers (id),
  external_key  text UNIQUE,              -- idempotent producers: 'thread:<relay channel>:<root event>' for conversations
  channel_id    text,                     -- conversations: the Mattermost channel they came from
  visibility    text NOT NULL DEFAULT 'container' CHECK (visibility IN ('public', 'members', 'container')),
  data          jsonb NOT NULL DEFAULT '{}',
  text          text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1,
  source_kind   text NOT NULL,            -- api, web, chat, upload, mail, meeting, migration, system
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
  kind        text NOT NULL CHECK (kind IN ('belongs_to','raised_by','implements','depends_on','supersedes','mentioned_in','owns','member_of','attached_to','spawned_from')),
  data        jsonb NOT NULL DEFAULT '{}',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX links_from ON brain.links (from_id, kind);
CREATE INDEX links_to ON brain.links (to_id, kind);

-- Retrieval units: keyword index at once, embedding filled by the worker (D52, D53).
CREATE TABLE brain.chunks (
  id               text PRIMARY KEY,       -- '<entity id>:<ordinal>'
  entity_id        text NOT NULL REFERENCES brain.entities (id) ON DELETE CASCADE,
  container_id     text NOT NULL,
  channel_id       text,
  visibility       text NOT NULL,
  ordinal          integer NOT NULL,
  text             text NOT NULL,
  tokens           integer,
  metadata         jsonb NOT NULL DEFAULT '{}',   -- message anchors: mm post ids, permalink, authors, time range
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
CREATE INDEX chunks_to_embed ON brain.chunks (updated_at) WHERE embedded_at IS NULL;

-- Append-only (spec section 7): a trigger refuses UPDATE and DELETE.
CREATE TABLE brain.audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
  action        text NOT NULL,            -- entity.create, entity.update, link.create, search, export, ...
  entity_id     text,
  container_id  text,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  request_id    text
);
CREATE INDEX audit_entity ON brain.audit_log (entity_id, at DESC);
CREATE INDEX audit_actor ON brain.audit_log (actor_id, at DESC);

-- Internal event bus (spec section 9 events), consumed by workers and, in Phase 4, outbound webhooks.
CREATE TABLE brain.events (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,            -- entity.created, entity.updated, conversation.ingested, ...
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
```

`0005_conversations.sql`: moves every row of `brain.documents` into a `conversation` entity in General (one entity per thread, one chunk per existing document, `external_key` from the document id, `channel_id` from the bridge's mapping where known) and drops `brain.documents`. `brain.channels` stays: it is the relay-side channel fact table that ingestion maintains and that scope checks for agents still use (D35, D36).

Writes go through one repository function per table so that every entity write, in one transaction, bumps `version`, inserts the version row, writes the audit row, re-chunks the text when it changed (resetting `embedded_at`), and appends an event.

## 5. Access policy (FR-9.5)

One function, `canSee(principal, item)`, used by every read and by search as a SQL filter.

| Principal | Comes from |
| --- | --- |
| A person | A `brain-api` session (Mattermost OAuth sign-in), or the `user_id` of a Mattermost command, dialog or button callback: the brain acts **as that person**, never as the integration |
| The service | `Authorization: Bearer $BRAIN_API_TOKEN` (our scripts, staging tools, e2e); full access, every write audited as `system` |
| An agent | Phase 2 |

Rules in Phase 0:

- A Mattermost system admin sees everything.
- A conversation is visible when its channel is public, or when the person is a current member of the channel. Membership comes from Mattermost through `ChatClient` with the `@brain` token (the person's channel list per team, cached 60 s), never from a snapshot in our tables (architecture section 6).
- An entity of a container is visible to the container's members. In Phase 0 a container's members are the members of its linked channels plus its owner; Phase 1 adds explicit roles (FR-2.3). Entities of General are visible to everyone signed in.
- Search applies the same rule as a filter on `chunks` (`visibility = 'public'`, or `channel_id` in the person's channels, or `container_id` in the person's containers), so no result is produced that the person could not open.
- Agents answering in a channel keep D35 (the channel itself plus active open channels), which is stricter, because the answer is visible to everyone in that channel.

Searches are audited with the query hash and result count, not the query text; reads of ordinary entities are not audited in Phase 0 (confidential documents and credentials, which the spec audits per read, arrive in Phases 1 and 3).

## 6. Capture: every channel into the store

- **Bridge (D50).** New setting `BRAIN_CAPTURE_CHANNELS` = `all` (default) | `public` | `opt-in`. A sweep every `CAPTURE_SWEEP_SECONDS` (60) lists the team's public and private channels and adds `@brain` to each one that has no `channel_map` row; reconciliation does the same. A channel someone removed `@brain` from has a row in state `paused`, so it is not re-added; the sweep logs it once and the metric `brain_bridge_channels_opted_out` counts them. Direct and group messages are never listed.
- **Ingestion.** `buildThreadDocuments` keeps producing one document per thread (chunked when long) but each chunk now carries anchors: the `mm` post ids it covers, the permalink of its first message, authors and the time range. `BrainClient.upsertDocuments` (implemented in `packages/brain`) upserts the `conversation` entity (`external_key = thread:<relay channel>:<root>`, title from the first message, `channel_id`, `visibility` public or members from `brain.channels`, `container_id` from `channel_links` or General) and its chunks, then appends `conversation.ingested`. Deletions and purges remove chunks and archive the entity; the existing e2e suite for ingestion (B.5 tests 1–5) must keep passing unchanged.
- **Linking a channel to a container** (`POST /containers/{id}/channels`, or `/brain link`) re-attributes that channel's existing conversations in one statement and enables the channel through the existing admin operation (adds `@brain`), so a Topic promoted in Phase 1 gets its history at once.

NFR-2 holds as today (thread indexed within the 30 s debounce); entity creation through the API indexes synchronously, which is what the 5-second gate measures.

## 7. Search (FR-9.1, FR-9.2, FR-9.4; NFR-1)

- **Keyword:** `chunks.search @@ query` with `ts_rank_cd`, the OR-of-stemmed-words query the local brain uses today, plus a trigram match on entity titles so a title typo still finds the entity.
- **Semantic:** `embedding <=> $query_embedding` (cosine) with HNSW, scoped by the access filter; `hnsw.iterative_scan = relaxed_order` so a selective filter does not empty the result (checked in spike B5).
- **Hybrid ranking:** reciprocal rank fusion in one SQL statement: the top 50 keyword hits and the top 50 vector hits, score `1/(60+rank_keyword) + 1/(60+rank_vector)`, then one result per entity (best chunk), filters by container, type, person (author or owner) and date, `limit` up to 50. When no embedding provider is configured, or the query embedding fails, the keyword half runs alone and the response says `semantic: false`.
- **Result shape:** entity id, type, title, container, version, chunk id, snippet (`ts_headline` or the chunk's first lines), score, which halves matched, and a citation (`post` with permalink and post id for conversations, `entity` with version otherwise), so FR-9.3's answers in Phase 2 can cite exactly.
- **Backlinks (FR-9.4):** `GET /entities/{id}/backlinks` returns every link pointing at the entity, grouped by kind, plus conversations whose chunks mention the entity's title or handle (`mentioned_in` links are written by ingestion when a chunk contains an entity's title; the full mention detector comes with Phase 1's people and systems).
- **Embedding worker** (in `brain-api`): every 2 s, up to 64 chunks `WHERE embedded_at IS NULL FOR UPDATE SKIP LOCKED`, one provider call per batch, backoff on errors; metrics `brain_embed_pending`, `brain_embed_seconds`, `brain_embed_errors_total`. Changed text resets `embedded_at`, so re-embedding is automatic.
- **NFR-1 measurement:** `pnpm brain:bench` seeds synthetic data (default 50 k document chunks plus 200 k conversation chunks with mock embeddings, in place of the spec's 1 M messages), runs 200 mixed queries and reports p50 and p95 for keyword, semantic and hybrid; the numbers go into the gate report with the caveat that they come from a laptop.

## 8. Brain API (`packages/brain-api`)

Fastify 5 with zod schemas on every route (`fastify-type-provider-zod`); `@fastify/swagger` produces `openapi.json`, and `pnpm brain:api-docs` renders it to `docs/brain/API.md` (CI fails when the file is stale). Port `BRAIN_API_PORT` (9120); `/healthz`, `/readyz` (database, Mattermost reachable, embedding provider configured or disabled) and `/metrics` as the other services.

Authentication:

- Browser sessions: `GET /auth/login` redirects to Mattermost's `/oauth/authorize`; `GET /auth/callback` exchanges the code at `/oauth/access_token`, reads `GET /api/v4/users/me` with the token to learn the user id and roles, discards the token, and sets an HttpOnly, SameSite=Lax cookie signed with `BRAIN_SESSION_SECRET` (12 h). Non-GET calls from the browser must carry `X-Requested-With: XMLHttpRequest` (as Mattermost requires). `POST /auth/logout` clears it. The OAuth app (trusted, so no consent screen) is created by the installer and its client id and secret live in the key store.
- Service token: `Authorization: Bearer $BRAIN_API_TOKEN` (generated at install; replaces `ADMIN_API_TOKEN`).
- Mattermost callbacks (`/mm/commands/{name}`, `/mm/dialogs/{name}`, `/mm/actions/{name}`): the command token Mattermost issued at registration (key store, timing-safe compare); dialog and button callbacks carry a state we signed when we created them.

Routes under `/api/v1/brain` (the spec's names where they exist; Phase 1 adds `POST /projects` and `POST /topics` as the channel-creating wrappers):

| Area | Routes |
| --- | --- |
| Session | `GET /me` |
| Containers | `GET /containers?kind=&status=&q=`, `POST /containers` (kind, title, slug, data, optional channel to link), `GET /containers/{id}`, `PATCH /containers/{id}` (new version), `POST /containers/{id}/archive`, `GET /containers/{id}/entities?type=&status=`, `POST /containers/{id}/channels` (link a channel: role, enables capture), `DELETE /containers/{id}/channels/{channelId}` |
| Entities | `GET /entities?type=&container=&status=&owner=&from=&to=&q=`, `POST /entities`, `GET /entities/{id}`, `PATCH /entities/{id}` (new version with actor and source), `POST /entities/{id}/archive`, `GET /entities/{id}/versions`, `GET /entities/{id}/versions/{n}`, `GET /entities/{id}/backlinks`, `GET /entities/{id}/links?kind=` |
| Links | `POST /links`, `DELETE /links/{id}` |
| Search | `GET /search?q=&container=&type=&person=&from=&to=&limit=` |
| Audit | `GET /audit?entity=&container=&actor=&from=&to=` (admins) |
| Export (NFR-9) | `GET /export/manifest`, `GET /export/{table}.jsonl` for containers, entities, entity_versions, links, chunks (text and anchors; `?embeddings=1` adds vectors), audit_log; `pnpm brain:export <dir>` writes them all. JSON Lines, documented in `docs/brain/export-format.md`; files follow in Phase 1. |
| Agents and channels (moved from the admin API, D43) | `GET /agents`, `POST /agents`, `POST /channels/{id}/enable`, `POST /channels/{id}/agents`, `DELETE /channels/{id}/agents/{handle}` |
| Mattermost callbacks | `POST /mm/commands/brain`, `POST /mm/dialogs/{name}`, `POST /mm/actions/{name}` (outside `/api/v1/brain`) |
| Meta | `GET /openapi.json`, `GET /features` (which flags are on, for the pages) |

Every write returns the new version; every error is `{ error, code }`; request ids are logged and stored on audit rows. Bodies are capped (64 KiB JSON; uploads come in Phase 1).

## 9. Model providers (`packages/models`)

- `LlmProvider` as today, moved; `AnthropicProvider` unchanged; `GeminiProvider` through `@google/genai` with the same prompt discipline (instructions in the system prompt, chat and passages as quoted data). Tool use is designed in (a `tools` loop with typed tool calls and results on both providers) and exercised by unit tests against a fake transport; the real tools arrive in Phase 2.
- `EmbeddingProvider.embed(texts) → vectors` with `gemini` (1536 dimensions, batched, truncating inputs to the model's limit) and `mock` (deterministic bag-of-words hashing into 1536 dimensions, so tests have stable, meaningful similarity).
- Provider and model per agent: `runtime.agents` gains `provider` (`anthropic` | `google` | `echo`); defaults `LLM_PROVIDER`, `LLM_MODEL`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` in the installation config. Model ids stay configuration (D21); the defaults are chosen from the providers' current lists during spike B6.
- A price table (`prices.json`, overridable by `MODEL_PRICES_JSON`) gives `cost_usd` per call for NFR-7 later; Phase 0 records usage per call in the logs and metrics.

## 10. UI entry points

**Pages (`packages/brain-web`)**, served at `BRAIN_PUBLIC_URL` (locally `http://localhost:9120`):

| Page | Shows |
| --- | --- |
| `/` | Sign-in state, the search box, recent entities and containers the person can see |
| `/search?q=` | Hybrid results with filters (container, type, person, date), each with its citation link (opens the Mattermost post or the entity) |
| `/containers`, `/containers/:id` | Projects and Topics; a container's summary, linked channels, entities by type, recent conversations (the Phase 1 home pages grow from this page) |
| `/entities/:id` | Fields, text, container, versions (with a diff of `data` between two versions), links and backlinks |
| Sign-in | One button: "Sign in with Enterprise Brain chat" (Mattermost OAuth) |

Every string lives in `packages/brain-web/src/i18n/en.json` (FormatJS); a unit test fails on a missing key (NFR-10). Colours and the mark come from `branding/`.

**In chat:**

- `/brain search <text>` answers with an ephemeral list of results and links to the pages; `/brain link` opens a dialog to attach the current channel to a Project or Topic (a select of the containers the person can see) and confirms in the channel; `/brain help`. The command is registered per team by the installer and the seed; its callbacks prove the command, dialog and button paths that Phase 1's `/project` and `/topic` reuse.
- When a channel is linked, `@brain` posts and pins a short message with the link to the container page (channel bookmarks need a licence, spike B1; D57).

**ChatClient additions** (all through `packages/shared`, rule 6): `createChannel`, `patchChannel`, `getTeamChannels` (public and private, admin), `getUserTeamChannels`, `getFile`, `createEphemeralPost`, `pinPost`, `listCommands`, `createCommand`, `updateCommand`, `openDialog`, `createOAuthApp`, `exchangeOAuthCode`, `patchConfig`, `createDirectChannel` (used from Phase 2, added with its test now only if a Phase 0 test needs it).

## 11. Feature flags and configuration (D55)

New variables in `.env.example`, the install config and staging:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAIN_FEATURE_API` | `true` | The brain API and pages (everything in this plan) |
| `BRAIN_FEATURE_CHAT_COMMANDS` | `true` | Register and answer `/brain` |
| `BRAIN_FEATURE_SEMANTIC_SEARCH` | `auto` | `auto`: on when `GOOGLE_API_KEY` is set; `true` requires a provider; `false` keyword only |
| `BRAIN_CAPTURE_CHANNELS` | `all` | `all` / `public` / `opt-in` (D50) |
| `CAPTURE_SWEEP_SECONDS` | `60` | How often the bridge looks for new channels |
| `BRAIN_API_PORT`, `BRAIN_PUBLIC_URL`, `BRAIN_INTERNAL_URL` | `9120`, `http://localhost:9120`, `http://brain-api:9120` | Where the pages are and where Mattermost calls back |
| `BRAIN_API_TOKEN`, `BRAIN_SESSION_SECRET` | generated | Service token; cookie signing key |
| `GOOGLE_API_KEY`, `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | empty, `anthropic`, `auto`, (from B6) | Providers (D53, D54) |
| `BRAIN_TIMEZONE` | `Europe/Istanbul` | For later schedules (R14); read now so installs set it from day one |

Later phases add `BRAIN_FEATURE_PROJECTS`, `_PEOPLE`, `_SYSTEMS`, `_DOCUMENTS`, `_TASKS`, `_ANALYST`, `_VAULT`, `_PACKAGES`, `_CONNECTORS`, `_MEETINGS`, each off by default and on for Infinics.

## 12. Clean install (NFR-12)

Goal: a new customer installation from a clean machine with Docker Engine and Compose v2, git, and nothing else, in under one hour, with one documented command set.

```
install/
  README.md              the install guide: prerequisites, the four commands, where the admin password is, TLS, backups, upgrades
  compose.yml            the production stack: Enterprise Brain chat, its Postgres, the relay with its Postgres, Redis and S3 store,
                         state-postgres (pgvector), bridge, agent-runtime, ingestion, brain-api; optional Caddy for TLS (profile `tls`)
  config.example.env     every setting with a comment; secrets empty and generated by `init`
  brain                  bash wrapper around docker compose and the installer container:
                         ./install/brain init | up | status | logs [service] | seed | down [--wipe] | export <dir>
  test.sh                the clean-install test (below)
scripts/install/         the installer, run inside our services image (no Node on the host): generate secrets into config.env
                         (the existing resolveEnv generators), wait for Mattermost, create the admin, team and @brain bot,
                         tokens, the OAuth app, the /brain command per team, AllowedUntrustedInternalConnections and SiteURL,
                         then print the URLs and where the credentials are
```

The four commands in the guide: `git clone …`, `cp install/config.example.env install/config.env` and edit the domain lines, `./install/brain init`, `./install/brain up`. TLS: Caddy with automatic certificates when `DOMAIN_CHAT` and `DOMAIN_BRAIN` are set (a pinned image; it is new, so it is in section 20 for the owner's nod). Local development keeps `pnpm dev:up` and `pnpm dev:seed`, which gain the same brain steps.

`install/test.sh` is the gate's first half: on a clean machine or CI runner it runs `init`, `up`, waits for `/readyz` of every service, creates a container and an entity through the API with the service token, searches for the entity's words and asserts a hit within 5 s, checks `/brain` is registered in Mattermost, exports the store and compares counts, then `down --wipe`. It prints the elapsed time (the one-hour budget).

## 13. CI and the secret check

- `pnpm check:secrets`: scans the tracked files, fixtures and a test-output directory for private-key blocks, provider key shapes (`sk-ant-`, `AIza…`, `ghp_`, `github_pat_`, `xox…`, `AKIA…`), JWTs, and every value from `.env` and the key store when they are available (the existing `check:logs` logic), with an allow-list file for deliberate false positives; fixtures use secrets that start with `FAKE-`. Fails the build on a hit.
- `.github/workflows/ci.yml`: typecheck, lint, unit tests, `check:secrets`, `brain:api-docs --check`; a second job runs the e2e suite on the local stack (`pnpm dev:up --enterprise-brain && pnpm dev:seed`) and `check:logs` over its logs; a third, on demand and nightly, runs `install/test.sh`. CI needs this repository on GitHub (section 20).

## 14. Tests

| Test | Kind | Covers |
| --- | --- | --- |
| Repository writes bump versions, write version and audit rows, refuse audit updates and deletes | unit (Postgres in e2e config) | spec section 3 rules, section 7 audit |
| Access filter: admin, member, non-member, public channel, General | unit + e2e | FR-9.5 |
| Chunker and anchors; mock embeddings deterministic; RRF scoring | unit | FR-9.2 |
| Create container and entity through the API → `GET /search` hits within 5 s (keyword), and within 5 s on the semantic path with the mock provider | e2e | **gate**, FR-9.1, FR-9.2 |
| A thread in a linked channel becomes a conversation entity in that container, found by search with a post citation; a thread in an unlinked channel lands in General | e2e | FR-1.10 (attribution), FR-9.1 |
| Links and backlinks between two entities and a container | e2e | FR-9.4 |
| A private channel's conversation: hidden from bob's session, visible to alice (member) and to sysadmin | e2e | FR-9.5 |
| `/brain search` executed through Mattermost (`POST /api/v4/commands/execute`) reaches the API and answers; `/brain link` opens a dialog and the submission links the channel and adds the bookmark | e2e | section 10, spikes B1–B2 |
| Capture: a new public and a new private channel get `@brain` within the sweep; a channel `@brain` was removed from stays out | e2e | D50 |
| Ingestion suite B.5 tests 1–5 unchanged on the new store; agent answers still cite sources | e2e (existing) | regression |
| Admin routes moved: existing `admin-api.e2e.test.ts` against `brain-api` | e2e (existing) | D43 |
| Export: every table exported, counts match, no embedding by default | e2e | NFR-9 |
| OAuth sign-in: a test client completes the flow and `GET /me` returns alice | e2e | section 8 |
| `en.json` has every key the pages use | unit | NFR-10 |
| `.env.example` lists every configuration variable the services read | unit | CLAUDE.md rule 9 |
| `check:secrets` finds a planted key and ignores allow-listed fixtures | unit | section 13 |
| `install/test.sh` on a clean runner | install | **gate**, NFR-12 |
| `pnpm brain:bench` | benchmark | NFR-1 |

## 15. Observability

`brain-api` exposes request counts and latencies per route, search latency by mode, embedding queue depth and provider latency, audit rows written, sign-ins, callback verification failures. Logs carry request ids and never query text, tokens or cookies (pino redaction extended with `cookie`, `set-cookie`, `code`, `client_secret`).

## 16. Staging

`pnpm staging:railway` gains: `state-postgres` built from the pgvector Dockerfile (same volume and data), a `brain-api` service with a public domain (needed for sign-in redirects and the pages), the new variables, and the installer's Mattermost steps (OAuth app, `/brain` command, allowed internal connections) run through a sandbox as `pnpm staging:agent` does today. `pnpm staging:agent` calls the moved agent routes.

## 17. Documentation

`docs/architecture.md` (new components and flows), `docs/operations.md` (brain-api endpoints, worker metrics, export), `docs/staging.md`, `CLAUDE.md` (commands, layout, the fence), `.env.example`, `docs/brain/CHANGELOG.md` (created with this phase), `docs/brain/API.md` (generated), `docs/brain/export-format.md`, `install/README.md`, and new entries in `docs/decisions.md` and `docs/spike-findings.md` as the spikes report.

## 18. Task list

In order; each task ends with its tests green and its docs updated. Ids are used in commit messages together with the FR/NFR ids.

| # | Task | Spec ids | Done when |
| --- | --- | --- | --- |
| T0.1 | Spikes B1–B6 (section 3) | NFR-12, FR-9.2 | Results in `docs/spike-findings.md`; any failed assumption has an agreed alternative |
| T0.2 | `infra/state-postgres/Dockerfile` with pgvector (pinned), Compose and staging Dockerfile switched, migration 0003 | FR-9.2 (D52) | Fresh stack and existing local data both start; `vector` installed |
| T0.3 | `packages/models`: move providers, add Gemini (chat with tool loop) and embeddings (Gemini, mock), prices | spec section 5, decision 2 (D53, D54) | Unit tests on fake transports; agent-runtime unchanged in behaviour (its e2e passes) |
| T0.4 | `packages/brain`: migrations 0004–0005, repositories, chunker, access policy, hybrid search, export, `PostgresBrainClient` on the new store | FR-9.1, 9.2, 9.4, 9.5; NFR-9 | Unit tests; ingestion and agent e2e suites pass on the new store |
| T0.5 | Ingestion: conversation entities with anchors, visibility and container attribution; purge updated | FR-1.10, FR-9.1 | e2e B.5 unchanged plus the attribution test |
| T0.6 | Bridge: capture of every channel (`BRAIN_CAPTURE_CHANNELS`, sweep, opt-out reporting) | D50 | Capture e2e |
| T0.7 | `ChatClient` additions with their tests | rule 6 | Used by T0.8–T0.10 |
| T0.8 | `packages/brain-api`: app, config and flags, auth (sessions, service token, callback tokens), routes, OpenAPI → `API.md`, events, audit, admin routes moved; `pnpm brain-api` | FR-9.1, 9.4, 9.5; NFR-9 | API e2e tests; `admin-api` e2e moved and green |
| T0.9 | Embedding worker, semantic search path, `pnpm brain:bench` | FR-9.2; NFR-1 | Semantic e2e with the mock provider; bench numbers recorded |
| T0.10 | `/brain` command, dialog and action callbacks, bookmark, registration in seed | section 10 | Command e2e through Mattermost |
| T0.11 | `packages/brain-web`: pages, sign-in, catalog, build into the services image | Phase 0 deliverables (pages, search box); NFR-10 | Pages served by `brain-api`; catalog test; owner's manual check on staging |
| T0.12 | `install/` bundle, installer, `install/test.sh`, `install/README.md` | NFR-12 | Test passes on a clean VM or runner within the hour |
| T0.13 | `check:secrets`, CI workflow, `API.md` freshness check | spec section 12 rules | Workflow green on the GitHub repository |
| T0.14 | Staging: pgvector database, `brain-api` with public domain, variables; docs of section 17; `CHANGELOG.md` | — | Owner can open the pages on staging and run `/brain search` |
| T0.15 | Gate run and `docs/brain/gates/phase-0.md` | gate; NFR-1, 9, 12 | Report written, with what was not verified |

Dependencies: T0.1 before T0.2, T0.8 and T0.10; T0.2–T0.4 before T0.5 onward; T0.8 before T0.9–T0.11; T0.12 after T0.11; T0.13 when the repository is on GitHub.

## 19. Gate procedure (`docs/brain/gates/phase-0.md`)

1. Clean install: `install/test.sh` on a fresh machine (a new Colima VM, or the CI runner), elapsed time recorded.
2. Searchable within 5 s: the e2e gate test, run ten times on the local stack and once on staging through the public API, p95 of the time from creation to first hit.
3. NFR-1: `pnpm brain:bench` figures (keyword, semantic, hybrid p95) at 250 k chunks, with the data caveat.
4. NFR-9: an export of the local stack, re-imported into an empty database by `pnpm brain:export --verify` (round trip of counts and ids).
5. Section 10 acceptance test: not applicable until Phase 3; noted as such.
6. What was not verified, and the owner's manual checks on staging (the pages, `/brain search`, `/brain link`).

## 20. What I need from the owner

1. **Approval of this plan.** Details that turn out differently during the spikes are reported in the phase report and the gate file; anything that changes the data or container model comes back as a question.
2. **A GitHub repository for this code** (the main repository has no remote yet), so the CI checks the spec asks for can run: I recommend a private repository `tintin222/enterprise-brain`. Without it, the checks run locally only.
3. **A public address for the brain's pages on staging** (a Railway domain on the new `brain-api` service, like Mattermost's). Needed for sign-in and for your manual checks.
4. **A Google AI API key**, when convenient: optional for the gate (keyword search needs none), needed to see semantic search and to run spike B6 for real.
5. **Caddy for TLS in the install bundle** (one more pinned image, used only on customer installs with a domain): recommended; say no and the guide documents an external reverse proxy instead.
