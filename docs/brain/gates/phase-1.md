# Phase 1 gate: Project and topic memory

Run on 2026-10-13 against branch `brain-phase1`, following `02-phase1-plan.md` section 17. The spec's gate for Phase 1 (`docs/COMPANY_BRAIN_SPEC.md` section 11): **one real Infinics client project and one internal topic fully described; "who knows about X" returns correct people; a non-technical user creates and completes a task without help.**

Status: **the automated part passed; the three gate criteria are the owner's to run on staging** (Q25: the owner's people create their own project and topic). This report records what is built and verified, the numbers, what the owner's people must do, and what was not verified.

## 1. What was built, and the test behind each requirement

| Requirement | Built | Verified by |
| --- | --- | --- |
| FR-1.1, 1.2 | `POST /projects`, `/project new` dialog: the container and its channel group with `@brain` and the creator in each | `brain-workspaces` "creates a project with its three channels…" |
| FR-1.3, 1.8 | `GET /containers/{id}/home` and the home pages with every panel | same test; "spawns a project from a topic…" (panels after a spawn) |
| FR-1.4 | `PATCH /containers/{id}/timeline`, versioned; members only | "the timeline is edited by members and versioned" |
| FR-1.5 | daily `stale-projects` job, one direct message to the owner | "a project without activity is flagged stale and its owner is told once" |
| FR-1.6 | `/project archive`, archived projects stay searchable | "/project archive archives the channel's project…" |
| FR-1.7 | `/topic here` dialog, `/topic new`, `POST /topics` | "/topic here promotes the channel through its dialog…" |
| FR-1.9 | `POST /projects/from-topic/{id}`, `POST /topics/{id}/move-items` | "spawns a project from a topic and moves the topic's items into it" |
| FR-1.10 | General unchanged; `move-items` files single items | Phase 0 `capture` suite; move test |
| FR-2.1 | person per account at first sight and by the daily sync; profile edits by the person or an administrator | `brain-people` tests 1 and 2 |
| FR-2.2 | external contacts | test 3 |
| FR-2.3 | roles as `member_of` links; roles widen access | test 4 |
| FR-2.4 | `GET /people/search?q=`, the "Who knows about this" tab | test 5 (author of a thread first; owner of an entity first) |
| FR-2.5 | suggestion shape and confirm/dismiss endpoints (agents fill them in Phase 4) | unit-level only (no agent yet) |
| FR-3.1, 3.7 | `system` entities in General, linked to containers; home pages list them | `brain-systems` test 1 |
| FR-3.2, 3.3 | DDL and OpenAPI artifacts read into structure at extraction; endpoints and tables searchable | test 2; unit tests `parsers.test.ts` |
| FR-3.4, 3.5 | `depends_on` integrations with protocol and payload; inventory fields | test 3 |
| FR-3.6 | `GET /entities/{id}/versions/{a}/diff/{b}`, the diff view | test 3; unit tests `diff.test.ts` |
| FR-5.1, 5.2 | multipart upload; extraction worker (pdf.js, mammoth, exceljs, jszip, text; model OCR) | `brain-documents` test 1; unit tests `extract.test.ts` (10) |
| FR-5.3 | versions by name | test 2 |
| FR-5.4 | `useAsContext` flag (consumed by Phase 2 agents and Phase 3 packages) | test 1 sets it |
| FR-5.5 | confidential: uploader, administrators and allowed people; audited reads | test 3 |
| FR-5.6 | chat attachments: bridge `mm_file` tags → ingestion metadata → `chat-attachments` job | test 5 |
| D65 | no-ai and confidential documents never reach the OCR provider | test 4 (with the fake provider's call log) |
| FR-11.1 | one-step creation, board states, comments, "my tasks", `/task` from a thread with the thread as evidence, `/task mine` | `brain-tasks` tests 1 and 2 |
| FR-11.2 | daily reminder with done, snooze, reassign buttons; a press through Mattermost completes the task | test 3 |
| FR-11.3 | proposals share the model; accept, edit, dismiss | test 4 |
| NFR-1, Q24 | rare-terms tier from `brain.lexeme_stats` | bench, item 3 |
| NFR-9 | files in the export; `pnpm brain:export <dir> --verify` round trip | `brain-export` test; a round trip of the local store (section 4) |
| NFR-10 | every page string in the catalog; enumerations checked | `i18n.test.ts` |

Phase 0 suites still pass on the Phase 1 store (`brain-api` 9 tests, `capture` 2, ingestion, agent runtime, bridge, operations).

## 2. Automated results

- Unit tests: 112 across the packages (extractors, parsers, diff, schedule, store, models, catalog).
- e2e, run locally against the dev stack on 2026-10-13: `brain-people` 5/5, `brain-workspaces` 6/6, `brain-documents` 5/5, `brain-systems` 3/3, `brain-tasks` 4/4, `brain-export` 1/1, `brain-api` 9/9.
- CI (the whole suite on a fresh runner): PENDING_CI
- Clean install: the Phase 0 bundle gained the Phase 1 settings (`install/config.example.env`); the nightly install job runs it.

## 3. NFR-1 after the rare-terms tier (Q24)

`pnpm brain:bench --chunks 250000 --queries 200` on the local state database, same data as the Phase 0 gate (5 000-word vocabulary with a heavy head, 60-word chunks, random unit vectors), after `brain.lexeme_stats` was refreshed.

| Query | Keyword | Semantic | Hybrid |
| --- | --- | --- | --- |
| Remembered words (three words of a stored chunk and its vector; 200 queries) | p50 88 ms, p95 278 ms, max 669 ms | p50 6 ms, p95 16 ms | **p50 83 ms, p95 267 ms**, max 623 ms |
| Unrelated words (three random words, co-occurring nowhere; 50 queries: the fallback tiers) | **p50 256 ms, p95 722 ms**, max 846 ms | — | keyword-bound |

Both are under the 1.5 s target. Two changes brought the fallback from p50 1.5 s / p95 7.7 s (measured first with the tiers alone) to this: the rare-terms tier shrinks the candidate set when a question has more than three words, and both fallback tiers now rank only the newest 4 000 matching chunks instead of every match (D66). The second change is what the bench's synthetic tail needed: every word of its vocabulary sits in about 6 % of the chunks, so three of them match some 40 000 chunks whatever their rarity; real text has rarer words, so the first change will do more work there. The price of the bound: when more than 4 000 chunks hold a question's rarest words, the oldest ones are not ranked for that question. The lexeme statistics (51 174 lexemes) were rebuilt by the job before measuring.

For comparison, Phase 0 measured p95 215 ms for term searches and p95 6.5 s for the any-term fallback.

## 4. NFR-9: the round trip

`pnpm brain:export <dir> --verify` on the local store (2026-10-13): nine tables and 15 files exported (2.6 MB), imported into a temporary database on the same server; every table's count, every entity's version and title, and every file's hash matched; the database was dropped. The e2e test repeats it with a fresh project, entity and upload.

## 5. Staging

Deployed on 2026-10-13 at 01:25 local time with `pnpm staging:railway env app setup` (commit d62d9e6): the four services redeployed in 59 to 79 s each, every readiness check green on the first attempt; the brain API reports every Phase 1 feature on (`/features`: projects, people, systems, documents, tasks, reminders, ocrModel, and semantic search with the Google key); the setup registered `/project`, `/topic` and `/task` next to `/brain` in the team. The people sync was run once by hand so the directory holds the chat accounts before anyone signs in; the daily jobs take over from here (03:00 people, 07:00 stale projects, 08:00 reminders, 02:00 word statistics, every two minutes attachments, all Europe/Istanbul). Nothing of Phase 1 has been used by a person on staging yet: that is section 6.

## 6. The gate criteria, for the owner's people

The three criteria need real use (Q25). On staging (`https://brain-api-production-065d.up.railway.app`, chat `https://mattermost-production-6741.up.railway.app`):

1. **A real client project and an internal topic, fully described.** Create the project from the pages ("Projects and topics" → New project) or with `/project new` in chat; add the people and their roles, the client's systems (Systems → New system, then upload its DDL or API specification as an artifact), the documents, the milestones; let the project's channels fill with conversation. Make a topic from an existing channel with `/topic here`. "Fully described" means every panel of the home page has real content and every document shows "Extracted".
2. **"Who knows about X".** Open Search, type a subject, switch to "Who knows about this". The person who wrote about it, owns it or is assigned to it should come first or second.
3. **A non-technical user creates and completes a task without help.** Give someone the chat address only. Expected path: type `/task <what has to be done>` in a thread, or open "My tasks" on the pages and add one; the next morning's reminder (or the task page) has a Done button. Record what confused them.

What I will do with the result: fix what confused people, then record the outcome in this file and ask for acceptance.

## 7. Not verified, and known limits

- **The pages in a browser.** Built and type-checked, every string in the catalog, served by the API; not clicked through by me (the owner's walk-through is the gate's third criterion).
- **The model OCR for real.** Verified with the fake provider; the Gemini provider's request shape is the same call the Phase 0 spike used for images, but no real scanned document has gone through it yet. The first real upload of a scanned PDF on staging will show.
- **DDL dialects.** The reader covers the common `CREATE TABLE` grammar (Postgres, MySQL, SQL Server quoting); unusual constructs are kept as text, not structure.
- **Reminders at the real hour** run from the job runner's clock; the e2e test runs the job on demand.
- **The deferred FR-3 pieces** (Q26): live database introspection and WSDL/Postman structure.
- **Agents' use of `useAsContext` and suggestions** comes with Phases 2 and 4.
- **Scale**: no load test on Phase 1 data; the bench covers search only.

## Evidence

Logs on the machine that ran them (the session's scratch directory): `e2e-people.log`, `e2e-workspaces.log`, `e2e-docs-systems.log`, `e2e-tasks.log` (with `brain-api`), `e2e-export.log`, `bench-phase1.log`, `commit-deploy-t18.log`; the CI run named above.
