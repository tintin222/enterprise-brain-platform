# Installing Enterprise Brain

One installation per customer, on one machine (spec section 13, decision 1; NFR-12). Everything runs in containers; the host needs nothing but Docker.

## What you need

- A Linux machine (or macOS for a trial) with **Docker Engine 27 or newer and Compose v2** (`docker compose version`), 4 CPUs, 8 GB of memory and 40 GB of disk to start with. Apple Silicon works for trials: the chat image is amd64 and runs under emulation.
- `git`, to get this repository.
- For TLS: two DNS names pointing at the machine (for example `chat.example.com` and `brain.example.com`) and ports 80 and 443 open. Without domains the services listen on ports 8065 (chat) and 9120 (brain) over plain HTTP, which is fine on a private network or for a trial.
- Optional: an Anthropic API key and a Google AI key, for agents that use a model and for search by meaning. Everything else works without them.

## The four commands

```sh
git clone https://github.com/tintin222/enterprise-brain-platform.git && cd enterprise-brain-platform
cp install/config.example.env install/config.env     # then edit the "Addresses" lines if you have domains
./install/brain init                                 # generates every key and secret into install/config.env
./install/brain up                                   # builds the images, starts everything, seeds the workspace
```

`up` ends by printing the addresses, the admin account name and where its password is (`MM_ADMIN_PASSWORD` in `install/config.env`). The first run builds the images, which takes a few minutes; the whole installation takes well under an hour on a normal machine (`./install/brain test` measures it).

Then:

1. Open the chat address and sign in as the admin. Invite people from the System Console or with the team's invite link.
2. In any channel, type `/brain help`. `/brain search <words>` searches; `/brain link` makes the channel feed a project or topic; `/project new` creates a project with its three channels; `/topic here` makes the channel a topic; `/task <title>` in a thread makes a task with the thread as evidence; `/task mine` lists yours.
3. Open the brain address and sign in with the chat account: projects and topics with their home pages, people and who knows what, systems with their schemas and API specs, documents (upload anything; the text is read and searchable), tasks (list, board, my tasks), search with citations.

## Settings

Everything is in `install/config.env`; `./install/brain init` fills the empty secrets and derives the addresses and never overwrites a value you set. The file holds every key of the installation: keep it readable by the installing account only (the script sets mode 600) and back it up together with the volumes.

| Setting | Meaning |
| --- | --- |
| `DOMAIN_CHAT`, `DOMAIN_BRAIN`, `ACME_EMAIL` | With both domains set, Caddy terminates TLS with Let's Encrypt certificates. |
| `HOST_ADDRESS` | Without domains: the chat is `http://HOST_ADDRESS:8065`, the brain `http://HOST_ADDRESS:9120`. |
| `MM_URL`, `BRAIN_PUBLIC_URL` | Derived from the above; set them yourself behind your own proxy. |
| `MM_TEAM_NAME`, `MM_ADMIN_USERNAME`, `MM_ADMIN_EMAIL` | The workspace and its first administrator. |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Model access for agents (D21, D54) and embeddings for search by meaning (D53). Empty keys keep keyword search. |
| `BRAIN_CAPTURE_CHANNELS` | `all` (default): the brain reads every public and private channel; `public`; or `opt-in` (only channels someone invites `@brain` to). A channel `@brain` is removed from stays out (D50). |
| `BRAIN_FEATURE_*` | Feature flags per D55: `API`, `CHAT_COMMANDS`, `SEMANTIC_SEARCH`, and Phase 1's `PROJECTS`, `PEOPLE`, `SYSTEMS`, `DOCUMENTS`, `TASKS`, `REMINDERS`, `OCR_MODEL` (scans and images read by the model provider; never confidential or no-ai documents). |
| `BRAIN_FILE_MAX_MB`, `BRAIN_STALE_DAYS`, `BRAIN_REMINDER_HOUR`, `BRAIN_EXTRACT_CONCURRENCY` | Largest upload (50 MB), days before a quiet project is flagged (14), local hour of the task reminders (8), documents extracted at a time (2). |
| `BRAIN_TIMEZONE` | The installation's time zone for schedules and dates. |

Changing a setting: edit `config.env`, then `./install/brain up` again (it recreates only what changed) and, for Mattermost-side settings, `./install/brain seed`.

## Day to day

| Command | Purpose |
| --- | --- |
| `./install/brain status` | Containers and the readiness of each service |
| `./install/brain logs [service]` | Follow logs (`bridge`, `agent-runtime`, `ingestion`, `brain-api`, `mattermost`, `relay`, …) |
| `./install/brain seed` | Re-run the idempotent seed (admin, team, `@brain`, tokens, the brain's Mattermost setup) |
| `./install/brain selftest` | Create an entity through the API and check it is searchable within 5 seconds |
| `./install/brain down` | Stop everything; data stays in the volumes |
| `./install/brain down --wipe` | Stop and delete every volume: all chat, relay and brain data |

Backups: the Docker volumes (`brain_mm-postgres-data`, `brain_mm-data`, `brain_buzz-postgres-data`, `brain_buzz-s3-data`, `brain_state-postgres-data`, `brain_caddy-data`) and `install/config.env`. Uploaded documents live in the state database, so one backup covers them. The relay can be rebuilt from the chat (`docs/operations.md` section 5); the brain's store, files included, can be exported in an open format and the export verified (`docs/brain/export-format.md`).

Upgrades: `git pull`, then `./install/brain up`. Migrations run when the services start.

## How the pieces fit

`install/compose.yml` runs our Mattermost build (Enterprise Brain chat, D48), its Postgres, the Buzz relay with its Postgres, Redis and S3-compatible store, our state database (Postgres with pgvector, D52), and our four services from one image: the bridge, the agent runtime, ingestion and the brain API with the pages. `compose.ports.yml` publishes the chat and the brain on the host's ports; `compose.tls.yml` adds Caddy in front of them. The installer (`scripts/install/run.ts`) runs inside the services image, so the host needs no Node.js. `docs/architecture.md` describes the components; `docs/operations.md` how to watch and repair them.

## The clean-install test

`./install/brain test` (`install/test.sh`) installs from nothing on the current machine, runs the self-test and wipes everything, printing the elapsed time. It is the Phase 0 gate of `docs/COMPANY_BRAIN_SPEC.md` and runs nightly in CI. Never run it on a machine that holds a real installation: it deletes `install/config.env` and every volume.
