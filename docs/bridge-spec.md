# Bridge specification

The bridge mirrors agent-enabled Mattermost channels into the Buzz relay, and agent-authored relay events back into Mattermost. Items marked **(A#)** depended on an assumption listed in `docs/decisions.md`; Phase 0 tested each one, and `docs/spike-findings.md` has the evidence. Where an assumption failed, the replacement written here was agreed with the owner on 2026-10-12.

## 1. Responsibilities

In scope:

- Detect which channels are agent-enabled and keep a relay channel for each.
- Mirror posts, thread replies, edits, deletions, reactions and membership from Mattermost to the relay.
- Mirror agent-authored messages, edits, deletions and reactions from the relay to Mattermost.
- Own the identity map (Mattermost user <-> Nostr key) and the message map (post id <-> event id).
- Recover from downtime without losing or duplicating messages.

Out of scope: deciding when an agent responds (agent-runtime), indexing (ingestion), direct messages (v1).

## 2. Identities and keys

| Identity | Created | Notes |
| --- | --- | --- |
| Bridge service key | Once, at install, before the relay first starts | Relay owner (`RELAY_OWNER_PUBKEY`). Creates and owns every mirrored channel. |
| Reader service key | Once, at install | Relay member; added as a member of every mirrored channel. One key shared by the bridge, agent-runtime and ingestion (Q12). |
| Custodial person key | Lazily, on a person's first mirrored event | One per Mattermost user id. |
| Agent key | By agent provisioning at agent creation | Stored, with the agent's bot token, in the shared key store (D19). The bridge uses the key to publish the agent's profile and the token to post as the agent's bot. |

For each new custodial or agent identity the bridge:

1. Adds the pubkey as a relay member: kind 9030 `[["p", pubkey], ["role", "member"]]`, signed by the bridge key, which is the relay owner **(A6, confirmed)**. Concurrent adds are safe: membership is a database table and the relay-signed roster (kind 13534) is only a snapshot.
2. Publishes a profile (kind 0) with `name`, `display_name` and `picture` (the Mattermost avatar URL), signed by that identity **(A8, confirmed)**. Agents are handled the same way: their keys are in the shared key store (D19).

Removing a relay member (kind 9031) refuses that key's new connections but does not close a socket it already has open (spike A6). Custodial keys are only used over HTTP, so this matters for keys that hold WebSockets: reader and agent keys.

Publishing as many identities: the relay requires the event's pubkey to match the authenticated pubkey. Holding one WebSocket per person does not scale, so events are published over the relay's HTTP `POST /events` endpoint with a per-request NIP-98 auth header signed by the same key **(A1, confirmed)**. Details that matter:

- The body is one event; the reply is `{"event_id", "accepted", "message"}`. `accepted: true` with `message: "duplicate:"` means the relay already had the event: treat it as success.
- Each NIP-98 auth event id is accepted once (120 s replay guard). Two headers for the same request in the same second have the same id, so every header carries a random `["nonce", …]` tag.
- The `u` tag and the request must use the relay's community host (the host in the relay's `RELAY_URL`). Any other Host gets 404.
- The relay rate-limits each key. Our config raises the limit to 1200 HTTP calls per minute (D20; the relay default is 300). Person keys rarely approach it, but the bridge key does all channel administration (9007, 9000, 9001, 9030), so throttle it and back off on `429`.

Private keys are stored encrypted (see `shared/key-store`), decrypted in memory only for signing.

## 3. State

A dedicated Postgres database. Suggested tables; adjust names to taste but keep the uniqueness rules. As built, these tables live in schema `bridge`, except `identity_map`, which lives with the key store in the shared `identity` schema (`identity.identities`, D19, D24).

| Table | Columns | Rules |
| --- | --- | --- |
| `identity_map` | `mm_user_id` PK, `kind` (`person`, `agent`, `service`), `nostr_pubkey` unique, `encrypted_secret`, `profile_hash`, `created_at` | `encrypted_secret` (or a reference into the shared key store) is set for every identity, agents included (D19) |
| `channel_map` | `mm_channel_id` PK, `mm_team_id`, `relay_channel_id` unique, `visibility` (`open`, `private`), `state` (`active`, `paused`, `archived`), `created_at` | |
| `message_map` | `mm_post_id` unique, `relay_event_id` unique, `origin` (`mm`, `relay`), `mm_channel_id`, `author_mm_user_id`, `created_at` | The loop-prevention source of truth |
| `relay_outbox` | `relay_event_id` PK, `signed_event` (JSON), `mm_post_id`, `attempts`, `created_at` | (A5) Written before the first publish; retries resend this exact event. Deleted once the relay accepts it. |
| `reaction_map` | `mm_post_id`, `mm_user_id`, `emoji_name`, `relay_event_id` unique | PK on the first three columns |
| `cursor` | `stream` PK, `position` | One row per Mattermost channel and per relay channel. For a Mattermost channel the position is a Mattermost time (ms) before which every post was processed: catch-up sets it to its own start time minus a 30 s margin, and live events never move it, so a missed event is always re-read. |
| `dead_letter` | `id`, `direction`, `payload`, `error`, `attempts`, `created_at` | Events that failed after retries |

## 4. Channel lifecycle

| Trigger in Mattermost | Bridge action on the relay |
| --- | --- |
| `@brain` added to a channel | Create a relay channel: kind 9007 `[["h", relay_channel_id], ["name", channel name], ["visibility", "open" or "private"]]` **(A2, confirmed)**. The bridge chooses `relay_channel_id` itself, derived from the Mattermost channel id (UUIDv5 under a fixed namespace), because the relay's reply never contains the id. A retried create then returns `duplicate: channel already exists`, which counts as success. Store the mapping. Add the reader keys and all current members' keys (kind 9000 `[["h", id], ["p", pubkey]]`). Optionally backfill the last N days. |
| Member joins or leaves | Kind 9000 / 9001 for that member's key. Create the identity first if needed. |
| Agent bot added | Kind 9000 for the agent's key. This is what makes the agent eligible to respond there. An agent key whose kind 10100 sets `channel_add_policy` to `owner_only` or `nobody` is refused with `invalid: policy:…`; record and report it instead of retrying (A6). |
| Channel renamed or header changed | Kind 9002 with the new `name` / `about`. |
| `@brain` removed, or channel archived | Set state to `paused` or `archived`. Stop mirroring. Do not delete relay history (see Q4 in `docs/decisions.md`). |

Detecting membership relies on WebSocket events the bridge bot can see **(A10, confirmed)**: `user_added` (`data.user_id`, `broadcast.channel_id`) and `user_removed` (`data.user_id`, `data.remover_id`) arrive for channels the bot is in, and `user_added` with the bot's own id when the bot is added to a channel, which is the opt-in signal. A reconciliation job (section 8) covers anything missed.

## 5. Mattermost to relay mapping

Capture: one Mattermost WebSocket connection authenticated as the bridge bot, plus REST catch-up. Ignore posts whose `type` is non-empty (system messages such as joins and header changes).

| Mattermost event | Relay event | Signed by | Tags and notes |
| --- | --- | --- | --- |
| `posted`, root post | kind 9 | Author's key | `["h", relay_channel_id]`. Content is the post's Markdown text, `@username` mentions included. One `["p", pubkey]` per mentioned mapped identity **(A3, confirmed)**. Mattermost's `posted.mentions` lists only the receiving user **(A10)**, so extract `@username` tokens from the text and resolve them with `POST /api/v4/users/usernames` (cached). |
| `posted`, reply (`root_id` set) | kind 9 | Author's key | As above, plus `["e", root_event_id, "", "reply"]`. The relay rejects replies to unknown parents, so mirror the root first. |
| `post_edited` | kind 40003 | Author's key | `[["h", relay_channel_id], ["e", original_event_id]]`, content is the full new text **(A4, confirmed)**. Only the original author's key may edit; the edit is a separate event and the original is unchanged. |
| `post_deleted` | kind 5 | Author's key | `["e", event_id]`. If the author's key is not held by the bridge, use kind 9005 signed by the bridge key (channel owner). |
| `reaction_added` | kind 7 | Reactor's key | `["e", target_event_id]`, content is the emoji character, or `:name:` for custom emoji. Record in `reaction_map`. |
| `reaction_removed` | kind 5 | Reactor's key | Deletes the reaction event recorded in `reaction_map`. |
| File attachments | none in v1 | | Append the Mattermost permalink to the content. Relay media needs Blossom (kind 24242) auth and relay membership even to read **(A12)**, so Mattermost clients could never load a relay media URL; attachments stay permalinks. Upload to the relay only if agents need the bytes (Phase 4). |

Additional rules:

- The relay rejects `created_at` more than 900 seconds from its clock **(A5, failed for backfill)**. Use the post's `create_at` in seconds when it is within 10 minutes of now, otherwise the current time, and always add `["mm_ts", create_at_ms]`. Consumers treat `mm_ts` as the message time. Events published by backfill also carry `["backfill", "1"]` so agents never answer them.
- Add a provenance tag `["mm", mm_post_id]` to every mirrored event **(A9, confirmed)**. The relay preserves it, but ignores filters on multi-letter tags such as `#mm` (it returns unrelated events), so finding the event for a post goes through `message_map`. The mapping table remains the source of truth; the tag is for debugging and rebuilds.
- Posts authored by an agent's bot account that are already in `message_map` with origin `relay` are the bridge's own echoes: skip them.
- Posts by a bot account that is not a registered agent (other integrations) are mirrored like a person's post, with a custodial key for that bot user.

## 6. Relay to Mattermost mapping

Capture: a relay WebSocket connection authenticated as the bridge's reader key, with **one subscription per active relay channel**, each filter naming exactly that channel in `#h` **(A7)**. The relay delivers live channel events only to subscriptions whose filters all name the same single channel: a filter listing several channels returns stored events but nothing live, and a kinds-only or `#p`-only filter receives nothing. Limits: 1024 subscriptions per connection (shard beyond about 1000 channels), 10 filters per REQ, 1000 stored results per filter. REQs count against the per-key WebSocket limit, which our config raises to 50 frames per second (250 per 5 s; D20). The bridge, agent-runtime and ingestion share one reader key (Q12) and therefore that budget, so each service opens its subscriptions at no more than 40 per second and backs off when a REQ is `CLOSED` with `rate-limited:`. Subscriptions use `limit: 0` (live events only), and each channel's relay catch-up runs when its subscription is confirmed (`EOSE`), again after every re-subscription, and on the periodic timer. Starting catch-up when the REQ is merely queued can miss an event published in between (spike findings, item 13).

Mirror an event only if all of these hold:

1. Its pubkey is in `identity_map` with kind `agent`.
2. Its id is not in `message_map`.
3. Its channel is `active` in `channel_map`.

Events from unknown pubkeys are logged and ignored in v1.

| Relay event | Mattermost action | Acting as | Notes |
| --- | --- | --- | --- |
| kind 9, no reply tag | `POST /api/v4/posts` | Agent's bot token | `props` carries `{ "relay_event_id": id }`. |
| kind 9 with reply tag | `POST /api/v4/posts` with `root_id` | Agent's bot token | Resolve the parent event to a post, then to that post's thread root, because Mattermost threads are flat. |
| kind 40003 | `PUT /api/v4/posts/{id}/patch` | Agent's bot token | Used for streamed or corrected answers. Edits are separate events; apply only one newer (by `created_at`) than the last applied edit for that target. |
| kind 5 or 9005 targeting a mirrored event | `DELETE /api/v4/posts/{id}` | Agent's bot token | |
| kind 7 | `POST /api/v4/reactions` | Agent's bot token | Map emoji character to a Mattermost emoji name. |

Write the `message_map` row in the same transaction that records the successful post, and before advancing the relay cursor past the event. Agent replies mention people the Buzz way: `@Display Name` in the text plus a `["p", pubkey]` tag **(A3)**; rewrite each mention of a mapped person to `@username`. Split content longer than Mattermost's post limit (about 16,000 characters) into consecutive posts in the same thread.

## 7. Loop prevention and idempotency

- Before mirroring in either direction, look up the source id in `message_map`. If present, stop.
- Insert the mapping row with a unique constraint; on conflict, treat the event as already handled.
- The bridge never mirrors a relay event authored by a `person` identity, and never mirrors a Mattermost post it created itself.
- **(A5)** A retry resends the exact signed event stored in `relay_outbox` before the first attempt, so it can never create a second event; the relay answers `duplicate:` for an event it already has. Re-signing is not safe: once the original `created_at` is more than 900 s old the relay rejects it, and a new `created_at` changes the id.

## 8. Ordering, catch-up and reconciliation

- **Ordering.** Process events per channel in order. Different channels may run in parallel.
- **Mattermost catch-up.** On start, after every WebSocket reconnect, and every `CATCH_UP_INTERVAL_SECONDS` (default 300), for each active channel call `GET /api/v4/channels/{id}/posts?since={cursor}` and process new, edited and deleted posts **(A10, confirmed)**: edited posts come back with the new text and `edit_at` > 0, deleted posts with `delete_at` > 0 and an empty message, without `include_deleted`. Advance the cursor only after successful processing.
- **Relay catch-up.** On start and reconnect, query each active channel through `POST /query` from its cursor minus an overlap window (default 10 minutes), paging with `until` plus the relay's `before_id` extension set to the last event received, and rely on `message_map` to drop duplicates **(A7)**. Paging with `until` alone repeats or skips events that share a second. `created_at` is set by the client, so never treat it as a strict ordering key.
- **Reconciliation.** Every few minutes: compare Mattermost channel membership with relay membership (kind 39002, queried with `{"kinds":[39002],"#d":[relay_channel_id]}`) and fix differences; find agent bots that are members of channels the bridge is not in and report them (see Q2).

## 9. Failure handling

- Retry transient failures with exponential backoff and jitter. After the retry budget, write to `dead_letter` and continue with the next event; never block a channel forever on one bad message.
- A failed publish for a thread root pauses that thread's replies until the root succeeds.
- Throttle relay writes per identity and globally; the relay enforces no rate limits of its own.
- Expose metrics: events mirrored per direction, lag per direction, retries, dead letters, WebSocket reconnects.

## 10. Configuration

| Variable | Purpose |
| --- | --- |
| `MM_URL` | Mattermost base URL |
| `MM_BRIDGE_TOKEN` | Access token of the `@brain` bot (system admin) |
| `RELAY_WS_URL`, `RELAY_HTTP_URL` | Buzz relay endpoints. Their host must be the host in the relay's own `RELAY_URL`; the relay answers 404 for any other Host. |
| `BRIDGE_SECRET_KEY`, `READER_SECRET_KEY` | Service keys (hex), or references into the key store. The bridge key is the relay owner (`RELAY_OWNER_PUBKEY`). |
| `KEY_ENCRYPTION_KEY` | Master key for the key store |
| `STATE_DATABASE_URL` | Bridge state database |
| `BACKFILL_DAYS` | History to mirror when a channel is enabled (0 disables) |
| `RELAY_OVERLAP_SECONDS` | Catch-up overlap window |

## 11. Tests that must exist

1. Person posts in an enabled channel: exactly one relay event appears, signed by that person's key, in the mapped channel.
2. Reply in a thread arrives with the correct parent reference.
3. Agent-authored relay event appears once in Mattermost as the agent's bot, in the right thread.
4. Restart the bridge mid-stream: no message lost, none duplicated.
5. Replay the same Mattermost event twice: one relay event.
6. Edit and delete propagate in both directions.
7. A post in a channel without `@brain` produces no relay event.
8. Private channel: a key that is not a member cannot read the mirrored events from the relay.
