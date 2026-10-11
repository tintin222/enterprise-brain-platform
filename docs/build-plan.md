# Build plan

Eight phases. Each ends with acceptance criteria that must pass before the next begins. Report at the end of every phase: what was built, what was verified, what is still uncertain.

Phases 0 to 3 produce the first real demo: a person mentions an agent in Mattermost and gets an answer in the thread.

## Phase 0: Local stack and spike

Purpose: prove the integration points before writing product code.

Tasks:

1. Scaffold the monorepo (`packages/shared`, `bridge`, `agent-runtime`, `ingestion`, `infra`, `scripts`, `e2e`) with typecheck, lint and test wiring.
2. `infra/`: Docker Compose that starts Mattermost Team Edition (11.7.x ESR line) with its Postgres, the Buzz relay with its Postgres, Redis and object storage, and a Postgres for our state. Pin every image. Base the relay services on the compose files in the Buzz repository.
3. `pnpm dev:up` generates the bridge, reader and relay keys into `.env` (the relay reads `RELAY_OWNER_PUBKEY` when it starts, so this cannot wait for the seed) and starts the relay with membership required and the bridge key as owner. `pnpm dev:seed`: create a team, two people, the `@brain` bot with a token, and enable bot accounts and access tokens in Mattermost config; make the reader key a relay member.
4. Spike scripts in `scripts/spike/`, one per assumption A1..A12 in `docs/decisions.md`. Each prints a clear pass or fail and the observed behaviour.
5. Write `docs/spike-findings.md`: one entry per assumption with result, evidence and any spec change needed. Update the specs accordingly.

Acceptance:

- `pnpm dev:up && pnpm dev:seed` gives a working stack from a clean machine.
- A script publishes a chat event to the relay as key A and reads it back as key B.
- A script receives a Mattermost post over WebSocket and creates a post as a bot.
- Every assumption has a recorded result. Any failed assumption has an agreed alternative written into the relevant spec.

Stop here and wait for the owner to review the findings and answer the open questions in `docs/decisions.md`.

## Phase 1: Bridge, Mattermost to relay

Tasks:

1. `shared`: config loading and validation, structured logging, the key store (encrypt, decrypt, sign), `ChatClient` and `RelayClient` interfaces with real implementations.
2. Bridge state database and migrations (`docs/bridge-spec.md`, section 3).
3. Channel enablement when `@brain` joins; relay channel creation; membership mirroring for current members.
4. Custodial identity creation with relay membership and profile.
5. Mirror root posts and thread replies with mentions.
6. Catch-up on start and reconnect.

Acceptance: bridge-spec tests 1, 2, 4, 5, 7 and 8 pass in e2e.

## Phase 2: Bridge, relay to Mattermost

Tasks:

1. Agent provisioning operation (`docs/agents-and-ingestion.md`, A.2), callable from a script.
2. Relay subscriptions as the bridge's reader key, one per active channel (spike A7), with catch-up.
3. Mirror agent-authored messages into Mattermost as the agent's bot, in the right thread.
4. An echo agent script that replies "echo: ..." on the relay when mentioned, to exercise the full loop without a model.

Acceptance: bridge-spec test 3 passes; a person mentions the echo agent in Mattermost and sees exactly one reply in the thread; restarting any service mid-conversation causes no loss or duplicate.

## Phase 3: Agent runtime

Tasks:

1. Agent registry (table or adapter to the brain's agent definitions).
2. Dispatcher with membership check, trigger rules and the per-thread job queue.
3. Context assembly from the thread and channel.
4. `LlmProvider` interface and a default implementation; model id and key from configuration.
5. `BrainClient` interface with a stub `search` that returns nothing (real retrieval arrives in Phase 5).
6. Reply publishing, error reply, typing indicator if supported.
7. Guards: reply cap per thread, maximum event age, agent-to-agent rule.

Acceptance:

- Mentioning a real agent in Mattermost produces a relevant reply in the thread.
- Two agents in one channel do not loop.
- An agent that is not a member of the channel does not respond when mentioned.
- Mentions older than the age limit are ignored after a restart.

## Phase 4: Completeness

Tasks:

1. Edits and deletions in both directions.
2. Reactions in both directions.
3. Ongoing membership sync, rename and header changes, pause and archive.
4. Backfill of recent history when a channel is enabled.
5. Reconciliation job.
6. File attachments: permalink in content first; relay media upload only if needed.

Acceptance: bridge-spec test 6 passes; reactions round-trip; removing a person from a private Mattermost channel removes their relay membership within one reconciliation interval; backfilled history does not trigger agents.

## Phase 5: Ingestion and retrieval

Tasks:

1. Ingestion consumer with its own cursors.
2. Thread document rendering, debounce and chunking.
3. `BrainClient.upsertDocuments`, `deleteDocuments` and `search` against the real brain, or the local vector-search stub if no brain API exists yet.
4. Access scoping by channel at query time.
5. Wire retrieval into agent context.

Acceptance: all five ingestion tests in `docs/agents-and-ingestion.md` B.5 pass; an agent answers a question using content from an earlier thread in the same channel and cites the source link.

## Phase 6: Hardening

Tasks:

1. Metrics, health endpoints and structured logs for all three services.
2. Write throttling toward the relay and Mattermost.
3. Dead-letter inspection and replay tooling.
4. Key rotation procedure for service keys; master key handling documented.
5. Load test at the scale in Q7 of `docs/decisions.md`; check relay subscription and rate limits. Team Edition has a hard cap of 250 active users, below Q7's 500 people, so run the load test on a Mostlymatter build of the same version, which has no cap (Q14).
6. Relay rebuild drill: wipe the relay, replay from Mattermost, confirm agents and ingestion recover.
7. Security review of the prompt path and of private-channel retrieval.

Acceptance: load test meets the agreed targets; rebuild drill succeeds; no secret appears in logs.

## Phase 7: Productisation

Mostly outside this repository; listed so nothing is forgotten.

1. Replace the Team Edition container with a Mostlymatter build of the same version in staging.
2. Create our own thin Mattermost fork: the limits patch plus our name and logo. Server changes stay minimal and are published as the AGPL requires.
3. Build branded desktop and mobile apps from Mattermost's Apache-2.0 client repositories; run our own push notification proxy for mobile.
4. Sign-in stays Mattermost email and password: no SSO and no paid licence (Q6, D22).
5. "Add agent to channel" and "enable channel" actions in the brain product, calling the same provisioning operations.
6. Have a lawyer confirm the licence boundary before launch.

Acceptance: a new customer workspace can be created, branded clients connect, and an agent created in the brain can be added to a channel without touching a terminal.
