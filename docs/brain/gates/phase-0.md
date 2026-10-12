# Phase 0 gate: Foundation

Run on 2026-10-12 against branch `brain-phase0` (the Phase 0 commits), following the procedure in `01-phase0-plan.md` section 19. The spec's gate for Phase 0 (`docs/COMPANY_BRAIN_SPEC.md` section 11): **clean install from scratch passes its test; any entity is searchable within 5 s of creation.**

Verdict: **passed, with one measured limit to decide on.** Both spec criteria hold, on this machine and on a fresh CI runner (item 1). NFR-1 (item 3) is met for term searches after a ranking change made during the gate (D61) and not for the keyword fallback that natural-language questions take, which is put to the owner with a proposal. Item 4 (the export round trip) is met in a weaker form than the plan wrote, see there. The first CI run also found a defect the local stack had hidden (item 1, the Linux `host.docker.internal` case), fixed the same evening. What was not verified is in item 6.

## 1. Clean install (NFR-12)

`./install/brain test` (`install/test.sh`): from no `config.env` and no volumes to a seeded workspace, the self-test, then a wipe.

| Where | Result | Time |
| --- | --- | --- |
| This laptop (Apple Silicon, Colima VM with 4 CPUs and 8 GB; images already built) | passed, `searchableAfterMs: 29`, `/brain` registered in 1 team, export manifest present, bridge, agent-runtime and ingestion ready | 34 s |
| Fresh GitHub runner (`ubuntu-24.04`, nothing cached; CI job "Clean install", run [38294427228](https://github.com/tintin222/enterprise-brain-platform/actions/runs/38294427228)) | passed, `searchableAfterMs: 63`, every service ready | 122 s, image builds included (pgvector compiles in well under a minute on amd64) |

NFR-12 allows one hour. On this laptop the first ever run also built the images: the services image (pnpm install about 16 s, the pages' dependencies 45 s and their build a few seconds), the state database with pgvector (about two minutes of compilation) and our Mattermost build (a download of the release); the Mattermost chat image is amd64 and runs under Rosetta here.

The gate run earned its keep: the first four attempts failed and each failure was a defect in the bundle, fixed before the fifth run passed:

1. The pages' build stage lacked `tsconfig.base.json` (`infra/services/Dockerfile`).
2. The installer's seed stored the OAuth secret before any service had created the key store's table; the seed now runs the identity migration itself (`scripts/install/run.ts`, and `pnpm dev:seed` the same).
3. Inside the Compose network the services called Mattermost at the public address (`localhost:8065`, which is the container itself). `MM_API_URL` now carries the address services call, `MM_URL` stays the public one (D58); staging uses the private hostname the same way.
4. A `POST` without a body but with a JSON content type was refused (`/setup/mattermost`); the API now accepts it and the clients send none.

A fifth defect was found by `pnpm check:secrets` during the run: `install/config.env` was not git-ignored. It is now, and in `.dockerignore`. Nothing had been committed. A sixth came from CI: on Docker Engine for Linux, Mattermost could not resolve `host.docker.internal`, the address the dev stack's brain API is called back at, so the slash-command and dialog e2e tests failed on the runner (they pass on Colima and Docker Desktop, which define the name). The Mattermost service now defines it through `extra_hosts`; the CI step also hid the failing suite behind a `tee` without `pipefail`, which is fixed too.

## 2. Searchable within 5 s (the spec's second criterion)

Time from `POST /api/v1/brain/entities` to the first `GET /search` that returns the entity, measured by the installer's self-test (polling every 200 ms, keyword search; the embedding worker is asynchronous and semantic hits are fused in when they exist).

| Where | Runs | Results |
| --- | --- | --- |
| Local installation (`./install/brain selftest` ten times in a row) | 10 | 6, 8, 8, 8, 9, 9, 10, 12, 17, 43 ms; median 9 ms, p95 43 ms (with ten samples, the maximum) |
| Staging, through the public address `https://brain-api-production-065d.up.railway.app` (Railway EU West, called from Istanbul; the embedding worker live with Google embeddings) | 3 | 806, 826, 861 ms; about three HTTPS round trips of the measuring loop itself |
| e2e `brain-api.e2e.test.ts`, "gate: an entity is searchable within 5 s" (keyword and, with the mock provider, semantic) | 1 per suite run | passes; the semantic hit needs the worker's next round (2 s interval) |

## 3. NFR-1: search latency

`pnpm brain:bench --chunks 250000 --queries 200` on the local state database (pgvector 0.8.7, HNSW index, 1536 dimensions), 23:05 local time, the stack otherwise idle. Synthetic data: 50 000 entities of six types with five chunks each; every chunk a title plus 60 words from a 5 000-word vocabulary with a heavy head (a few words in nearly every chunk, most words in a few per cent of them); random unit vectors. The spec's target is hybrid p95 under 1.5 s for 1 M messages and 50 k document chunks; the bench's 250 k chunks stand in for that (a message thread becomes one chunk per about 6 000 characters). Two kinds of query:

| Query | Keyword | Semantic | Hybrid |
| --- | --- | --- | --- |
| **Remembered words**: three words taken from a stored chunk and its vector (200 queries), the way a person searches for something they read | p50 71 ms, p95 222 ms, max 283 ms | p50 4 ms, p95 5 ms, max 8 ms | **p50 68 ms, p95 215 ms**, max 254 ms |
| **Unrelated words**: three random words that occur together in no chunk (50 queries), which is what a natural-language question looks like to the keyword half | p50 1.5 s, **p95 6.5 s**, max 6.6 s | (same as above) | (keyword-bound) |

**NFR-1 is met for term searches (hybrid p95 215 ms, 7× under the target) and not for the fallback.** The first bench run, before D61, ranked every chunk holding any query word for every query and gave p50 1.5 s, p95 6.4 s across the board; ranking chunks that hold all the terms first (D61, one SQL statement, the slow half skipped by a one-time filter, verified in the plan) is what brought term searches to tens of milliseconds. When no chunk holds every term, the any-term ranking still costs seconds at 250 k chunks, because Postgres must rank tens of thousands of matching chunks to find the top 60. That is the case for agents' questions (where the vector half carries recall and the model call dominates latency) and for questions typed into the search box.

Proposal for the owner (asked in the Phase 0 report): accept Phase 0 with this measured limit, and put a fallback improvement in Phase 1, when real data shows what questions people type. Candidates, in order of preference: rank the fallback with word statistics so the rarest query words choose the candidates (needs a small term-frequency table kept by the embedding worker); cap the ranked set to the most recent N thousand matching chunks (changes meaning for old content); a ranking index extension (RUM), which is not in the pinned Postgres image.

Caveats: a laptop; synthetic vectors are uniformly random, which makes the HNSW search harder than real embeddings (no cluster structure) and still gave single-digit milliseconds; the word distribution is a model of real text, not real text. The numbers describe the index behaviour, not capacity; the Phase 6 load test (`docs/load-test.md`) remains the place for end-to-end throughput.

## 4. NFR-9: export

The export is the JSON Lines set described in `export-format.md` (`GET /api/v1/brain/export/manifest` and one `.jsonl` per table). The e2e test "export: manifest and tables" fetches the manifest and every table and checks that the row counts match and that the entities and chunks created in the test are present with their ids and versions. The installer's self-test checks the manifest on every clean install.

Weaker than the plan: the plan's item 4 said "re-imported into an empty database by `pnpm brain:export --verify`". That import tool does not exist yet; it belongs with Phase 1's document files (`export-format.md` says so). NFR-9 as the spec words it (an open, documented export of everything the brain holds) is met; the round trip into an empty database is a Phase 1 task.

## 5. Section 10 acceptance test

Not applicable until Phase 3 (the agents), as the plan noted.

## 6. Not verified, and the owner's checks

- **The Google chat provider end to end.** Spike B6 ran it for real (tool use with replayed turns); since then it is covered by unit tests on fake transports only. No staging agent uses it yet (`pnpm staging:agent --provider google` creates one).
- **Semantic search with real embeddings on staging.** The key is configured there; locally the e2e suite uses the mock provider. The worker's metrics (`brain_embed_pending`, `brain_embed_chunks_total`) show whether embeddings flow.
- **The pages in a browser.** They were served and fetched (`index.html`, the bundle, the sign-in redirect to Mattermost) but not clicked through by me. The owner's walk-through on staging: open the brain address, sign in with the chat account, search, open a project and an entity.
- **`/brain` in a real chat client.** `search`, `link` (with its dialog) and `help` pass the e2e tests through Mattermost's command endpoint; the owner tries them in the web app.
- **Membership changes and the 20 s cache** (`docs/security-review.md` R8): tested in e2e for private channels; the window itself is by design.
- **The full e2e suite**: run by CI on every push (job "End-to-end tests on the local stack"). Run 38294427228: 45 passed, 3 skipped (real-model tests, no key in CI), 2 failed, the two Mattermost-callback tests described in item 1; after the fix, run [38295681661](https://github.com/tintin222/enterprise-brain-platform/actions/runs/38295681661) passed every job: 47 passed | 3 skipped (the skipped tests need a real model key).
- **Staging under load**: not measured; the Phase 6 load test was not repeated.

## Evidence

Logs of the runs are on the machine that ran them (the scratch directory of the session) and in the CI run named above: `install-test-5.log` (the passing clean install), `gate-selftest-x10.log`, `bench-250k.log`, `staging-app.log`.
