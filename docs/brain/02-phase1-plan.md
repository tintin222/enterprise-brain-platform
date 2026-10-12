# Phase 1 plan: Project and topic memory

Step 2 of the spec's workflow for the second phase (`docs/COMPANY_BRAIN_SPEC.md` sections 11 and 12). Written on 2026-10-12 after the owner accepted Phase 0 (`gates/phase-0.md`). Nothing in it is built until the owner approves it; the asks are in section 18.

## 1. Scope and gate

Spec scope for Phase 1 (weeks 4 to 6): **FR-1** Project and Topic workspaces, **FR-2** people directory, **FR-3** technical knowledge (Systems), **FR-5** document store, **FR-11.1 to 11.3** built-in tasks. Deliverables: project home, Topic from a channel, people directory, systems with schema and API upload, document pipeline with extraction and embeddings, built-in task lists and boards.

Gate (spec section 11): **one real Infinics client project and one internal topic fully described; "who knows about X" returns correct people; a non-technical user creates and completes a task without help.**

Carried over from Phase 0 (`gates/phase-0.md`): the keyword fallback for question-shaped searches (Q24, NFR-1), the export round trip with files (`pnpm brain:export`, NFR-9), and the owner's manual checks of the pages and `/brain` on staging.

Left to later phases on purpose, as the spec sequences them: requirements and the Analyst (FR-4, Phase 2), the vault and credential handles on Systems (FR-6, Phase 3), mail and chat attachments from mail, meeting notes, agent-proposed tasks and digests (FR-5.6 for mail, FR-8, Phase 4), GitHub Issues sync (FR-11.4, Phase 4 with the connector framework), SSO, retention and residency (Phase 5). Two pieces of FR-3 wait too, see section 5: read-only database introspection and automatic parsing of WSDL and Postman collections.

## 2. What Phase 1 adds to the architecture

Phase 0 left a knowledge store with containers, entities, versions, links, chunks, audit and hybrid search; a brain API with sign-in, the `/brain` command, pages and an embedding worker; capture of every channel into conversation entities. Phase 1 adds, inside the same services:

| Piece | Where | What |
| --- | --- | --- |
| Projects and Topics as workspaces | brain-api, brain-web | Creation with their channel group, home pages with panels, timeline, stale flag, archive, spawn from a Topic, move items |
| People | brain-api, brain-web, a sync step | A `person` entity per Mattermost account (created on first sight, kept in step), external contacts without an account, roles per container, "who knows about X" |
| Systems | brain-api, brain-web | `system` entities, artifacts as versioned documents (DDL, OpenAPI, diagrams, inventory), integration links, version diffs |
| Documents | brain-api (upload, extraction worker), brain-web, ingestion (chat attachments) | Files in the store, text extraction, OCR where allowed, chunks and embeddings, versions by name, "use as context", confidential with logged access |
| Tasks | brain-api (reminders job), brain-web, `/task` command | One task model for people and (later) agents, list and board per container, "My tasks", reminders by chat message with snooze and reassign |
| Commands | brain-api | `/project`, `/topic`, `/task` registered next to `/brain`, with dialogs for the forms |
| Jobs | brain-api | A small scheduler for daily work: reminders, stale projects, people sync, term statistics |
| Export | `pnpm brain:export` | Everything in JSON Lines plus the files, and an import that verifies the round trip |

No new service, no new database, no change to the container model (Project and Topic stay the only top-level containers; General stays the bin for plain chat). The two interfaces to upstream stay the only ones: `ChatClient` gains what the forms and reminders need (channel groups, direct messages with buttons, user listing, user profile fields); `RelayClient` is untouched.

## 3. Projects and Topics (FR-1)

Containers exist since Phase 0 (`brain.containers`, `brain.channel_links` with roles `home`, `requirements`, `agent`, `linked`). Phase 1 completes them.

- **FR-1.1 Create a Project** from the pages (a form) or from chat (`/project new` opens a Mattermost dialog with the same fields). Fields in `containers.data`: `client`, `goal`, `scope`, `stage`, `startsOn`, `endsOn`, `budget` (optional), `stakeholders` (person ids with roles), `parentTopic` (optional). `status` stays the column (`active`, `archived`); `owner_id` becomes the creator's person id.
- **FR-1.2 Channel group:** `POST /projects` creates `proj-<slug>`, `proj-<slug>-requirements` and `proj-<slug>-agent` in the creator's team through `ChatClient.createChannel`, links them with roles `home`, `requirements`, `agent`, adds `@brain` and the creator; existing channels can be linked instead or in addition (`POST /containers/{id}/channels`, Phase 0). Default: public channels in the team; a `private` switch on the form makes all three private. Idempotent: a second call with the same slug finds the channels by name.
- **FR-1.3 Project home page:** panels for summary and timeline, people and roles, systems, open requirements (empty until Phase 2, with the count), open tasks, recent decisions (empty until Phase 2), documents, package status (a line saying "Phase 3"). One request feeds the page: `GET /containers/{id}/home` returns the panels' data with counts and the five most recent items of each.
- **FR-1.4 Timeline:** `data.milestones[]` (`title`, `date`, `kind` phase or milestone, `done`) edited by container members; `PATCH /containers/{id}` with versioning as today.
- **FR-1.5 Stale flag:** a daily job computes each project's last activity (newest conversation, entity change or task change) and, after `BRAIN_STALE_DAYS` (default 14) without any, marks `data.stale = true` and sends the owner one direct message from `@brain` (once per staleness period). Any activity clears the flag.
- **FR-1.6 Archive:** exists (`POST /containers/{id}/archive`); archived containers stay searchable (`includeArchived` filter) and the Phase 3 package will read them.
- **FR-1.7 Topics:** `/topic here` promotes the current channel: a dialog asks name, kind (internal or external), external organisation and contacts (for external), owner, description; the channel becomes the `home` link and its conversations move to the Topic (Phase 0's re-attribution). `/topic new` creates the channel first. On the pages, "New topic" offers the channels the person is in.
- **FR-1.8 Topic home page:** the same panels without timeline and package; external topics show the organisation and its contacts (person entities with `data.external = true`).
- **FR-1.9 Spawn a Project from a Topic:** `/project new --from-topic` and `POST /projects/from-topic/{topicId}`: the project carries `data.spawnedFrom`, a `spawned_from` link, and the Topic's people and systems as links. `POST /topics/{id}/move-items` with `{ projectId, entityIds, mode: 'move' | 'link' }` moves (changes `container_id`, versioned) or links (`belongs_to`) requirements, tasks and documents in one transaction.
- **FR-1.10 General:** unchanged; an admin files a General conversation into a Topic by linking its channel (Phase 0) or moving single entities (the same move endpoint).

## 4. People (FR-2)

- **FR-2.1 Profiles:** a `person` entity per Mattermost account, `external_key = 'mm:<user id>'`, created when first seen (sign-in, a mention, the sync job) and refreshed daily from Mattermost's user list (display name, email, position, deactivation). Profile fields in `data`: `role`, `organisation`, `expertise[]`, `responsibilities[]`, `workingHours`, `preferredChannel`, `managerId`. The person and admins edit them on the person page; every edit is a version.
- **FR-2.2 External contacts:** `person` entities with `data.external = true`, `emails[]`, `organisation`, no Mattermost account; created from the people page or the Topic form. Mail attribution uses `emails` in Phase 4.
- **FR-2.3 Roles in a container:** `member_of` links from the person to the container with `data.role` in `sponsor`, `product_owner`, `end_user`, `developer`, `fde`, `reviewer`. Container membership for access (Phase 0's policy) becomes: channel members of the container's channels, plus people with a `member_of` link, plus the owner.
- **FR-2.4 "Who knows about X":** `GET /people/search?q=X` runs the hybrid search for X without a result cap per entity, then scores people: authors of matching conversation chunks (from the chunks' `metadata.authors`), owners and `raised_by` persons of matching entities, people linked to matching documents and systems, weighted by rank and recency; returns people ordered by score with the evidence that put them there (the three best items each). The search page gets a "People" tab with the same results.
- **FR-2.5 Suggestions by agents:** the data shape only (`data.suggested` with `expertise` and `responsibilities` entries, `confirm`/`dismiss` endpoints); agents fill it in Phase 4. A person confirms on their page.

## 5. Systems (FR-3)

- **FR-3.1 System entity:** `system` with `data`: `description`, `businessOwnerId`, `technicalOwnerId`, `stack[]`, `environments[]` (`name`, `url`, `notes`), `repositories[]`, `deployment`. Container: Systems are installation-wide (FR-3.7), so their `container_id` is General and they are linked to Projects and Topics with `belongs_to` links; the home pages list the linked systems.
- **FR-3.2 Database schemas** and **FR-3.3 API catalog:** uploads become documents attached to the system (`attached_to`) with `data.artifact` in `ddl`, `er_diagram`, `openapi`, `wsdl`, `postman`, `other`. Parsing into structure (`data.structure`): DDL by a small parser for `CREATE TABLE` statements (tables, columns, types, primary and foreign keys; Postgres, MySQL and SQL Server dialects as far as the common grammar goes, the rest kept as text); OpenAPI and Swagger (JSON or YAML) by reading the spec directly (paths, methods, auth schemes, sample bodies). Annotations are free text on the artifact. **Not in Phase 1:** connecting to a database read-only and introspecting it (needs a driver per engine and credentials, which arrive with the vault in Phase 3), WSDL and Postman parsing (stored and searchable as text, structure later).
- **FR-3.4 Integration map:** `depends_on` links between systems with `data.protocol` and `data.payload`; the system page draws the list both ways; a later phase can render a diagram.
- **FR-3.5 Inventory:** `data.inventory` on the system (`screens[]`, `modules[]`, `knownIssues[]`, `painPoints[]`), edited on the page; agents add to it in Phase 2.
- **FR-3.6 Versions and diffs:** `entity_versions` exist; `GET /entities/{id}/versions/{a}/diff/{b}` returns a line diff of the text and a field diff of `data`; the pages show it. For artifacts the text is the uploaded file's text, so a new DDL upload shows what changed.

## 6. Documents (FR-5)

- **Storage:** files go in the state database (`brain.files`: id, sha256, size, media type, `bytes bytea`, created_by, created_at), deduplicated by hash, capped at `BRAIN_FILE_MAX_MB` (default 50). One database to back up, export and move; the same on a laptop, on staging and in a customer installation. If an installation outgrows this, the same `FileStore` interface can be backed by the S3-compatible store the bundle already runs for the relay (ask 2 in section 18).
- **FR-5.1 Upload:** `POST /documents` (multipart: file, `attachTo` entity or container id, `useAsContext`, `confidential`, `noAi`) creates a `document` entity with `data`: `fileId`, `name`, `mediaType`, `size`, `extracted` (status, characters, pages, error), `useAsContext`, `confidential`, `noAi`, `source` (upload, chat, mail). Allowed anywhere a container or entity can hold things: Project, Topic, System, Requirement (Phase 2), Person. The pages get drag-and-drop on the home pages and on entity pages.
- **FR-5.2 Extraction:** a worker next to the embedding worker takes new files and writes the text: PDF (text layer), DOCX, XLSX and CSV (sheets as rows of text, tables kept as Markdown tables), PPTX (slide text), Markdown and plain text, images and PDFs without a text layer by OCR **through the configured model provider** (Gemini's vision input) when the document is not confidential and not `noAi` and the installation flag `BRAIN_FEATURE_OCR_MODEL` is on; otherwise the file is stored and searchable by name only, with the reason shown on the page. Code archives (zip) are unpacked to a size limit; text files inside become the document's text with file paths as headings. Extracted text is chunked by the existing chunker and embedded by the existing worker.
- **FR-5.3 Versions by name:** a second upload with the same name to the same container or entity creates a new version of the existing document entity (new file id, new text, new chunks; old chunks removed); the versions endpoint lists them and each keeps its file.
- **FR-5.4 "Use as context":** a flag on the document; retrieval and the Phase 3 package prefer flagged documents (search results carry it; agents' context assembly, Phase 2, boosts them).
- **FR-5.5 Confidential:** visible to the container's owner, administrators and people the document lists in `data.allowedPersonIds`; every read of the text or the file is audited with actor, IP and request id; confidential documents are never sent to a model (section 7 of the spec).
- **FR-5.6 Chat attachments:** ingestion already sees file ids on captured posts; it downloads them through `ChatClient.getFile` (the brain's bot can read what it may read, D50's capture) and runs them through the same pipeline as uploads, attached to the conversation's container with the post's permalink as the source and the channel's visibility as the document's. Mail attachments join in Phase 4.
- **Export (NFR-9):** `GET /export/files/{id}` and, in `pnpm brain:export <dir>`, the files written next to the JSON Lines; `--verify` imports the directory into an empty database and compares counts, ids, versions and file hashes (closes the Phase 0 gate's open item).

## 7. Tasks (FR-11.1 to 11.3)

- **Model:** `task` entity with `data`: `assigneeId`, `dueAt`, `priority` (`low`, `normal`, `high`), `state` (`open`, `in_progress`, `done`, `dismissed`), `comments[]` (`by`, `at`, `text`), `evidence[]` (post permalinks, entity ids, mail ids later), `proposal` (`null`, or `{ by: agent id, run id, state: proposed | accepted | edited | dismissed }`). Expression indexes on `(data->>'dueAt')` and `(data->>'assigneeId')` for tasks keep the list fast without new columns.
- **FR-11.1 Views:** list and board (columns by state, drag to move) per Project and Topic, "My tasks" (`/tasks/mine`) across containers, due dates and priority visible, a comment box, evidence links that open the post or entity. Creating a task takes one step: a title, optionally a person and a date; everything else has a default. From chat: `/task <title>` in a channel creates a task in the channel's container (General when none) with the current post or thread as evidence; a message action "Make a task" on any post opens a dialog pre-filled with the message.
- **FR-11.2 Reminders:** the jobs runner sends, at `BRAIN_REMINDER_HOUR` (default 08:00 in `BRAIN_TIMEZONE`), each person one direct message from `@brain` listing tasks due today and overdue, with buttons per task: done, snooze (one day, next week), reassign (opens a dialog). Buttons call the brain API's action endpoint (Phase 0's `/mm/actions`), verified by signed state. One message per person and day, idempotent (`brain.jobs` records what was sent).
- **FR-11.3 Proposals:** the data shape and the endpoints (`POST /tasks/{id}/accept`, `/edit`, `/dismiss`) exist now; a proposed task appears in the assignee's list under "Proposed" and becomes a normal task on acceptance. The Follow-up agent fills them in Phase 4.

## 8. Commands and callbacks

Registered by the setup step next to `/brain` (per team, tokens in the key store): `/project new [--from-topic]`, `/project archive`, `/topic here`, `/topic new`, `/task <title>`, `/task mine`. Each opens a dialog (spike B1) or answers ephemerally with links to the pages. `/brain help` lists them all. Message actions: "Make a task", "Attach to a project" (documents from a post's files).

## 9. Access policy additions (FR-9.5, section 7 of the spec)

- Container membership = members of the container's channels ∪ people with `member_of` links ∪ the owner (section 4).
- Documents follow the entity they are attached to; confidential ones as in section 6. Reads of confidential documents and of any file bytes are audited.
- Tasks are visible to the container's members and to their assignee even outside the container (so "My tasks" works for someone assigned from another project).
- People profiles are visible to everyone signed in; external contacts' emails only to administrators and container members where the contact is linked.
- Chat commands act as the person who typed them, as today.

## 10. Search and NFR-1 (Q24)

- **Fallback for question-shaped queries:** a `brain.lexeme_stats` table (lexeme, chunk count) recomputed by a job from `ts_stat` nightly and after large ingestions, used when no chunk holds all the query's lexemes: the query is rebuilt from its three rarest lexemes (any-term among those) so the ranked set stays small; the full any-term ranking remains the last resort only when the rarest terms match nothing. Acceptance: `pnpm brain:bench` question series p95 under 1.5 s at 250 k chunks, the term series unchanged.
- Documents and systems join the search with their types as filters; the search page shows type and container facets.

## 11. Jobs

`brain.jobs` (name, scheduled_at, ran_at, result) and a runner inside brain-api, one tick per minute, leader-safe through an advisory lock so a second brain-api process does no double work: reminders (daily at the reminder hour), stale projects (daily), people sync (daily and on demand), lexeme statistics (nightly), file extraction retries. Metrics per job (`brain_jobs_total{job,outcome}`, `brain_job_seconds`).

## 12. Pages (brain-web)

New or extended pages, every string in the catalog (NFR-10): project home and topic home (panels, timeline, people with roles, stale banner), new project and new topic forms, people directory and person page (profile, roles, evidence of expertise, suggestions to confirm), "who knows about X" tab on search, systems list and system page (environments, repositories, artifacts with upload, integration list, inventory, version diff view), document page (text, versions, flags, download), tasks list and board per container, "My tasks", task page with comments. Drag-and-drop upload on home and entity pages. The gate's third criterion is about these pages: creating and completing a task must need no explanation.

## 13. Feature flags and configuration (D55)

`BRAIN_FEATURE_PROJECTS`, `BRAIN_FEATURE_PEOPLE`, `BRAIN_FEATURE_SYSTEMS`, `BRAIN_FEATURE_DOCUMENTS`, `BRAIN_FEATURE_TASKS`, `BRAIN_FEATURE_REMINDERS` (all default on), `BRAIN_FEATURE_OCR_MODEL` (default on; off keeps image-only files unextracted), `BRAIN_FILE_MAX_MB` (50), `BRAIN_STALE_DAYS` (14), `BRAIN_REMINDER_HOUR` (8), `BRAIN_EXTRACT_CONCURRENCY` (2). Documented in `.env.example` and `install/config.example.env`.

## 14. Data model (migrations)

- `0007_files.sql`: `brain.files` (section 6); `brain.jobs` (section 11); `brain.lexeme_stats` (section 10).
- `0008_phase1_indexes.sql`: expression indexes for tasks (due, assignee, state), people (`external_key`, `data->>'external'`), documents (`data->>'confidential'`); `links.data->>'role'` index for roles.
- No change to `containers`, `entities`, `entity_versions`, `links`, `chunks`, `audit_log` shapes; new fields live in `data`, as the spec's model intends. The container model does not change.

## 15. API additions (`/api/v1/brain`, `API.md` regenerated)

| Area | Endpoints |
| --- | --- |
| Projects | `POST /projects`, `POST /projects/from-topic/{topicId}`, `GET /containers/{id}/home`, `GET/PATCH /containers/{id}/timeline` |
| Topics | `POST /topics` (from a channel or new), `POST /topics/{id}/move-items` |
| People | `GET /people`, `GET /people/{id}`, `PATCH /people/{id}`, `POST /people` (external contact), `GET /people/search?q=`, `POST /containers/{id}/members` (role), `DELETE /containers/{id}/members/{personId}`, `POST /people/{id}/suggestions/{n}/confirm|dismiss` |
| Systems | `POST /systems`, `GET /systems`, `POST /systems/{id}/artifacts` (multipart), `POST /systems/{id}/integrations`, `GET /entities/{id}/versions/{a}/diff/{b}` |
| Documents | `POST /documents` (multipart), `GET /documents/{id}/text`, `GET /documents/{id}/file`, `GET /documents/{id}/versions`, `PATCH /documents/{id}` (flags) |
| Tasks | `GET /containers/{id}/tasks`, `GET /tasks/mine`, `POST /tasks`, `PATCH /tasks/{id}`, `POST /tasks/{id}/comments`, `POST /tasks/{id}/accept|edit|dismiss` |
| Export | `GET /export/files/{id}`; `pnpm brain:export <dir> [--verify]` |
| Chat | `/mm/commands/project`, `/mm/commands/topic`, `/mm/commands/task`, dialogs `project`, `topic`, `task`, actions `task-done`, `task-snooze`, `task-reassign`, `make-task`, `attach-files` |

## 16. Tests

- Unit: DDL and OpenAPI parsers, the document chunking of extracted text, expertise scoring, reminder scheduling (hour, time zone, idempotence), version-by-name, the diff endpoint, the fallback query builder, the job runner's lock.
- e2e (each FR): project creation creates and links the channel group and the home page shows its panels (FR-1.1 to 1.3); timeline edit versioned (1.4); a stale project messages its owner (1.5, with `BRAIN_STALE_DAYS=0`); `/topic here` promotes a channel and its past threads (1.7, 1.8); spawn from a Topic and move items (1.9); person created at first sign-in and profile edit (2.1); external contact (2.2); roles grant access (2.3); "who knows about X" ranks the author of a thread and the owner of a document first (2.4); system with a DDL and an OpenAPI upload, structure parsed, diff between two uploads (3.1 to 3.6); document upload searchable within 5 s, version by same name, confidential read audited and refused to a non-member, no-ai file not sent to the OCR provider (5.1 to 5.5, mock provider); a chat attachment becomes a document with the post as source (5.6); task created from `/task`, moved on the board, completed; the reminder message with its snooze button (11.1, 11.2); a proposed task accepted (11.3); export round trip with files (NFR-9).
- Bench: `pnpm brain:bench` with both series (NFR-1, Q24).
- Golden set: not yet (agents come in Phase 2); `tests/brain/golden/` gets the real project's description once the owner provides it (section 17), as the fixture later agents are tested against.

## 17. Gate procedure (`gates/phase-1.md`)

1. **The real project and topic** on staging: the owner names one Infinics client project and one internal topic (ask 5). I create them from the owner's facts (people, roles, systems, documents, milestones) through the pages and commands, or the owner does with me watching the logs; "fully described" means every panel of the home page has real content and every document is extracted and searchable.
2. **"Who knows about X"** on that data: the owner gives five questions with the person they expect; the people search must rank each expected person first or second.
3. **A non-technical user creates and completes a task without help:** someone from the owner's side who has not seen the pages, with the owner watching; no instruction beyond the address. Recorded as pass or fail with what confused them.
4. Automated: the e2e list above green in CI, the bench numbers, the install test still passing, the Phase 0 gate test re-run.
5. What was not verified, as in Phase 0.

## 18. What I need from the owner

Plain words, with my recommendation first.

1. **Approve this plan.** Details that turn out differently during implementation come back in the phase report; anything touching the data or container model comes back as a question first.
2. **Where to keep uploaded files.** Recommended: in our database, capped at 50 MB per file (one backup, one export, nothing new to run). Alternative: the S3-compatible store the stack already runs for the relay (better for very large installations, one more credential to manage). Say "database" or "S3".
3. **New libraries for reading documents** (all open-source, pinned, read-only parsers): `pdfjs-dist` (PDF text), `mammoth` (Word), `exceljs` (Excel), `jszip` (PowerPoint and zip archives), `yaml` (OpenAPI files). Recommended: yes to all five.
4. **OCR for scanned PDFs and images.** Recommended: use the installation's model provider (your Gemini key) to read them, only for files not marked confidential or no-ai, switchable per installation (`BRAIN_FEATURE_OCR_MODEL`). Alternative: a local OCR engine (`tesseract.js`, slower and heavy) or no OCR in Phase 1 (such files searchable by name only).
5. **The gate's real project and topic.** Which client project and which internal topic, and who gives me their facts and documents (or enters them). Needed only when Phase 1 is nearly done; say now if you already know.
6. **Two pieces of FR-3 deferred:** connecting to a database read-only to introspect it (after the vault, Phase 3) and parsing WSDL and Postman files into structure (stored and searchable as text in Phase 1). Say if either must be in Phase 1.
