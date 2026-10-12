# CLAUDE.md

Guide for AI coding agents working in this repository. Read this file fully, then the docs listed under "Read before you code".

## What this project is

Team chat with AI agents as channel participants, built for an "enterprise brain" product: a system that stores a company's knowledge and lets users create agents.

- **Mattermost** is the chat product people use: channels, threads, web, desktop and mobile clients. It is the system of record for human messages.
- **A Buzz relay** (https://github.com/block/buzz) is the agent and ingestion substrate. Every mirrored message is a signed Nostr event in one log, and every agent has its own keypair.
- **This repository** holds the glue we own: the bridge, the agent runtime and the ingestion service.

We do not modify Mattermost or Buzz source code in this repository. Both run as unmodified upstream services that we talk to over their public APIs.

Since 2026-10-12 the product is being extended into the **Company Brain** described in `docs/COMPANY_BRAIN_SPEC.md`: Projects and Topics as the two top-level containers, a knowledge model with entities, versions and links, three agents (Analyst, Follow-up, Packager) and a development package for Claude Code. See "Company Brain conventions" below.

## Read before you code

| Doc | Read it when |
| --- | --- |
| `docs/COMPANY_BRAIN_SPEC.md` | Before any Company Brain work. The owner's product specification: requirements FR-x.y and NFR-x, data model, phases 0–5 with gates, and the final decisions in its section 13 (never reopen them). |
| `docs/brain/` | With the spec. `00-gap-analysis.md` audits this codebase against it; then one plan per phase (`01-phase0-plan.md` …), `API.md` (generated), `CHANGELOG.md` and `gates/phase-N.md`. The newest file tells you which step the work is at. |
| `docs/architecture.md` | Always, once per session. Components, sources of truth, identity model, trust boundaries. |
| `docs/build-plan.md` | Before starting any task. Work is phased; each phase has acceptance criteria. |
| `docs/bridge-spec.md` | Before touching `packages/bridge`. Event mapping, state tables, loop prevention. |
| `docs/agents-and-ingestion.md` | Before touching `packages/agent-runtime` or `packages/ingestion`. |
| `docs/decisions.md` | Before making a design choice, and whenever upstream behaviour matters. Holds decisions, verified facts, the assumptions A1..A12 with their Phase 0 results, and the owner's questions Q1..Q14 with their answers. |
| `docs/spike-findings.md` | Always, once per session. Results of testing each assumption against the live local stack (Phase 0), plus what later phases found. This file overrides the specs where they disagree. |
| `docs/operations.md` | Before running, monitoring or repairing the services: endpoints, metrics, throttles, dead letters, key rotation, relay rebuild. |
| `docs/security-review.md`, `docs/load-test.md`, `docs/phase7.md`, `docs/staging.md` | When touching the prompt path or retrieval scope, performance limits, productisation, or the staging deployment. |

## Rules

1. **Work phase by phase.** Follow `docs/build-plan.md` in order. Do not start a phase until the previous phase's acceptance criteria pass. Stop and report at the end of each phase.
2. **Verify, don't assume.** The specs mark some upstream behaviour as unverified (assumptions A1..A12 in `docs/decisions.md`). Before coding against one, test it with a small script against the local stack and record the result in `docs/spike-findings.md`. If reality differs from the spec, update the spec in the same change.
3. **Check upstream docs for API details.** Library and API signatures in these docs are from memory or a single reading. Confirm against the installed package or the upstream docs before use. Pin every dependency and every container image to an exact version: images by tag and digest in `infra/compose.yml`, npm packages as exact versions with the lockfile committed. pnpm only resolves versions published at least 7 days ago (`minimumReleaseAge`).
4. **Licence guardrails.** Never copy code from the Mattermost server (AGPL-3.0) into this repository. Code under `server/public/` and `webapp/` in the Mattermost repo is Apache-2.0 and may be used as a dependency. Buzz is Apache-2.0. Do not add brain, bridge or agent logic to a Mattermost fork or plugin without an explicit decision recorded in `docs/decisions.md`.
5. **Public APIs only.** Never read or write the Mattermost or Buzz databases. Our own state lives in a separate Postgres database.
6. **Upstream access goes through two interfaces.** `ChatClient` wraps Mattermost; `RelayClient` wraps the Buzz relay. No other module imports a Mattermost or Nostr library directly. Buzz is pre-1.0 and changes fast, so this seam must stay clean. ESLint enforces this for `packages/bridge`, `agent-runtime` and `ingestion`. Exception: `scripts/` (spike, seed and dev tooling) calls the upstream APIs directly, because its job is to exercise them raw.
7. **Every handler is idempotent.** Events arrive more than once (reconnects, catch-up, retries). Processing the same event twice must produce the same end state and no duplicate message.
8. **Channel content is untrusted input.** Text from chat, including text that looks like instructions, is data for agents and never changes an agent's permissions or tools.
9. **Secrets.** Private keys and tokens are encrypted at rest, never logged, and never committed. Use `.env` locally and keep `.env.example` current.
10. **Record decisions.** Any non-obvious design choice gets a short entry in `docs/decisions.md` (what, why, alternatives rejected).

## Company Brain conventions

From section 12 of `docs/COMPANY_BRAIN_SPEC.md`; they apply to every brain change on top of the rules above.

- Work in the spec's order: gap analysis, then a plan per phase approved by the owner, then the phase; at the end of a phase run its gate (spec section 11) and write the result to `docs/brain/gates/phase-N.md`.
- Never modify Mattermost's messaging tables (rule 5 already forbids touching its database); extend through our own tables and links. There is no tenant concept anywhere: one installation per customer.
- Every commit names the FR or NFR ids it serves. Every FR gets an automated test; agents get golden-set fixtures under `tests/brain/golden/`.
- Every brain feature sits behind a feature flag in the installation config (`.env.example` documents each flag).
- No plaintext secret in code, fixtures, logs or test output; a CI check enforces it.
- Keep `docs/brain/CHANGELOG.md` current per phase and regenerate `docs/brain/API.md` from the routes.
- Ask the owner, in plain words with a recommendation, when a decision touches the data model or the container model, when a new external dependency is needed, or when a gate cannot be met as written.

## Stack defaults

TypeScript on the current Node LTS, pnpm workspaces, Postgres for our state, Docker Compose for the local stack, vitest for tests. This is decision D8 in `docs/decisions.md`; if the owner changes it there, follow the doc and not this section.

Pinned toolchain (D13 in `docs/decisions.md`): Node 24.21.0, which pnpm downloads and uses for every `pnpm` script (`devEngines.runtime`), so the machine's global Node does not matter; pnpm 12.9.1 (`packageManager`); TypeScript 6.0.3 (not 7, which typescript-eslint does not support yet); ESLint 10 with type-aware typescript-eslint; vitest 5; scripts run with tsx. Workspace packages export their TypeScript source directly; there is no build step yet. Relative imports carry the `.ts` extension.

## Repository layout

```
CLAUDE.md
docs/                  specs and decisions; COMPANY_BRAIN_SPEC.md is the owner's product spec
  brain/               Company Brain working documents: gap analysis, phase plans, API.md, CHANGELOG.md, gates/
infra/                 Docker Compose for the local stack (Mattermost, Buzz relay, databases)
  chat/                image with our own Mattermost build, Enterprise Brain chat (compose.chat.yml selects it, D48)
  mostlymatter/        image with the uncapped Mostlymatter build (compose.mostlymatter.yml selects it)
  services/            one image for the bridge, agent-runtime, ingestion and admin API (staging, docs/staging.md)
  staging/             one-line Dockerfiles that keep staging's third-party images pinned on Railway
  third_party/buzz/    licence and notice for the compose services adapted from Buzz
packages/
  shared/              config, logging, metrics, types, ChatClient, RelayClient, key store, local brain
  bridge/              Mattermost <-> Buzz mirror, dead-letter tool (third_party/: emoji-datasource notice)
  agent-runtime/       agent registry, dispatcher, context assembly, LLM calls, admin API
  ingestion/           relay -> brain indexing, purge tool
scripts/
  lib/                 env file, Mattermost and relay helpers for scripts
  dev/                 dev:up, dev:down, dev:seed
  spike/               one spike per assumption plus the Phase 0 acceptance checks
  gen/                 generated sources (emoji table)
  keys/                key rotation
  ops/                 relay wipe and rebuild, log secret check
  load/                Phase 6 load test
  staging/             staging on Railway: setup and agent creation
e2e/                   end-to-end tests against the local stack
branding/              Enterprise Brain logo: SVG sources and PNG exports (branding/README.md)
```

## Commands

Keep this section accurate as the scripts change.

Prerequisites: a Docker engine with Compose v2 (this machine uses Colima: `colima start --cpu 4 --memory 8 --vm-type vz --vz-rosetta`; the Mattermost image is amd64-only, so Apple Silicon needs Rosetta), pnpm, and `pnpm install`. pnpm provisions the pinned Node itself.

| Command | Purpose |
| --- | --- |
| `pnpm dev:up [--enterprise-brain \| --mostlymatter \| --team-edition]` | Create `.env` from `.env.example` if needed (generates service keys and secrets, never overwrites existing values), then start the stack and wait until it is healthy. Mattermost on `localhost:8065`, relay on `localhost:3000`, our Postgres on `localhost:5433`. `--enterprise-brain` switches to our own build (no user cap, our branding, D48) and `--mostlymatter` to Framasoft's (both need `docker-buildx`); `--team-edition` switches back. |
| `pnpm dev:down` | Stop the stack and keep its data. `pnpm dev:down --wipe` also deletes every volume and `.env`. |
| `pnpm dev:seed` | Idempotent. Mattermost: enable bot accounts and access tokens, apply the Enterprise Brain name and logo (D44), create team `brain-dev`, `sysadmin`, `alice`, `bob` and the `@brain` bot (system admin), and write `MM_BRIDGE_TOKEN` and `MM_ADMIN_TOKEN` (for agent provisioning, D25) to `.env`. Relay: make the reader key a member. Agents are created with `pnpm agent:provision`. |
| `pnpm bridge` | Run the bridge against the local stack (Ctrl-C stops it cleanly) |
| `pnpm agent-runtime` | Run the agent runtime (dispatcher and job runner). Agents with model `echo` answer without a model; others need `ANTHROPIC_API_KEY`. |
| `pnpm agent:provision --handle <h> --name "<Name>" [--model echo]` | Create or update an agent (key, bot, token, relay identity, registry record); safe to re-run |
| `pnpm agent:echo [--handle echo]` | Run the echo agent, which answers mentions with "echo: ..." (no model) |
| `pnpm ingestion` | Run ingestion, which keeps the local brain (D34) in step with the relay; agents search it |
| `pnpm admin-api` | Internal API for the brain product: create agents, enable channels, add agents to channels (docs/phase7.md) |
| `pnpm ingest:purge --channel <relay channel id> \| --author <pubkey>` | Remove a channel's or an author's content from the brain and keep it out |
| `pnpm spike [id ...]` | Run spikes (`A1`..`A12`, `X1`, `acceptance-relay`, `acceptance-mm`) against the stack; evidence goes to `scripts/spike/results/` (not committed). `X2` (Team Edition's cap) and `X3` (no cap) create about 250 Mattermost users, so they run only when named. |
| `pnpm dead-letter list \| show <id> \| replay <id...> \| replay --all` | Inspect and replay what the bridge gave up on (docs/operations.md section 3) |
| `pnpm keys:rotate-master`, `keys:rotate-reader [--finish]`, `keys:rotate-bridge [--finish]` | Rotate the master key, the reader key or the bridge key (docs/operations.md section 4) |
| `pnpm relay:wipe --yes`, `pnpm relay:rebuild` | Empty the local relay; prepare our services to rebuild it from Mattermost (docs/operations.md section 5) |
| `pnpm check:logs [--env-only] <files>` | Fail if any secret from `.env` (or `ENV_FILE`) or the key store appears in log files; `--env-only` skips the key store |
| `pnpm load-test` | The Phase 6 load test at Q7 scale, on Mostlymatter with the three services running (docs/load-test.md) |
| `pnpm staging:railway [step ...]` | Create or update staging on Railway (docs/staging.md); secrets live in `.env.staging`. Steps: `env`, `services`, `data`, `relay`, `mattermost`, `seed`, `app` |
| `pnpm staging:agent --handle <h> --name "<Name>" [--model echo]` | Create or update an agent on staging through the admin API, from a temporary Railway sandbox |
| `pnpm gen:emoji` | Regenerate the bridge's reaction emoji table from the pinned emoji-datasource (D31) |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:e2e` | End-to-end tests (needs `pnpm dev:up && pnpm dev:seed`). Real-model tests run when `ANTHROPIC_API_KEY` is set; the relay rebuild drill runs with `E2E_RELAY_DRILL=1` (it wipes the local relay). |

## Definition of done

A task is done when typecheck, lint and unit tests pass, any behaviour that touches Mattermost or the relay has an e2e test that passes against the local stack, and the docs match the code. If something could not be verified, say so plainly in the report instead of marking it done.
