# Operations

How to run, watch and repair the three services (bridge, agent-runtime, ingestion). Commands assume the local stack (`pnpm dev:up && pnpm dev:seed`); in production the same steps apply with the secrets in a secret manager instead of `.env`.

## 1. Health, readiness and metrics

Each service serves an operations endpoint on `OPS_HOST` (default `127.0.0.1`):

| Service | Command | Port setting (default) | Readiness checks |
| --- | --- | --- | --- |
| bridge | `pnpm bridge` | `BRIDGE_OPS_PORT` (9101) | database, Mattermost WebSocket, relay WebSocket |
| agent-runtime | `pnpm agent-runtime` | `RUNTIME_OPS_PORT` (9102) | database, relay WebSocket |
| ingestion | `pnpm ingestion` | `INGESTION_OPS_PORT` (9103) | database, relay WebSocket |

- `GET /healthz`: 200 while the process runs (liveness).
- `GET /readyz`: 200 with `{"ready":true,"checks":{...}}` when every dependency answers, otherwise 503 (readiness).
- `GET /metrics`: Prometheus text. It holds counts and timings only, never message content.

Metrics worth alerting on:

| Metric | Meaning | Alert when |
| --- | --- | --- |
| `brain_bridge_dead_letters_open` | Dead letters not replayed | above 0 (see section 3) |
| `brain_bridge_outbox_rows` | Signed events waiting for the relay | growing for minutes (relay unreachable or refusing) |
| `brain_bridge_mirror_lag_seconds{direction}` | From the source event to its mirrored copy | p95 above 5 s |
| `brain_relay_requests_total{status="429"}` | Relay rate-limit answers (retried) | sustained rate above 0: raise the relay limits or lower the throttles (section 2) |
| `brain_relay_reconnects_total`, `brain_chat_reconnects_total` | WebSocket reconnects | frequent |
| `brain_*_relay_subscriptions` | Subscriptions the relay confirmed, per service | below the number of enabled channels |
| `brain_runtime_jobs_total{outcome="failed"}` | Agent jobs that ended with an apology | rising |
| `brain_runtime_reply_seconds` | Mention to published reply | p95 above your target (D38) |
| `brain_ingestion_pending_threads` | Threads waiting to be indexed | growing |
| `brain_ingestion_index_lag_seconds` | First change of a thread to its indexing | p95 above debounce + 15 s |

Logs are JSON lines (pino) with a `service` field. Fields that can carry secrets are redacted. `pnpm check:logs <files>` searches log files for every secret in `.env` and in the key store and fails if one appears (section 4); with `ENV_FILE=.env.staging` and `--env-only` it checks staging's logs against staging's secrets (docs/staging.md).

## 2. Write throttling

| Setting | Default | Applies to |
| --- | --- | --- |
| `RELAY_REQUESTS_PER_SECOND` | 15 | Relay HTTP requests per signing key (the relay allows 1200 per minute per key, D20) |
| `MM_REQUESTS_PER_SECOND` | 20 | Mattermost API requests per token (the bridge, each agent bot, provisioning) |
| Subscription pacing | 40 REQ per second per connection | Relay subscriptions (the relay allows 50 frames per second per key) |

Each service throttles itself; waits show in `brain_throttle_wait_seconds{target}`. The relay answers excess traffic with 429, which clients retry after the delay it asks for.

## 3. Dead letters

The bridge retries each mirroring step (three attempts, or eight for relay publishes with backoff) and then records it in `bridge.dead_letter` so the channel keeps moving.

- `pnpm dead-letter list [--direction mm_to_relay|relay_to_mm] [--all] [--limit <n>]`: open dead letters (with `--all`, replayed ones too), one line each, without message text.
- `pnpm dead-letter show <id>`: the stored payload (it can contain message text).
- `pnpm dead-letter replay <id> [<id> ...]` or `replay --all`: replay. Safe while the bridge runs, and idempotent.

Replay behaviour: a relay event is handled again. A signed event from the outbox is published again through the same completion when the relay still accepts it (created_at within about 15 minutes). Otherwise the post, or its reactions, is mirrored again from Mattermost's current state. A dead letter for a channel that is no longer mirrored (paused or archived) is closed as "not needed".

## 4. Secrets and keys

| Secret | Where | Used by | Rotation |
| --- | --- | --- | --- |
| `KEY_ENCRYPTION_KEY` (master key) | Environment (`.env` locally; a secret manager or KMS in production) | All services, to open the key store | `pnpm keys:rotate-master` |
| Custodial person keys, agent keys, agent bot tokens | Key store (`identity.secrets`, AES-256-GCM under the master key) | Bridge, agent-runtime | Agent tokens: see below. Person keys are identities and are not rotated. |
| `BRIDGE_SECRET_KEY` | Environment | Bridge (relay owner and owner of every channel) | `pnpm keys:rotate-bridge` |
| `READER_SECRET_KEY` | Environment | All services (shared reader, Q12) | `pnpm keys:rotate-reader` |
| `MM_BRIDGE_TOKEN` | Environment | Bridge (`@brain`) | New token, swap, revoke (below) |
| `MM_ADMIN_TOKEN` | Environment | Agent provisioning only (D25) | New token, swap, revoke |
| `ANTHROPIC_API_KEY` | Environment | agent-runtime | Provider console |
| `BUZZ_RELAY_PRIVATE_KEY`, database and Redis passwords | Environment of the stack | Relay and databases | Change and restart the stack (`pnpm dev:up`) |

**The master key.** It protects every custodial and agent key and every agent bot token. Keep it only in the environment or a secret manager with versioned backups, never in the repository, in logs or in tickets. Losing it loses every person's and agent's relay identity: new keys would mean new authors on the relay, and every agent must be provisioned again. Back it up when it is created and after each rotation.

**Rotating the master key.** Stop the bridge, agent-runtime and ingestion, then run `pnpm keys:rotate-master`. It writes the new key to `.env` as `KEY_ENCRYPTION_KEY_NEXT` before anything depends on it, re-encrypts every secret in one transaction (key version +1), then makes it `KEY_ENCRYPTION_KEY`. If it stops halfway, run it again: it detects secrets that already use the new key and finishes the switch. Start the services again.

**Rotating the reader key.** `pnpm keys:rotate-reader` adds a new key to the relay and to every channel the old reader is in, and writes it to `.env` (the old one stays as `READER_SECRET_KEY_PREVIOUS`). Restart the three services, then run `pnpm keys:rotate-reader --finish` to remove the old key from the channels and the relay. The bridge's reconciliation also removes it from active channels on its own. A removed key's open sockets stay connected until they reconnect (spike A6), so restart anything that might still hold one.

**Rotating the bridge key.** `pnpm keys:rotate-bridge` makes a new key a relay owner (9030, then 9032) and an owner of every channel the old key owns (9000 with role owner). Archived channels refuse changes and keep the old owner, which loses relay access in the finishing step. The new key goes to `.env` as `BRIDGE_SECRET_KEY` (`RELAY_OWNER_PUBKEY` follows), and the old one stays as `BRIDGE_SECRET_KEY_PREVIOUS`. Run `pnpm dev:up` so the relay restarts with the new owner, restart the bridge, then run `pnpm keys:rotate-bridge --finish`. Finishing removes the old key from each channel and from the relay. The relay answers its attempt to step down with "must be owner", because the restarted relay already made the configured key its owner; that refusal is expected.

**Mattermost tokens.** For `MM_BRIDGE_TOKEN` or `MM_ADMIN_TOKEN`: create a new personal access token for the account (System Console > Integrations, or `POST /api/v4/users/{id}/tokens` as an admin), put it in the environment, restart what uses it, then revoke the old token. For an agent's bot token: revoke it in Mattermost, run `pnpm agent:provision --handle <handle> --name "<Name>"` (it detects the dead token and stores a new one), and restart the bridge, which caches bot clients.

Every rotation script was run against the local stack on 2026-10-12, with the e2e tests passing after each step.

## 5. Relay rebuild

When the relay loses its data, the bridge rebuilds it from Mattermost:

1. Stop the bridge, agent-runtime and ingestion.
2. Make sure the relay runs empty, with the same `RELAY_OWNER_PUBKEY`. Locally, `pnpm relay:wipe --yes` deletes its data and restarts it.
3. Run `pnpm relay:rebuild`. It forgets what the bridge and ingestion knew about the relay's contents: message, reaction and outbox maps, cursors, the identities' relay membership and profile flags, and ingestion's documents and state. Keys, enabled channels and purge exclusions stay. It marks every enabled channel for a full replay and makes the reader key a relay member again.
4. Start the services. The bridge creates every enabled channel again, re-adds members, and replays each channel's whole history from Mattermost as backfill (tagged, so agents never answer it). People's posts are signed with their own keys and agents' posts with the agents' keys, with current text and reactions. Ingestion re-indexes the rebuilt relay from the beginning.
5. Check: `pnpm dead-letter list` is empty, every service is ready, and the subscription gauges match the number of enabled channels.

What does not come back: event ids (every event is new), the extra posts of an agent message split for being over 16,000 characters, agents' reactions, and deleted posts, which are not history.

The drill runs as an e2e test: `E2E_RELAY_DRILL=1 pnpm test:e2e relay-rebuild`. It wipes the local relay, so it is opt-in.

## 6. Mattermost build

Three builds of Mattermost 11.7.12 run on the same data, chosen with `pnpm dev:up --team-edition`, `--mostlymatter` or `--enterprise-brain` and stored as `MATTERMOST_EDITION` in `.env`:

| Edition | Image | User limit | Branding |
| --- | --- | --- | --- |
| `team` (default) | The pinned Team Edition image | 250 | Mattermost |
| `mostlymatter` | `infra/mostlymatter/Dockerfile` (Framasoft's binary, D40) | None | Mattermost |
| `enterprise-brain` | `infra/chat/Dockerfile` (our fork's release, D48); staging runs it | None | Enterprise Brain |

**Upgrading our fork.** In `tintin222/enterprise-brain-chat`, create a branch from the new upstream tag and carry over the commits of `enterprise-brain/<current version>` (the limits change, the branding and the release workflow). Run the "Enterprise Brain release" workflow with a new release name; it runs the user-limit tests, builds the server and the web app, and publishes them with `SHA512SUMS`. Put the release name and the three sums into `infra/chat/Dockerfile`, then run `pnpm dev:up --enterprise-brain`, `pnpm spike`, `pnpm spike X3` and `pnpm test:e2e` before `pnpm staging:railway mattermost`.

Development uses Team Edition 11.7.12. `pnpm dev:up --mostlymatter` switches the same stack and data to Mostlymatter 11.7.12, which has no 250-user cap (D11, D22, Q14); `pnpm dev:up --team-edition` switches back. The choice is stored as `MATTERMOST_EDITION` in `.env`. The image is built from `infra/mostlymatter/Dockerfile`: the pinned Team Edition image with Framasoft's Mostlymatter binary, pinned by SHA-512 and checked once against Framasoft's minisign signature. Building it needs the Docker buildx plugin (`brew install docker-buildx`).

## 7. Load test

`pnpm load-test` runs at the scale of Q7 (500 people, 300 channels, 50 agents) against a Mostlymatter stack, with the three services running as separate processes. Targets and results are in `docs/load-test.md`.
