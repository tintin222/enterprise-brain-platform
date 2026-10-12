# Staging on Railway

Status: deployed on 2026-10-12 in the owner's Railway workspace (Pro plan), project `enterprise-brain-staging`, region EU West (Amsterdam). Mattermost, our own build of 11.11.1 (D48), is at https://mattermost-production-6741.up.railway.app; the brain's pages and API (Company Brain Phase 0) at https://brain-api-production-065d.up.railway.app. The Railway facts below were checked against Railway's documentation, pricing page and CLI on 2026-10-12, and while deploying (spike findings item 33).

Sign-in: `sysadmin` (system admin), `alice` and `bob`, in team Enterprise Brain. Their passwords are `MM_ADMIN_PASSWORD` and `MM_PERSON_PASSWORD` in `.env.staging` on the machine that created staging. Mattermost cannot send email yet (no SMTP server configured), so add people from the System Console or with the team's invite link.

## Layout

Every service sits on the project's private network; Mattermost and the brain API have public HTTPS addresses.

| Railway service | Built from | Volume | Reachable from |
| --- | --- | --- | --- |
| `mattermost` | `infra/chat/Dockerfile` (our own build, Enterprise Brain chat 11.11.1, D48) | `/mattermost/data` | Public HTTPS domain |
| `mm-postgres`, `buzz-postgres` | `infra/staging/postgres` (the Postgres image pinned in `infra/compose.yml`) | Database files | Private network |
| `state-postgres` | `infra/state-postgres` (the same Postgres image with pgvector compiled in, D52) | Database files | Private network |
| `buzz-redis` | `infra/staging/redis` | `/data` | Private network |
| `buzz-s3` | `infra/staging/s3` (also creates the relay's bucket) | `/data` | Private network |
| `relay` | `infra/staging/relay` (`ghcr.io/block/buzz:0.2.1`, pinned) | None | Private network only |
| `bridge`, `agent-runtime`, `ingestion` | `infra/services/Dockerfile`, one image with a different start command each | None | Private network |
| `brain-api` | the same image, `packages/brain-api/src/main.ts`: the brain API, the pages and the embedding worker | None | Public HTTPS domain (`BRAIN_PUBLIC_URL`) and the private network (Mattermost's callbacks, `BRAIN_INTERNAL_URL`) |

Each third-party image is wrapped in a one-line Dockerfile, because Railway does not document digest pins for image sources (D46).

## How it differs from the local stack

- **One volume per service.** Mattermost keeps its configuration in its database (`MM_CONFIG` set to the database URL) and its files on the volume. Postgres keeps `PGDATA` in a subdirectory of its volume. The relay keeps its git data in the image; we use none of its git features.
- **Volume ownership.** Railway mounts volumes as root, and Mattermost's image runs as user 2000, so the Mattermost service sets `RAILWAY_RUN_UID=0` and runs as root inside its container.
- **Hostnames.** Services reach each other as `<service>.railway.internal`. The relay's `RELAY_URL` is `ws://relay.railway.internal:3000`, because the host in that URL names the relay's only community (spike findings); changing it later starts an empty community. Our services call Mattermost's API at `MM_API_URL` (`http://mattermost.railway.internal:8065`, private, no egress) while `MM_URL` stays the public address for links and sign-in (D58).
- **Bind addresses.** The relay listens on `[::]:3000` (`BUZZ_BIND_ADDR`), our services' operations endpoints on `::` (`OPS_HOST`) and the brain API on `::` too (`BRAIN_API_HOST`), which accept IPv4 and IPv6.
- **Mattermost's address.** `MM_URL` and Mattermost's SiteURL are the public HTTPS address, so links in agent answers work for people.
- **Secrets.** `pnpm staging:railway` generates them into `.env.staging` (ignored by git and by `railway up`, mode 600) with the same generators as `.env`, and sends them to Railway on standard input, so no secret appears on a command line or in a log. Each of our services gets only the settings its configuration reads; `MM_ADMIN_TOKEN` reaches only the brain API, which provisions agents and registers the brain with Mattermost. Railway stores variables encrypted; it offers sealing (write-only variables) only in its dashboard.
- **Reader key membership and the brain's registration.** Neither the relay nor the state database can be reached from outside, so the seed runs with `--skip-relay --skip-brain`: the bridge, as relay owner, makes the shared reader key a relay member every time it starts (D45), and the `setup` step registers the brain with Mattermost (allow-list, OAuth app, `/brain`) by calling `POST /api/v1/brain/setup/mattermost` from a sandbox.
- **Healthchecks and restarts.** Railway checks `/readyz` (bridge, agent-runtime, ingestion, brain-api), `/_readiness` (relay) and `/api/v4/system/ping` (Mattermost) when a deployment starts, and restarts every service whenever it stops.
- **No Railway config file.** Railway's `railway.json` is deprecated and stops being read on 2026-12-01, so `pnpm staging:railway` applies settings through Railway's CLI and public GraphQL API.

## Running it

| Task | Command |
| --- | --- |
| Create or update staging (all steps, each safe to repeat) | `pnpm staging:railway` |
| One step: `env`, `services`, `data`, `relay`, `mattermost`, `seed`, `app`, `setup` | `pnpm staging:railway app` (redeploys our four services from the working tree); `--service <name>` limits a step to one service |
| Create or update an agent | `pnpm staging:agent --handle <h> --name "<Name>" [--provider anthropic\|google\|echo] [--model <id>]` |
| Logs | `railway logs --service bridge` (`--build` for build logs) |
| Check logs for secrets | Save logs to files, then `ENV_FILE=.env.staging pnpm check:logs --env-only <files>` |
| Usage and cost so far | `railway usage` |

The repository must be linked to the project (`railway link --project enterprise-brain-staging`); `pnpm staging:railway` refuses to run against another project. Agents with a real model need `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` in `.env.staging`, then `pnpm staging:railway env app`; `GEMINI_API_KEY` also switches on search by meaning (D53).

`pnpm staging:agent` and the `setup` step call the brain API from a temporary Railway sandbox on the private network (`scripts/lib/railway-sandbox.ts`): Railway resolves the service token inside the sandbox, and the sandbox is destroyed afterwards. `railway ssh` would allow the other operations tools (dead letters, key rotation) inside a service, but it needs an SSH key registered with Railway, which this CLI login could not do.

## Checked on 2026-10-12

Phase 0 of the Company Brain, deployed in the evening (`docs/brain/gates/phase-0.md`):

- `pnpm staging:railway env services` created `brain-api` with its public address, deleted `admin-api` and configured 39 variables for the brain API; `data --service state-postgres` rebuilt the state database with pgvector in 91 s on the same volume; `app` deployed the four services in 79 to 99 s each, every readiness check green on the first attempt with Mattermost reached over the private network (`MM_API_URL`); `setup` registered the brain (allow-list `brain-api.railway.internal`, the OAuth app, `/brain` in the team) in 263 ms.
- The services' logs after the deploy hold only start-up lines: bridge with `capture="all"`, ingestion with 2 channels, agent-runtime with 3 agents, brain-api with `semantic=true` (the Google key is set, so embeddings and search by meaning are on).
- Through the public address: `/healthz`, `/readyz` (`database` and `mattermost` true), the pages, `/openapi.json` answer; an entity created with the service token was searchable after 806, 826 and 861 ms in three runs (round trips from Istanbul to Amsterdam included).
- Not tried by me, for the owner's hand test: sign-in to the pages with the chat account, `/brain help`, `/brain search <words>` and `/brain link` in a channel, and the pinned note a linked channel receives.

Earlier the same day:

- Deploy times, build included: databases, Redis and the S3 store 24 to 40 s; relay 44 s; Mattermost 69 s; our four services 32 to 56 s.
- `pnpm dev:seed --skip-relay` ran against the public address right after Mattermost came up and created the first account; the setup then checks that no other person holds an account.
- An echo agent created with the admin API answered a mention from alice, posted through the public address, in 1.2 s. A second agent, created and mentioned at once, also answered in 1.2 s (D47).
- No warnings or errors from our services. The relay refused the reader key for a moment on its very first start, until the bridge granted the membership; Mattermost warned about email (no SMTP) and Calls (no public IP).
- `pnpm check:logs --env-only` found none of the 15 staging secrets in the runtime and build logs of all eleven services (22 files, 399 KiB). Key store secrets were not checked, because the state database is private.
- Mattermost then moved to 11.11.1 (release `eb-v11.11.1-1`; its database migrated on first start). Railway's start-up check passed; at the owner's request I ran no tests of my own, and the owner tests it by hand.
- Release `eb-v11.7.12-2` had removed the System Console's Enterprise upgrade and trial offers, which the owner had found there; on staging the upgrade endpoint answers 501 and the echo agent answered in 1.4 s.
- Earlier that day Mattermost was switched from Mostlymatter to our own build (D48) on the same data: it reports build `eb-v11.7.12-1` and no user limit, the sign-in page carries only the Enterprise Brain name and logo, the echo agent still answered in 1.2 s, and the logs again held no staging secret.

## Limits to know

- **Email:** Mattermost has no SMTP server configured, so it cannot send invitations, password resets or notifications. The Pro plan allows SMTP; it needs an email provider's SMTP settings.
- **Backups:** the Pro plan offers scheduled volume backups; none are scheduled yet.
- **Mattermost Calls** (voice and video) needs inbound UDP, which Railway does not accept, so calls will not connect. Chat, threads, files and agents are unaffected.
- **Redeploys** of a service with a volume cause a short outage of that service.
- **Load test:** not run on staging yet. `pnpm load-test` reads the relay and the services' metrics directly, so it would have to run inside the private network, and it leaves 500 test people and 300 channels behind.

## Cost

Railway bills usage per second: $10 per GB of memory per month, $20 per vCPU per month, $0.15 per GB of volume per month and $0.05 per GB of outgoing traffic; builds and private traffic are free. Pro costs $20 a month including $20 of usage.

At rest the local stack uses about 0.6 GB of memory (measured with `docker stats` on 2026-10-12) plus about 0.1 GB per service of ours, so about 1 to 1.5 GB in total and well under one vCPU: roughly $15 to $25 a month. `railway usage` shows the real figure.
