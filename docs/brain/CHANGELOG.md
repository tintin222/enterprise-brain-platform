# Company Brain changelog

One entry per phase (spec section 12), newest first. Requirement ids refer to `docs/COMPANY_BRAIN_SPEC.md`.

## Phase 1: Project and topic memory (2026-10-13)

Plan: `02-phase1-plan.md`. Gate: `gates/phase-1.md`.

- **Projects and Topics as workspaces** (FR-1.1 to 1.10): `POST /projects` creates the container and its channel group (`#proj-<slug>`, `-requirements`, `-agent`) with `@brain` and the creator in each; `POST /topics` promotes a channel or creates one; a Project spawned from a Topic takes its people and systems along and `move-items` moves or links the Topic's items; home pages with summary, people and roles, systems, open requirements and tasks, decisions, documents, conversations, timeline and package status; a daily job flags projects without activity (`BRAIN_STALE_DAYS`) and tells the owner once; chat: `/project new [--from-topic]`, `/project archive`, `/topic here`, `/topic new`. Owners count as members.
- **People** (FR-2.1 to 2.5): a `person` entity for every chat account (first sight and a daily sync), external contacts without an account, profiles the person or an administrator edits, roles in a container as `member_of` links that widen access (FR-2.3), suggestions to confirm (filled by agents from Phase 4), and "who knows about X" ranking people by the evidence that links them to what matched (authors of conversations, owners, creators, assignees, their own profile).
- **Systems** (FR-3.1 to 3.7): installation-wide `system` entities in General linked to the Projects and Topics that use them; DDL and OpenAPI uploads read into structure (tables, columns, keys; endpoints, parameters, auth) and described in the searchable text; integrations as `depends_on` links with protocol and payload; the inventory of screens, modules, known issues and pain points; a diff between any two versions of an entity (text lines and data fields). Deferred, as agreed (Q26): live database introspection, WSDL and Postman structure.
- **Documents** (FR-5.1 to 5.6): multipart upload to a container or an entity, files in the database (D63), text extraction with pdf.js, mammoth, exceljs, jszip and plain readers (D64), scans and images through the model provider when the document is neither confidential nor no-ai and the installation allows it (D65), versions by name, "use as context", confidential documents with audited reads, chat attachments through the same pipeline (D67).
- **Tasks** (FR-11.1 to 11.3): one model for people's tasks and agents' proposals; lists, boards and "my tasks"; `/task <title>` in a thread makes the thread the evidence, `/task` alone opens a form, `/task mine` lists; a daily reminder message at `BRAIN_REMINDER_HOUR` with done, snooze and reassign buttons; proposal decisions (accept, edit, dismiss).
- **Search** (FR-9.1, NFR-1, Q24): a rare-terms tier between all-terms and any-term, from word statistics a nightly job keeps (D66), and type and container facets.
- **Export** (NFR-9): the uploaded files join the export; `pnpm brain:export <dir> [--verify]` writes everything and proves the round trip into a temporary database.
- **Jobs**: a runner in the brain API whose rows in `brain.jobs` are the lock (`people-sync`, `stale-projects`, `chat-attachments`, `task-reminders`, `lexeme-stats`), with metrics.
- **Pages**: project and topic homes, people directory and person page, systems, documents (upload, download, flags, extraction state), tasks (list, board, my tasks), a who-knows tab on search, version diffs; every string in the catalog (NFR-10).
- **Tests**: e2e suites `brain-people` (5), `brain-workspaces` (6), `brain-documents` (5), `brain-systems` (3), `brain-tasks` (4), `brain-export` (1); unit tests for the extractors, the DDL and OpenAPI readers, the diff and the schedule.

## Phase 0: Foundation (2026-10-12)

Plan: `01-phase0-plan.md`. Gate: `gates/phase-0.md`.

- **Knowledge store** (`packages/brain`, schema `brain`): containers (Project, Topic, General), channel links, entities with versions, typed links, chunks with keyword and vector indexes, the append-only audit log, an event outbox, installation settings. Migrations 0003 to 0006; the former thread documents became conversation entities. FR-9.1, FR-9.4, NFR-9.
- **Hybrid search**: keyword and vector halves fused by reciprocal rank inside the caller's scope, one result per entity, a relevance cutoff on semantic hits (D60), chunks holding all query terms ranked before the any-term fallback (D61), iterative HNSW scans so filters and deleted rows cannot empty the vector half (D62), citations with post permalinks. FR-9.2, FR-9.5.
- **Model providers** (`packages/models`): Anthropic and Google (Gemini) with a tool loop, the echo provider, embeddings from Google or a deterministic mock, provider and model per agent, a price table. Spec section 5, decision 2; D54, D56.
- **pgvector** compiled into our state-database image (`infra/state-postgres`), used by the local stack, the installation and staging. D52.
- **Capture of every channel** (D50): the bridge's sweep adds `@brain` to channels it never captured; opted-out channels stay out. FR-1.10.
- **Brain API** (`packages/brain-api`, `/api/v1/brain`): containers, entities, versions, links and backlinks, search, audit, JSON Lines export, the agent routes that left agent-runtime's admin API, the Mattermost setup, sign-in through Mattermost's OAuth 2.0 provider with signed session cookies, a service token, the `/brain` slash command (`search`, `link` with a dialog), dialog and button callbacks, the embedding worker, feature flags (D55). `API.md` is generated from the routes.
- **Pages** (`packages/brain-web`): search with filters, projects and topics, entity pages with fields, versions and backlinks, sign-in; every string in a catalog (NFR-10).
- **Clean install** (`install/`): one Compose bundle, an installer that runs in the services image, optional TLS with Caddy, `./install/brain test` as the gate's install check; services call Mattermost at `MM_API_URL` while `MM_URL` stays the public address (D58). NFR-12.
- **Checks**: `pnpm check:secrets` (key shapes, secret assignments, known values) and a CI workflow (typecheck, lint, unit, secrets, API reference, e2e, nightly clean install).
- **Tests**: `e2e/brain-api.e2e.test.ts` (gate, versions, audit, links, sign-in, access, channel linking, `/brain`, dialogs, agents, export), `e2e/capture.e2e.test.ts`, unit tests for the models, the store's pure parts and the string catalog; the earlier suites pass on the new store.
