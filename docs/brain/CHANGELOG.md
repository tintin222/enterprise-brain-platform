# Company Brain changelog

One entry per phase (spec section 12), newest first. Requirement ids refer to `docs/COMPANY_BRAIN_SPEC.md`.

## Phase 0: Foundation (2026-10-12)

Plan: `01-phase0-plan.md`. Gate: `gates/phase-0.md`.

- **Knowledge store** (`packages/brain`, schema `brain`): containers (Project, Topic, General), channel links, entities with versions, typed links, chunks with keyword and vector indexes, the append-only audit log, an event outbox, installation settings. Migrations 0003 to 0006; the former thread documents became conversation entities. FR-9.1, FR-9.4, NFR-9.
- **Hybrid search**: keyword and vector halves fused by reciprocal rank inside the caller's scope, one result per entity, a relevance cutoff on semantic hits, citations with post permalinks. FR-9.2, FR-9.5.
- **Model providers** (`packages/models`): Anthropic and Google (Gemini) with a tool loop, the echo provider, embeddings from Google or a deterministic mock, provider and model per agent, a price table. Spec section 5, decision 2; D54, D56.
- **pgvector** compiled into our state-database image (`infra/state-postgres`), used by the local stack, the installation and staging. D52.
- **Capture of every channel** (D50): the bridge's sweep adds `@brain` to channels it never captured; opted-out channels stay out. FR-1.10.
- **Brain API** (`packages/brain-api`, `/api/v1/brain`): containers, entities, versions, links and backlinks, search, audit, JSON Lines export, the agent routes that left agent-runtime's admin API, the Mattermost setup, sign-in through Mattermost's OAuth 2.0 provider with signed session cookies, a service token, the `/brain` slash command (`search`, `link` with a dialog), dialog and button callbacks, the embedding worker, feature flags (D55). `API.md` is generated from the routes.
- **Pages** (`packages/brain-web`): search with filters, projects and topics, entity pages with fields, versions and backlinks, sign-in; every string in a catalog (NFR-10).
- **Clean install** (`install/`): one Compose bundle, an installer that runs in the services image, optional TLS with Caddy, `./install/brain test` as the gate's install check; services call Mattermost at `MM_API_URL` while `MM_URL` stays the public address (D58). NFR-12.
- **Checks**: `pnpm check:secrets` (key shapes, secret assignments, known values) and a CI workflow (typecheck, lint, unit, secrets, API reference, e2e, nightly clean install).
- **Tests**: `e2e/brain-api.e2e.test.ts` (gate, versions, audit, links, sign-in, access, channel linking, `/brain`, dialogs, agents, export), `e2e/capture.e2e.test.ts`, unit tests for the models, the store's pure parts and the string catalog; the earlier suites pass on the new store.
