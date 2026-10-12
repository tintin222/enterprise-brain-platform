# Staging on Railway

Status on 2026-10-12: planned, not deployed. Creating it starts paid usage in the owner's Railway account, so it waits for the owner's go-ahead (build-plan Phase 7, docs/phase7.md item 3). The Railway facts below were checked against Railway's documentation, pricing page and CLI on 2026-10-12.

## Why Railway fits

- It runs linux/amd64 containers, which Mattermost's image requires.
- It deploys public images and local Dockerfiles. `railway up` uploads the working tree without files ignored by git or listed in `.railwayignore`, so `.env` stays on the Mac; the build runs on Railway.
- Services share a private network (`<service>.railway.internal`), and only services given a domain are public, with Let's Encrypt TLS. WebSocket connections may stay open indefinitely.
- Volumes, sealed (write-only) variables, and `railway ssh` for commands inside a running service.

## Layout

One new Railway project, `enterprise-brain-staging`, in region EU West (Amsterdam), separate from any existing project. Only Mattermost gets a public address.

| Railway service | Built from | Volume | Reachable from |
| --- | --- | --- | --- |
| `mattermost` | `infra/mostlymatter/Dockerfile` (Mostlymatter 11.7.12, D40) | `/mattermost/data` | Public HTTPS domain |
| `mm-postgres` | The Postgres image pinned in `infra/compose.yml` | Database files | Private network |
| `relay` | `ghcr.io/block/buzz:0.2.1`, pinned as in `infra/compose.yml` | `/data/git` | Private network only |
| `buzz-postgres`, `buzz-redis`, `buzz-s3` | The images pinned in `infra/compose.yml` | One each | Private network |
| `state-postgres` | The Postgres image pinned in `infra/compose.yml` | Database files | Private network |
| `bridge`, `agent-runtime`, `ingestion`, `admin-api` | `infra/services/Dockerfile`, one image with a different command each | None | Private network |

That is 11 services and 7 volumes, within the Hobby plan's limits (50 services and 10 volumes per project).

## How it differs from the local stack

- **One volume per service.** Mattermost keeps its configuration in its database (`MM_CONFIG` set to the database URL) and its files on the volume. Postgres keeps `PGDATA` in a subdirectory of its volume.
- **Volume ownership.** Railway mounts volumes as root, and Mattermost's image runs as user 2000, so the Mattermost service sets `RAILWAY_RUN_UID=0` and runs as root inside its container.
- **Hostnames.** The relay's `RELAY_URL` is `ws://relay.railway.internal:3000`, because the host in that URL names the relay's only community (spike findings); changing it later starts an empty community.
- **Bind addresses.** New Railway environments resolve private hostnames to IPv4 and IPv6. The relay listens on `[::]:3000` (`BUZZ_BIND_ADDR`) and our services' operations endpoints on `::` (`OPS_HOST`), which accept both.
- **Mattermost's address.** `MM_URL` and Mattermost's SiteURL are the public HTTPS address, so links in agent answers work for people.
- **Secrets.** They are generated on the Mac into `.env.staging` (ignored by git and Railway, mode 600) with the same generators as `.env`, then stored as sealed Railway variables through standard input (`railway variable set --stdin`), so no secret appears on a command line or in a log.
- **Reader key membership.** The relay cannot be reached from outside, so `pnpm dev:seed` cannot grant it; the bridge, as relay owner, makes the shared reader key a relay member every time it starts (D45).
- **Setup by CLI commands.** Railway's `railway.json` configuration is deprecated and stops being read on 2026-12-01, so the setup uses CLI commands (start commands, volumes, domain, region) instead.
- **Operations.** The operations endpoints and the admin API are reachable only on the private network. Commands run inside a service with `railway ssh`, for example `railway ssh --service admin-api -- node --import tsx packages/agent-runtime/src/cli/provision.ts --handle <h> --name "<Name>" --model echo`, or the dead-letter tool as `node --import tsx packages/bridge/src/cli/dead-letter.ts list` in the bridge service.

## Limits to know

- **Hobby plan:** no outgoing email (SMTP needs Pro), so Mattermost cannot send invitations, password resets or email notifications; no volume backups (Pro has scheduled backups); volumes up to 5 GB each. Railway recommends Pro for commercial use. Staging works on Hobby; a pilot with customers needs Pro.
- **Mattermost Calls** (voice and video) needs inbound UDP, which Railway does not accept, so calls will not connect there. Chat, threads, files and agents are unaffected.
- **Redeploys** of a service with a volume cause a short outage of that service.
- **Image digests:** Railway documents image tags, not `image@sha256:` pins. The setup tries the pinned references from `infra/compose.yml` first and records the result here.

## Cost

Railway bills usage per second: $10 per GB of memory per month, $20 per vCPU per month, $0.15 per GB of volume per month and $0.05 per GB of outgoing traffic; builds and private traffic are free. Hobby costs $5 a month including $5 of usage; Pro costs $20 a month including $20 of usage.

At rest the local stack uses about 0.6 GB of memory (measured with `docker stats` on 2026-10-12) plus about 0.1 GB per service of ours, so about 1 to 1.5 GB in total and well under one vCPU. That is roughly $15 to $25 a month on either plan, plus a few dollars for each load test.

## Steps

1. Create the project, its services, volumes and region, and generate `.env.staging`.
2. Deploy Mattermost from the Mostlymatter Dockerfile and give it its domain.
3. Run the seed against the public address; the tokens it creates go to `.env.staging`.
4. Store the variables, then deploy the services image as `bridge`, `agent-runtime`, `ingestion` and `admin-api`.
5. Check: every service ready, an echo agent answers a mention, `pnpm check:logs` finds no secret in the logs. Then run the load test there (docs/load-test.md).
