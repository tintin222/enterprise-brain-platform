# Company Brain: gap analysis (Step 1)

Audit of this codebase against `docs/COMPANY_BRAIN_SPEC.md`, as its section 12 asks. Written on 2026-10-12 against commit `6ea2e31` of this repository, release `eb-v11.11.1-1` of our Mattermost build (fork commit `549e445`, Mattermost 11.11.1), Buzz relay 0.2.1 and Postgres 17.11. No code was changed for this step.

How the facts were gathered: the docs and code of this repository; the running local stack (the state database was queried for its available extensions); and the fork's source for Mattermost behaviour, with file references below. Statements marked *(to verify)* come from memory of Mattermost's documentation and get a spike in Phase 0 before anything depends on them.

## 0. Summary

- The "clone" is not one modified Mattermost. It is our own Mattermost build (branding, no user limit, no upgrade offers; nothing else changed) plus a Buzz relay and four services of ours (bridge, agent-runtime, ingestion, admin API) with their own Postgres. Brain logic was deliberately kept out of the Mattermost process (D1, D3; the licence boundary a lawyer confirmed, decisions section 5). The spec's "hook into the clone" items therefore map to Mattermost's integration surfaces (slash commands, dialogs, buttons, bots, OAuth, plugins) and to our services, not to server code.
- Reusable now: the chat capture pipeline (every message of an enabled channel becomes a signed relay event and, within 30 s, a thread document with a permalink), the agent runtime (registry, dispatcher, job queue, context assembly, Anthropic provider, prompt safety), agent provisioning and the admin API, the key store (AES-256-GCM under a master key, rotation), config/logging/metrics/health conventions, the e2e harness, the staging setup and the services image.
- Missing: the whole knowledge model (containers, entities, versions, links, chunks, audit), the brain API and its UI, vector search (the database has no `pgvector`), a second model provider, embeddings, tool use, playbooks, proposals, traces, a scheduler, documents and their storage, the vault layer above the key store, connectors, meetings, packages, the MCP server.
- Six points conflict with how the clone is built or with its rules; section 9 lists them with a recommended resolution each. Nothing in the spec's section 13 is reopened.

## 1. What the clone is today

| Component | Where | What it does | Change allowed? |
| --- | --- | --- | --- |
| Enterprise Brain chat (Mattermost 11.11.1) | fork `tintin222/enterprise-brain-chat`, image `infra/chat/Dockerfile` | Chat for people: teams, channels, threads, files, web/desktop/mobile clients. Our changes: no user limit, our name and logo, no Enterprise upgrade or trial offers (D48). | Only in the fork, kept minimal, published under AGPL (CLAUDE.md rule 4). |
| Buzz relay 0.2.1 | `infra/compose.yml` | Internal signed event log (Nostr) with channels, per-identity membership, audit chain. Agents and ingestion read it. | Unmodified upstream, pinned (D2, D12). |
| bridge | `packages/bridge` | Mirrors channels where `@brain` is a member into the relay and agent messages back (edits, deletions, reactions, membership, metadata, backfill, reconciliation, dead letters). | Ours. |
| agent-runtime | `packages/agent-runtime` | Registry, dispatcher (mentions), Postgres job queue, context assembly, `LlmProvider` (Anthropic, echo), reply publishing, typing. | Ours. |
| ingestion | `packages/ingestion` | Relay to thread documents in the local brain, debounced, with edits, deletions, purges and access facts. | Ours. |
| admin API | `packages/agent-runtime/src/admin-api.ts` | Create agents, enable channels, add agents to channels (bearer token, private). | Ours. |
| state database | Postgres 17.11, database `brain` | Schemas `identity`, `bridge`, `runtime`, `ingestion`, `brain`. | Ours (CLAUDE.md rule 5: never Mattermost's or Buzz's database). |
| Staging | Railway project `enterprise-brain-staging` (`docs/staging.md`) | All of the above; only Mattermost is public. | Ours. |

## 2. Stack, database, auth, storage, jobs, search, entity model

### 2.1 Stack

- TypeScript on Node 24.21.0 (pnpm provisions it), pnpm 12.9.1 workspaces (`packages/shared`, `bridge`, `agent-runtime`, `ingestion`, `scripts`, `e2e`), TypeScript 6.0.3, ESLint 10 with type-aware rules (rule 6 enforced by `no-restricted-imports` for the three services), vitest 5 for unit and e2e tests, tsx (no build step). Every dependency is an exact version and must be at least 7 days old (`minimumReleaseAge`).
- Runtime dependencies today: `pg` 8.23.1, `zod` 4.6.5, `pino` 10.4.0, `prom-client` 15.1.3, `nostr-tools` 2.25.2, `@anthropic-ai/sdk` 0.131.0. `ChatClient` is plain `fetch` plus Node's WebSocket (D23).
- One container image for all our services (`infra/services/Dockerfile`, `node:24.21.0-trixie-slim`, production dependencies only; the command picks the program). Local stack: Docker Compose on Colima; staging: Railway with the same image.
- Conventions already in place that the brain should follow: config from the environment validated with zod (`parseConfig`), JSON logs with secret-field redaction, Prometheus metrics, `/healthz` and `/readyz` per service, SQL migrations per schema applied at start under an advisory lock (`packages/shared/src/db.ts`), e2e tests against the local stack (`e2e/lib/harness.ts`), `pnpm check:logs` scanning logs for every known secret.

### 2.2 Databases

Three Postgres 17.11 instances from one pinned Alpine image (`postgres:17.11-alpine3.24`): Mattermost's, Buzz's and ours. Our code never connects to the first two (rule 5), so "never modify core messaging tables" is already structural: the brain cannot reach them.

Our database (`brain`, user `brain`, `localhost:5433` locally, `state-postgres.railway.internal` on staging) holds:

| Schema | Tables | Owner |
| --- | --- | --- |
| `identity` | `secrets` (key store), `identities` (Mattermost user ↔ Nostr key, kind person/agent/service) | shared (D19, D24) |
| `bridge` | `channel_map`, `message_map`, `reaction_map`, `relay_outbox`, `cursors`, `dead_letter` | bridge |
| `runtime` | `agents`, `jobs` | agent-runtime |
| `ingestion` | `cursors`, `messages`, `threads`, `pending`, `seen_changes`, `exclusions` | ingestion |
| `brain` | `channels`, `documents` (thread documents with a generated `tsvector`) | the local brain (D34) |

Extensions available on the running state database today (`pg_available_extensions`): `pg_trgm` 1.6, `pgcrypto` 1.3, `unaccent` 1.1. **`vector` is not available** (section 5).

### 2.3 Authentication and authorization

| Who | How today | Notes |
| --- | --- | --- |
| People | Mattermost email and password sessions, Team Edition behaviour (D22) | SSO (SAML, OpenID Connect, LDAP, Google and Office 365 OAuth), guest accounts, data retention and compliance export are licence-gated in Mattermost's code: `server/public/model/license.go` (`Features`), e.g. `api4/team.go:1914` (guests), `app/authentication.go:454` (LDAP). GitLab OAuth is the one free SSO. MFA can be *enabled* without a licence (`app/authentication.go:358-362`), but *enforcing* it needs `license.Features.MFA` (`app/authentication.go:379`). |
| Other web apps | Mattermost is an OAuth 2.0 provider: `ServiceSettings.EnableOAuthServiceProvider`, default true (`server/public/model/config.go:416,626`) | Lets a separate brain web UI sign people in with their Mattermost account. Apps are created by an admin (`PermissionManageOAuth`). The flow was not exercised yet *(to verify)*. |
| The bridge | `@brain` bot (system admin) with a bot access token (`MM_BRIDGE_TOKEN`) | Its channel membership is the capture opt-in (D5). |
| Agents | Bot account plus bot token per agent, Nostr key per agent; both in the key store (D19) | Provisioning uses an admin user's personal access token because bots cannot create bots (D25). |
| Services on the relay | NIP-42 (WebSocket) and NIP-98 (HTTP) with per-identity keys; relay membership required (`BUZZ_REQUIRE_RELAY_MEMBERSHIP`, `BUZZ_REQUIRE_AUTH_TOKEN`, D16) | Rate limits per key (D20). |
| Brain product → admin API | Bearer token `ADMIN_API_TOKEN` (≥ 32 characters, timing-safe compare), bound to 127.0.0.1 or the private network | No per-user identity; one shared token. |
| Operations endpoints | None (127.0.0.1 or private network only) | Counts and timings only. |

Roles: Mattermost's (system admin, team admin, channel admin, member, bot). Ours: identity kinds `person`, `agent`, `service`; agent `status`. There is no per-entity or per-container permission model yet; the only access rule is retrieval scope by channel visibility (D35).

### 2.4 Storage

- Mattermost keeps uploaded files on its own volume (`/mattermost/data`; S3 is possible through Mattermost's configuration) and exposes them through `GET /api/v4/files/{id}` to channel members.
- The relay stores media in Silo (S3-compatible); we do not use it (D30: attachments stay Mattermost permalinks).
- Our database stores text and JSON only. There is no blob store of our own. Documents (FR-5) need one: a volume or an S3-compatible bucket (Phase 1 decision).

### 2.5 Jobs, queues and scheduling

All queues are Postgres tables, which fits the spec's single-node installation:

| Mechanism | Where | Behaviour |
| --- | --- | --- |
| Agent jobs | `runtime.jobs` (`packages/agent-runtime/src/jobs.ts`) | One row per (agent, triggering event), unique; statuses pending/running/done/failed/skipped; `JOB_CONCURRENCY` (4); one job at a time per agent and thread; open jobs resume after a restart; failed jobs get an apology reply. |
| Thread indexing | `ingestion.pending` | Debounced per thread (`INGEST_DEBOUNCE_SECONDS` 30, measured from the first change), retried after 30 s on failure, survives restarts. |
| Relay publishing | `bridge.relay_outbox`, `bridge.dead_letter` | Signed events retried as-is; dead letters listed and replayed with `pnpm dead-letter`. |
| In-process | `KeyedQueue`, `CoalescedTask`, `RateLimiter` (`packages/shared/src/async.ts`) | Per-channel ordering, coalesced catch-ups, per-key throttles. |
| Timers | catch-up (300 s), reconciliation (300 s), agent refresh (30 s) | Interval timers inside each service. |

Missing: a wall-clock scheduler (hourly sweep, "digest by 08:00 local", nightly package builds, stale-project checks, rotation reminders). The pattern (a table with `run_at`, claimed with `FOR UPDATE SKIP LOCKED`) is a small addition in the same style.

### 2.6 Search

- Keyword search exists: `brain.documents.search` is a generated `tsvector` (`english`, channel name plus text) with a GIN index; the query ORs the stemmed words of the question, ranks by cover density (`ts_rank_cd`) and returns fragments (`ts_headline`) for long documents (`packages/shared/src/brain-postgres.ts`). Scope: the asking channel plus active open channels (D35).
- No vectors, no embeddings provider (D34 records why: Anthropic has no embeddings API), no hybrid ranking, no filters by person, type or date, no backlinks.
- The relay has its own full-text search (NIP-50); we do not use it.
- Measured: a new thread is indexed within the debounce (load test p95 30.8 s at 5 messages per second), so NFR-2 (2 minutes) already holds for chat. NFR-1 (hybrid p95 under 1.5 s at 1 M messages and 50 k chunks) needs the vector index and a measurement.

### 2.7 Entity model today

Everything the services know, in one place:

| Table or source | Holds | Spec entity it approximates |
| --- | --- | --- |
| Mattermost users, teams, channels, posts, files (API only) | People's accounts, channel structure, messages, attachments | Person (account part), Conversation (raw), Document (raw file) |
| `identity.identities` + key store | Mattermost user ↔ Nostr key, kind, relay membership, profile hash | Person and Agent identity |
| `runtime.agents` | handle, display name, instructions, model, tools allow-list, knowledge scope, bot id, pubkey, status | Agent |
| `bridge.channel_map` | Mattermost channel ↔ relay channel, team, visibility, state (active/paused/archived), metadata hash | the channel behind a Topic |
| `brain.channels` | name, visibility, active, per relay channel | access facts for retrieval |
| `brain.documents` + `ingestion.messages/threads` | one document per thread (or chunk of a long thread): rendered text, authors, time range, permalink, event ids | Conversation (chat), already chunked |
| Relay events (kinds 9, 40003, 5, 7, 39000, 39002, 0) | Signed messages with `mm` post id and `mm_ts`, edits, deletions, reactions, channel metadata, members, profiles | the raw payload and external ids the spec's ingestion rules ask for (kept in the relay, not copied) |

## 3. Mapping the spec's entities (section 3) to what exists

| Spec entity | Exists today | Reuse | Must be added |
| --- | --- | --- | --- |
| Project | Nothing | — | `containers(kind=project)`; channel group creation through `ChatClient` (it has no `createChannel` yet; scripts do); timeline, stale flag, archive. |
| Topic | The enabled channel: `bridge.channel_map` and `brain.channels` | Channel enablement (admin API `POST /channels/{id}/enable` → the bridge), deterministic relay channel id (`relayChannelIdFor`, D18), its thread documents | `containers(kind=topic, channel_id)`; `/topic here` and `/topic new`; linking the channel's conversations to the Topic (section 4). |
| Person | Mattermost account; `identity.identities` (key, kind); relay profile | Account, identity, display names (`ProfileNames`) | `entities(type=person)` with role, organisation, expertise, responsibilities, hours, contact channel, manager; external contacts without an account (mail addresses); role-in-project links; expertise ranking. |
| System | Nothing | — | Entity, environments, repos, schemas, API specs, integration map, inventory; versions and diffs (Phase 1). |
| Requirement | Nothing | — | Entity with status machine, MoSCoW, acceptance criteria, sources, confirm action, export (Phase 2). |
| Document | Mattermost file infos on posts (`metadata.files`, `file_ids`); permalink appended to mirrored text (D30) | File ids and permalinks as source links | Entity, blob storage, versions by name, text extraction and OCR, chunks and embeddings, "use as context", confidential flag with logged access (Phase 1). |
| Credential | Key store: `identity.secrets`, AES-256-GCM under `KEY_ENCRYPTION_KEY` with the ref as associated data, key versions, master-key rotation (`packages/shared/src/key-store.ts`, `pnpm keys:rotate-master`) | The encryption, rotation and "decrypt only in memory" discipline; `check:logs` | Envelope layer (per-secret data keys wrapped by the master key; master key from a sealed file or KMS as well as the environment), handles, scopes, grants, access log, expiry, chat scanner, MFA check on reveal (Phase 3). |
| Task | Nothing | — | Entity, boards, "my tasks", reminders, proposals that become tasks (Phase 1, Phase 4). |
| Decision | Nothing | — | Entity, `/decide` draft from a thread, supersedes links, logs (Phase 2). |
| Conversation | `brain.documents` thread documents, produced live by ingestion with edits, deletions, debounce, chunking, purges | The whole chat path; ingestion is the natural producer of `conversation` entities and their chunks | `entities(type=conversation)` rows and chunks written by ingestion (one capture path), container attribution (Topic, Project channel or "General"), mail and meeting conversations as new producers into the same tables, message-level anchors for citations. |
| Meeting | Nothing | — | `MeetingProvider` interface, `manual` and `mock`, registry of `teams`/`google_meet`/`zoom` as not implemented, import endpoint, `/meeting new` (Phase 4). |
| Package | Nothing | — | Builder, manifest, diff, zip, Git push, MCP server (Phase 3). |
| Agent | `runtime.agents`, provisioning (bot + token + relay identity), admin API, dispatcher, context assembly, prompt safety (`docs/security-review.md`) | All of it | `agent_kind` (analyst, follow-up, packager), versioned playbooks and templates, provider and model per agent, typed tool layer, `agent_runs` traces with cost, proposals, per-project `agent_note`, cost cap. |
| Links, versions, audit | Nothing (the relay's hash-chained log covers chat events only) | — | `links`, `entity_versions`, append-only `audit_log` (Phase 0). |
| Chunks | Thread chunking in ingestion (`INGEST_CHUNK_CHARS` 6000, one-message overlap) | The chunker's rules | `chunks` table with `tsvector` and `vector(1536)`, hybrid query (Phase 0). |
| Sources, connectors | Relay events carry `mm` post id and `mm_ts`; ingestion keeps cursors | Chat as the built-in connector | `sources`, `connectors`, health, matching queue (Phase 4). |

Names: the spec's section 9 says to adapt names to the clone's conventions. Ours are: one schema per owner (the brain's tables go in schema `brain`), `snake_case`, `text` ids, `timestamptz`, `jsonb`, migrations as numbered SQL files, each table commented with the decision it implements.

## 4. How a channel becomes a Topic

Verified mechanics:

1. A channel is captured when `@brain` is a member (D5). The admin API already does this through Mattermost's public API (`POST /channels/{id}/enable` adds the bot; `packages/agent-runtime/src/admin-api.ts:116-122`), and the bridge then creates the relay channel, mirrors members and history, and ingestion starts indexing. Only open and private channels qualify (`channels.ts:63-67`); direct and group messages are not mirrored (Q5).
2. The relay channel id is derived from the Mattermost channel id (UUIDv5, D18), so a Topic row can point at the Mattermost channel and still find every thread document of that channel (`brain.documents.channel_id` is the relay id) without waiting for the bridge.
3. Nothing in Mattermost's own tables changes. The promotion is a row in our database: `containers(kind='topic', channel_id=<Mattermost channel id>)`, unique per channel.

Proposed flow for `/topic here` (Phase 1; the container table itself is Phase 0):

1. Mattermost posts the slash command to the brain API with `user_id`, `channel_id`, `team_id`, `trigger_id` (section 6.3).
2. The brain API opens an interactive dialog (name, kind internal/external, organisation, owner, description) with that `trigger_id`; the submission comes back to the brain API.
3. It creates the Topic container, enables the channel (adds `@brain`), adds the configured agent bots, and links the channel's existing and future conversations to the Topic (ingestion attributes thread documents of a channel to the container that owns the channel; channels owned by nobody go to "General", FR-1.10).
4. It confirms in the channel as `@brain` and adds a channel bookmark to the Topic page (Mattermost's bookmark API exists: `api4/channel_bookmark.go:20-23`).

Project channels (FR-1.2) are created by the brain API through `ChatClient` and recorded on the project container; linking an existing channel to a project is a link, and the channel is enabled the same way. Archiving a channel in Mattermost pauses mirroring (D28); the container keeps its history and gets state `archived`.

## 5. Vector search

**The database does not support vector search today.** `vector` is not in `pg_available_extensions` on the pinned `postgres:17.11-alpine3.24` image (checked on the running state database and, for completeness, on the Mattermost and Buzz databases, which we would never use anyway). `pg_trgm` and `unaccent` are available.

Options, least invasive first:

| Option | What changes | Pros | Cons |
| --- | --- | --- | --- |
| A. Build pgvector into our state-database image | New `infra/state-postgres/Dockerfile`: the same pinned Alpine image, pgvector compiled at a pinned release in a build stage and copied in; staging's `infra/staging/postgres/Dockerfile` becomes the same two-stage build; a migration runs `CREATE EXTENSION vector` | Same base image, locale and data directory (existing local and staging data keep working); same healthcheck; one extension, no new service | A compile step on first build (about a minute); the build needs pgvector's documented Alpine build dependencies |
| B. Switch our state database to the pgvector project's image (`pgvector/pgvector:pg17`, Debian) | One image reference in `infra/compose.yml` and the staging Dockerfile | Simplest Dockerfile; maintained upstream | Different base (glibc vs musl): the existing local and staging data directories would need a dump and restore (collation differs); a second Postgres image to keep pinned |
| C. No extension: keyword search only, vectors as float arrays compared in the service | Nothing in infrastructure | Zero change | No index: 50 k chunks × 1536 floats is about 300 MB in memory per process and a linear scan per query; a dead end for NFR-1 |
| D. A separate vector database | New service | — | Against NFR-6 (single node, simple install) and NFR-9; rejected |

Recommendation: **A**. Keep 1536 dimensions as the spec's schema says, an HNSW index with cosine distance, and hybrid ranking as reciprocal rank fusion of the full-text rank and the vector rank in one SQL query. Mattermost's and Buzz's databases are untouched either way.

Embeddings need a provider (section 7); keyword search keeps working without one, so a clean install without any model key still passes the Phase 0 gate.

## 6. Where to hook

All of these were checked in the fork's source unless marked *(to verify)*.

### 6.1 Message create pipeline

Today: Mattermost → WebSocket events to the `@brain` bot (`posted`, `post_edited`, `post_deleted`, `reaction_*`, `channel_*`, `user_added/removed`; `packages/bridge/src/bridge.ts:342-383`) → bridge signs a relay event with the author's key (`mm` post id, `mm_ts`, mentions as `p` tags) → relay → ingestion (one subscription per channel plus paged catch-up) → thread document within the debounce → `brain.documents`; agent-runtime watches the same stream for mentions.

Hook points:

- **Capture into the knowledge model:** ingestion's indexing step (`Ingestion#flushRun` → `buildThreadDocuments` → `BrainClient.upsertDocuments`). This is where `conversation` entities, their chunks, container attribution and the `conversation.ingested` event belong, so chat keeps one capture path and the existing debounce, edit, deletion and purge handling.
- **Agent triggers:** the dispatcher's trigger rules (`packages/agent-runtime/src/triggers.ts`). Today agents answer mentions only; the Analyst must answer every message in a requirements channel and the Follow-up agent must see every new conversation, so the rules gain per-channel and per-agent-kind policies (plus the hourly sweep from the scheduler).
- **Chat-side effects** (confirmations, proposals, reminders) come from the brain API through `ChatClient`, not from the pipeline.

Latency: a thread document exists within 30 s of the first message (section 2.6), well inside NFR-2. The Phase 0 gate ("searchable within 5 s of creation") applies to entities created through the brain API, which can index synchronously.

### 6.2 File upload pipeline

Mattermost offers no upload hook without a plugin (`FileWillBeUploaded` is a Go plugin hook, `server/public/plugin/hooks.go:34`; `registerFilesWillUploadHook` a webapp plugin hook, `webapp/channels/src/plugins/registry.ts:855`). What exists without one:

- `posted` events and REST posts carry `file_ids` and `metadata.files` (id, name, MIME type, size; `packages/shared/src/chat/types.ts:49-58`); the bridge already reads them (`mm-to-relay.ts:223-224`) and today appends names and a permalink (D30).
- A bot that is a channel member can download the file (`GET /api/v4/files/{id}`, standard channel read permission) *(to verify with the bot token)*.

Hook: when a captured post carries files, the brain fetches the bytes with the `@brain` token (`ChatClient.getFile`, to add), stores them as `document` entities with the post permalink as source link, and runs the same extraction and chunking as uploads through the brain API (FR-5.6). Uploads from the brain's own pages and the mail connector (Phase 4) enter the same pipeline.

### 6.3 Slash commands, forms and buttons

Mattermost's built-in integration features cover the spec's chat commands without a plugin:

| Need | Mattermost feature | Verified in the fork |
| --- | --- | --- |
| `/project`, `/topic`, `/req`, `/interview`, `/decide`, `/task`, `/meeting`, `/package`, `/ask`, `/secret` | Custom slash commands: an admin creates one per trigger word with our URL, POST method and autocomplete text; Mattermost posts `user_id`, `channel_id`, `team_id`, `command`, `text`, `trigger_id`, `token`, `response_url`; the response is ephemeral or in-channel and may carry attachments | `ServiceSettings.EnableCommands` default true (`config.go:422,834`); routes `api4/command.go:17-28`; payload `model/command_args.go`; response `model/command_response.go` |
| Forms (`/project new`, `/topic here`, `/req`, `/secret`) | Interactive dialogs opened with the command's `trigger_id`: text, textarea, select, bool and radio fields; the submission is posted to our URL | `POST /api/v4/actions/dialogs/open` and `/submit` (`api4/integration_action.go:19-22`); element types `model/integration_action.go:793-835`; trigger ids are signed and expire (`model/integration_action.go:664-681`), so the dialog must open as soon as the command arrives |
| Accept, edit, dismiss a proposal; snooze or reassign a task | Message attachments with actions (buttons, selects); a click makes Mattermost call our URL | `POST /api/v4/posts/{id}/actions/{action_id}` (`api4/integration_action.go:17`) |
| Private replies | Ephemeral posts | `POST /api/v4/posts/ephemeral` needs `create_post_ephemeral`, which system admins have (`api4/post.go:29,242`); slash-command responses can be ephemeral without it |

Two conditions:

- Mattermost must be allowed to call the brain API's private address (`brain-api` in Compose, `brain-api.railway.internal` on staging). Mattermost refuses outbound requests to private networks unless `ServiceSettings.AllowedUntrustedInternalConnections` lists the host *(to verify; the setting exists, `config.go:436`)*. The clean-install script sets it.
- The command `token` Mattermost sends is how we know a request came from Mattermost; it is stored in the key store and compared timing-safe, like `ADMIN_API_TOKEN`.

Registration is idempotent (one command per trigger per team) and belongs in the clean-install script and the seed. Commands run in the context of the team they were created in, so an installation with several teams registers them per team.

### 6.4 Side panels and pages

Mattermost's webapp plugin API provides a right-hand sidebar (`registerRightHandSidebarComponent`), channel header buttons, an App Bar icon (`registerAppBarComponent`), post menu actions, custom routes and products (`registerCustomRoute`, `registerProduct`), search components and more (`webapp/channels/src/plugins/registry.ts`). A plugin may be webapp-only (`Manifest.Server` is optional, `server/public/model/manifest.go:213-216`), so none of this needs Go. Loading it needs `PluginSettings.EnableUploads` (default false, `config.go:3635,3657`) or prepackaging it in our fork's image.

What a webapp-only plugin cannot do: call the brain API on the user's behalf by itself, because it has no server to proxy requests and the browser's Mattermost session cookie is bound to Mattermost's origin. Two ways around it:

1. **Separate origin with Mattermost sign-in (recommended):** the brain's pages are a small web app served by the brain API at its own address; people sign in through Mattermost's built-in OAuth 2.0 provider (section 2.3), which gives the brain API a per-user session and the user's Mattermost id, teams and channel memberships for access checks. Chat links to the pages (slash-command replies, channel bookmarks, proposal posts). Later, the webapp-only plugin embeds the same pages in the right-hand sidebar and App Bar.
2. **Same origin behind a reverse proxy:** a proxy in front of Mattermost serves `/brain/*` from the brain API and forwards the Mattermost cookie, which the brain API validates with `GET /api/v4/users/me`. Fewer sign-ins, but every installation needs the proxy, and cookie-authenticated calls carry Mattermost's CSRF rules.

Either way, the pages themselves (project and topic home, entity pages with backlinks, search, task boards) are ours and stay out of the Mattermost process. Rule 4 of CLAUDE.md must be amended by a recorded decision before a plugin (even a display-only one) exists.

### 6.5 Bot and webhook accounts

- `@brain` (system admin bot): capture opt-in, bridge identity, and the natural integration identity for slash commands, dialogs, ephemeral replies and bookmarks.
- Agent bots: created by provisioning (`provisionAgent`), one Mattermost bot plus one relay key each, listed by the admin API. The Analyst, Follow-up and Packager agents are three such agents with an `agent_kind`; new kinds are configuration.
- Admin personal access token: bot creation only (D25).
- Incoming and outgoing webhooks are enabled by default but not needed: capture comes from the WebSocket stream, and outbound webhooks for the spec's events are sent by the brain API.
- Direct messages: a bot can open a DM (`POST /api/v4/channels/direct`) and post in it; today nothing of ours does, and DMs are not mirrored (Q5). Needed for proposals, reminders and digests (section 9, C3).

## 7. Model providers and embeddings

Exists: the `LlmProvider` interface (`packages/agent-runtime/src/llm/types.ts`: instructions, channel context, conversation, knowledge passages, tools; usage and refusal in the result), `AnthropicProvider` (official SDK, model and effort from configuration, refusal fallback, prompt caching), `EchoProvider` for tests, and the prompt rules reviewed in `docs/security-review.md` (chat and passages as quoted data, instructions from the registry only). Tool calls are typed but no tool loop runs (`tools: []`, P4).

Missing: the Google (Gemini) provider, a tool-use loop for both providers over the brain's typed tools, provider and model per agent (today one model string per agent, Anthropic only), cost per run and a monthly cap (NFR-7), run traces (NFR-8), and an embeddings provider. The embedding provider needs the same abstraction with a deterministic `mock` for tests; Anthropic offers no embeddings, so the first real implementation is Google's embedding model (the key the spec's decision 2 brings anyway) or a third party (Voyage) or a local model later for installations that forbid model calls for this data class.

## 8. Risks

| # | Risk | Mitigation or decision |
| --- | --- | --- |
| R1 | Mattermost may refuse to call the brain API on a private address (`AllowedUntrustedInternalConnections`). | First Phase 0 spike; the install script sets the allow-list. |
| R2 | Slash-command and button calls must answer within Mattermost's integration timeout, and trigger ids expire within seconds. | Answer at once (acknowledge, open the dialog), do slow work in a job and reply through `response_url` or a follow-up post. |
| R3 | Redaction (FR-6.5) against the relay's immutability: an edit keeps the original text as a separate event; a deletion hides the event from queries, but whether the relay purges the stored content is unknown. | Redaction deletes the original relay event and republishes the redacted text; ingestion re-indexes (exists). Check the relay's purge behaviour in the Phase 3 spike; if it keeps bytes, document it as an accepted limit or wipe through the relay owner's tools. |
| R4 | Capture is opt-in per channel, so plain channels without `@brain` are invisible to the Follow-up agent. | Conflict C2. |
| R5 | SSO, MFA enforcement, guests and retention are licence-gated (section 2.3); Phase 5's gate asks for SSO. | Phase 5 decision. The OpenID Connect, Google and Office 365 providers and MFA enforcement are open code behind licence checks our fork could lift; SAML and LDAP are not in the repository. Entra and Google through OpenID Connect are the realistic path. |
| R6 | Relay per-key rate limits at NFR-5 scale (2,000 users, 400 containers): onboarding is bound by the bridge key (587 s for 300 channels), reads by the shared reader key. | Measured headroom exists (`docs/load-test.md`); the brain API must read our database, never the relay, so it adds no relay load. |
| R7 | The audit log's "IP" is not available for actions that arrive through Mattermost (slash commands carry user and channel ids only). | Record what Mattermost gives (user, channel, post, command) and the IP for calls to the brain API and pages; say so in the security docs. |
| R8 | The secret scanner covers logs; the spec also wants code, fixtures and test output. | Extend `check:logs` into a CI step over the repository and test output; golden fixtures use fake secrets with a recognisable prefix. |
| R9 | Client form links (Phase 2) and the OAuth redirect need a public address for the brain's pages; today only Mattermost is public on staging. | Give the brain web app its own public domain on staging and a documented reverse-proxy rule on-premises. |
| R10 | Documents need a blob store (volume or S3) and text extraction libraries. | Phase 1 plan; ask then. |
| R11 | Citations must point at the exact message, but thread documents are whole threads. | Chunks carry message anchors (`mm` post ids and permalinks) so a citation opens the right post. |
| R12 | Mattermost's bundled Agents (AI) plugin and Calls stay enabled (Q9); two kinds of "agents" may confuse people. | Revisit Q9 when the brain's agents ship. |
| R13 | More processes to run and install (bridge, agent-runtime, ingestion, brain API with the admin API folded in, scheduler, web app). | One image already runs them all; the clean-install script is a Compose bundle plus one config file (NFR-12). |
| R14 | "Digest by 08:00 local" needs an installation time zone. | One setting in the installation config. |
| R15 | Fork upgrades: our Mattermost build moves with upstream; the integration surfaces used here (commands, dialogs, actions, OAuth, bookmarks) are long-stable APIs. | The upgrade procedure in `docs/operations.md` section 6 plus an e2e test per surface. |

## 9. Conflicts with the current architecture, with a proposed resolution each

These need the owner's answer before the Phase 0 plan (spec section 12: "stop and ask before resolving conflicts"). None reopens a section 13 decision.

### C1. Where the brain lives: the spec assumes it is built into the clone

The spec says "turn the existing Mattermost clone into a Company Brain" and lists pages, side panels, slash commands and pipelines inside the clone. Our rules keep Mattermost unmodified except for branding (D1, D3, CLAUDE.md rules 4 and 5, the lawyer-confirmed licence boundary), and all our logic lives in separate services.

Options:

- **A (recommended).** A new service of ours, `brain-api` (TypeScript, same repository and database, schema `brain`), serving `/api/v1/brain/...`, the MCP server later, and the brain's pages (a small React web app signed in through Mattermost's OAuth 2.0 provider). Chat integration through Mattermost's built-in features: slash commands, interactive dialogs for forms, buttons on posts, ephemeral replies, bookmarks, bots, and the existing capture pipeline. In Phase 1, a display-only webapp plugin (no Go, no brain logic) embeds the pages in the right-hand sidebar and App Bar; that needs a recorded amendment to rule 4. The admin API (D43) folds into `brain-api`.
- **B.** Build the brain into the fork (Go, inside the Mattermost process). Rejected: the brain would become AGPL code we must publish, every Mattermost upgrade becomes a merge of our product, and the licence boundary the lawyer confirmed moves.
- **C.** A Go server plugin for commands and UI, calling our services. Rejected for now: a second language and build, code inside the Mattermost process, and everything it would do is available through A's integration features.

### C2. What the brain reads: every channel (spec) versus opt-in channels (D5)

The spec's vision reads "every channel, thread and direct message is a feed into the brain", and FR-1.10 has the Follow-up agent read plain channels into a "General" container. Today a channel is read only while `@brain` is a member (D5, a deliberate consent signal), and direct messages are never read (Q5).

Options:

- **A (recommended).** Keep membership as the switch, and make it automatic where the spec needs it: project channels and promoted Topics get `@brain` on creation; an installation setting `BRAIN_CAPTURE_PUBLIC_CHANNELS` (off by default, on for Infinics) makes the bridge's reconciliation add `@brain` to every public channel, whose conversations land in "General"; private channels only when someone invites `@brain`; no personal direct messages. Direct messages *with an agent* (the bot is a participant) can be read in a later phase.
- **B.** Read everything, private channels and DMs included, with the system-admin bot. Rejected: a bot cannot receive other people's DM events (it would have to poll with admin rights), and silent capture of private channels contradicts "humans stay in control".

### C3. Agents posting straight into Mattermost versus "agent messages originate on the relay" (D6)

Proposals with buttons, reminders, digests and interview questions go to people as direct messages or ephemeral posts, and dialogs and button callbacks are Mattermost-only mechanisms. D6 routes every agent message through the relay so it is signed and mirrored; the relay cannot carry buttons, dialogs or DMs.

Option (recommended): a hybrid. Conversation replies in channels (the Analyst answering in a thread) keep the relay path. Proposals, reminders, digests, ephemeral replies, dialogs and DMs go straight through `ChatClient` from `brain-api` as the acting agent's bot, recorded in `agent_runs` and the audit log. A direct bot post in a captured channel is still mirrored to the relay signed with the agent's key (verified: `mm-to-relay.ts:90-125` mirrors agent-bot posts that carry no relay event id), so the relay log stays complete for channel content.

### C4. Vector search needs a change to a pinned image

Section 5: no `pgvector` today. Recommended: option A (pgvector compiled into our state-database image, same base, pinned release), applied to the local stack and staging.

### C5. Embeddings need a provider and a key

Semantic search (FR-9.2) needs embeddings; the clone has no provider because Anthropic offers none (D34). Recommended: Google's embedding model behind an `EmbeddingProvider` interface with a deterministic `mock` for tests, using the Google API key that the spec's Gemini provider needs anyway; keyword search works without any key, so a clean install does not depend on it. Alternatives: Voyage (Anthropic's embeddings partner; a third key), or a local model for installations that forbid sending this data class to a model (later, as a provider).

### C6. New dependencies for Phase 0 (the spec asks before any external dependency)

| Dependency | For | Alternative |
| --- | --- | --- |
| `@google/genai` (official Google SDK) | Gemini provider and embeddings (section 13 decision 2) | REST calls by hand (more code, no benefit) |
| Fastify with its zod type provider, swagger (OpenAPI → `docs/brain/API.md`), multipart and static plugins | The brain API: about sixty routes with validation and a generated reference | Hono (equivalent, smaller; either is fine), or the hand-written router of the admin API (does not scale to this surface) |
| React, Vite and FormatJS (`react-intl`) | The brain's pages with a string catalog (NFR-10; FormatJS is what Mattermost uses) | Server-rendered templates (less interactive boards later) |
| pgvector (image build, section 5) | Vector index | see C4 |

Later phases bring their own (text extraction and OCR, zip, Git, Gmail, GitHub, MCP SDK); each will be asked for in its phase plan.

## 10. Not verified yet (spikes for Phase 0)

1. Mattermost calling a private-network URL for slash commands, dialogs and button actions, and the exact `AllowedUntrustedInternalConnections` value needed (R1).
2. The trigger id lifetime and the integration request timeout (R2).
3. Mattermost's OAuth 2.0 provider flow end to end (authorization code, user info) for the brain's pages.
4. The `@brain` bot downloading a channel file with its token (section 6.2).
5. Compiling pgvector on the pinned Alpine image and `CREATE EXTENSION vector` from a migration (section 5).
6. The Gemini API for chat with tool use and for embeddings at 1536 dimensions, against the current SDK (CLAUDE.md rule 3).
