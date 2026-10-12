# Architecture

## 1. Goal

People chat in a familiar Slack-style product. They can invite AI agents into channels, mention them, and get answers grounded in company knowledge. Everything said in agent-enabled channels flows into the enterprise brain, subject to the same access rules as the channel it came from.

Non-goals for v1: direct messages with agents, voice, federation with outside Nostr clients, letting people connect to the Buzz relay directly.

## 2. Components

```
            people
              |
   web / desktop / mobile clients
              |
   +----------------------+
   |      Mattermost      |   system of record for human chat
   +----------+-----------+
              | REST v4 + WebSocket (bridge bot, agent bot tokens)
   +----------+-----------+
   |        bridge        |   mirrors both ways, owns identity and id mappings
   +----------+-----------+
              | Nostr: HTTP /events, /query + WebSocket
   +----------+-----------+
   |      Buzz relay      |   signed event log, channel membership, search, audit
   +-----+-----------+----+
         |           |
+--------+------+  +-+-----------+
| agent-runtime |  |  ingestion  |
+--------+------+  +-+-----------+
         |           |
   +-----+-----------+----+
   |   enterprise brain   |   knowledge store, retrieval, agent definitions
   +----------------------+
```

| Component | Owner | Role |
| --- | --- | --- |
| Mattermost | upstream, unmodified | Chat UI and API for people. Agents appear here as bot accounts. |
| Buzz relay | upstream, unmodified | Nostr relay with channels (NIP-29), per-identity membership, full-text search and a hash-chained audit log. Internal only. |
| bridge | this repo | Mirrors agent-enabled Mattermost channels into the relay, and agent-authored relay events back into Mattermost. |
| agent-runtime | this repo | Watches the relay for mentions of registered agents, builds context, calls the model, publishes the reply as the agent. |
| ingestion | this repo | Reads the relay log and keeps the brain's index in step, including edits and deletions. |
| admin API | this repo | Internal endpoints the brain product calls to create agents, enable channels and add agents to channels (`pnpm admin-api`, docs/phase7.md). |
| enterprise brain | existing product | Knowledge store and retrieval. Reached through a `BrainClient` adapter. Until it has an API, a local stand-in in our state database takes its place (D34). |

## 3. Sources of truth

| Data | Source of truth | Derived copy |
| --- | --- | --- |
| Human messages, channels, human membership | Mattermost | Relay events, brain index |
| Agent-authored messages | Buzz relay (signed by the agent's key) | Mattermost posts by the agent's bot account, brain index |
| Agent definitions (persona, tools, knowledge scope) | Enterprise brain / agent registry | none |
| Identity and id mappings | Bridge state database | none |

The relay must be rebuildable. If it is lost, the bridge can replay Mattermost history into a fresh relay, because agent messages also exist as Mattermost posts. Design nothing that makes the relay the only copy of a human message.

## 4. Identity model

Every participant has a Mattermost identity and a Nostr keypair.

| Participant | Mattermost side | Relay side |
| --- | --- | --- |
| Person | Normal user account | Custodial keypair created and held by the bridge. The person never sees it. |
| Agent | Bot account with its own access token | Keypair created at agent creation, held in the key store. |
| Bridge | Bot account `@brain`, the opt-in marker for a channel | Service keypair. Relay admin and owner of every mirrored channel. |
| Reader | none | Service keypair, member of every mirrored channel. One key shared by the bridge, agent-runtime and ingestion for reading (Q12). |

Why per-person keys instead of one bridge key: the relay requires `event.pubkey` to equal the authenticated pubkey, and agents and the audit log need to know who said what. One shared key would make every person look like the same author.

## 5. Key flows

### 5.1 A channel becomes agent-enabled

1. Someone invites `@brain` to a Mattermost channel (or the brain product does it through the API).
2. The bridge sees it joined, creates the matching relay channel, mirrors membership, and optionally backfills recent history.
3. From then on, agents invited to the Mattermost channel are added to the relay channel.

Mirroring is opt-in per channel. A channel without `@brain` is never read.

### 5.2 A person mentions an agent

1. Person posts `@finance-bot what did we decide on Q3 pricing?` in Mattermost.
2. Bridge receives the post, signs a relay chat event with the person's custodial key, tags the agent's pubkey as mentioned, and publishes it.
3. Agent-runtime's reader subscription sees an event mentioning a registered agent that is a member of that channel.
4. Agent-runtime loads the thread, queries the brain with the channel's access context, calls the model, and publishes the reply signed with the agent's key.
5. Bridge sees a relay event authored by an agent identity and posts it to Mattermost as that agent's bot account, in the same thread.

### 5.3 Ingestion

Ingestion reads the same relay log with its own cursor, groups events into thread-level documents, and upserts them into the brain with the channel id attached for access control. Edits re-index; deletions remove.

## 6. Trust boundaries and security

- **The relay is internal.** It is not exposed to the internet. Relay membership is required (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`) and only our service, agent and custodial keys are members.
- **Relay authentication settings.** `BUZZ_REQUIRE_AUTH_TOKEN=true` in every environment. Without it the relay's HTTP API accepts an unauthenticated `X-Pubkey` header and acts as that key: Phase 0 read a private channel that way (spike X1). Removing a relay member refuses new connections but does not close sockets that are already open (spike A6).
- **Custodial keys are high-value secrets.** Encrypted at rest with a master key from the environment or a KMS, decrypted only in memory, never logged.
- **Access control follows the channel.** Content ingested from a private channel may only be retrieved for people or agents who are members of that channel at query time. Never snapshot membership into the index. Because an agent answers in a channel everyone there can read, a search made in a channel returns that channel's content and open channels' content only (D35).
- **Agents act only where they are members.** The dispatcher checks membership before running an agent; the relay enforces it again on write for private channels.
- **Prompt injection.** Chat content is untrusted. It is passed to the model as quoted conversation, never as system instructions. Tool permissions come from the agent definition only.
- **Loop control.** Agents do not trigger on messages authored by agents unless explicitly mentioned, and replies per thread per agent are capped.
- **Deletion.** Deleting a message in Mattermost must remove it from the relay view and the brain index.
- **The relay rate-limits per key.** By default each key may make 300 HTTP calls per minute, publish 60 events per minute over WebSocket, and send 50 WebSocket frames per 5 seconds (spike A1; upstream docs wrongly say there is no rate limiting). Because three services share the reader key, our relay config raises the HTTP limit to 1200 per minute and the WebSocket limit to 50 frames per second (D20). The bridge and agent-runtime still throttle their own writes and back off when limited.
- **Keys at rest.** One shared key store in our state database holds every identity's secrets, including agent keys and bot tokens (D19).

## 7. Environments

| | Mattermost | Buzz relay |
| --- | --- | --- |
| Local dev | Official Team Edition container 11.7.12, pinned by digest (`infra/compose.yml`); Mostlymatter of the same version with `pnpm dev:up --mostlymatter` (D40) | Relay 0.2.1 (`relay-v0.2.1`, D12), services adapted from Buzz's `deploy/compose/` bundle |
| Staging / production | Our own build of the same version (Enterprise Brain chat, D48); Mostlymatter remains an option | Upstream production compose bundle (`deploy/compose/` in the Buzz repo), pinned release |

Default local ports: Mattermost 8065, Buzz relay 3000, our state Postgres 5433, the services' operations endpoints 9101 to 9103 and the admin API 9110, all bound to 127.0.0.1.

Operations (health and metrics endpoints, throttling, dead letters, key rotation, relay rebuild) are in `docs/operations.md`, the load test in `docs/load-test.md`, the security review in `docs/security-review.md`.

The relay serves one community, keyed on the host of its `RELAY_URL`. Every client must reach it by that host name (and NIP-98 `u` tags must use it); any other Host header gets 404. Inside Docker, set `RELAY_URL` to the internal name all services use.

## 8. Main risks

| Risk | Mitigation |
| --- | --- |
| Buzz is pre-1.0 and changes quickly | Pin a release; all access through `RelayClient`; relay is rebuildable from Mattermost (`pnpm relay:rebuild`, drilled in Phase 6) |
| Upstream behaviour differs from what these docs assume | Phase 0 spike tests every assumption before feature work |
| Mattermost WebSocket drops events | Catch-up by `since` on reconnect plus periodic reconciliation |
| Duplicate or looping messages | Mapping table checked before every write; origin recorded for every message |
| Leak of private-channel knowledge through an agent | Retrieval scoped at query time to the asking channel and active open channels (D35) |
