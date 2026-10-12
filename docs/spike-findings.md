# Spike findings (Phase 0)

Each assumption A1..A12 from `docs/decisions.md` was tested against the running local stack. This file overrides the specs where they disagree (CLAUDE.md). The specs were updated to match. The owner agreed to the replacements for failed assumptions on 2026-10-12.

Tested on 2026-10-12 against:

| Component | Version |
| --- | --- |
| Buzz relay | `ghcr.io/block/buzz:0.2.1` (tag `relay-v0.2.1`, commit 6e5c462), digest `sha256:4e31b7c7…` |
| Mattermost | Team Edition 11.7.12 (build 37652628685), no licence |
| Stack | `infra/compose.yml` with `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, bridge key as relay owner |

Reproduce with `pnpm dev:up && pnpm dev:seed && pnpm spike <id>`. Each spike prints its checks and writes the full evidence to `scripts/spike/results/<id>.json` (not committed). Statements marked *(source)* come from reading the relay source at `relay-v0.2.1` and were not tested live.

## Summary

| # | Assumption | Result | Main consequence |
| --- | --- | --- | --- |
| A1 | Per-request NIP-98 on `POST /events` lets one process publish as many keys | **Holds** | No WebSocket pool needed. Add a nonce tag to NIP-98; the relay rate-limits each key. |
| A2 | 9007 exposes the channel UUID; `open`/`private`; can the client choose the UUID | **Holds** | The client chooses the UUID with an `h` tag; the response never contains it. |
| A3 | A mention is a `["p", pubkey]` tag; how Buzz writes mentions in content | **Holds** | `@DisplayName` in content plus a `p` tag. Mentions are only seen live on per-channel subscriptions. |
| A4 | Shape of 40003 and 40002 | **Holds** | 40003 = `h` + `e` tags and the full new text, stored as a separate event. |
| A5 | The relay accepts a past `created_at` | **Fails** (beyond 15 min) | Window is ±900 s. Backfill uses current time plus `mm_ts`; retries resend the stored signed event. |
| A6 | Bridge adds relay members (9030) and channel members (9000), incl. agents | **Holds** | Safe under concurrency. `channel_add_policy` can block agents. |
| A7 | One filter can list many channels in `#h`; limits; paging | **Partly fails** | Live delivery needs one subscription per channel. Cap is 1000, not 500. Page catch-up with `/query` `before_id`. |
| A8 | Kind 0 fields kept; profiles for custodial keys | **Holds** | Raw profile stored as sent; replaceable. |
| A9 | Custom tags on kind 9 preserved | **Holds** | `["mm", post_id]` is kept. The relay ignores filters on multi-letter tags such as `#mm`, so lookups by post id use the message map. |
| A10 | `posted` lists mentioned ids; bot sees only its channels; `since` returns edits and deletions; admin bot self-adds to private channels | **Partly fails** | `mentions` lists only the receiving user. Parse `@username` from the text. Everything else holds. |
| A11 | Bot accounts and tokens work on Team Edition without a licence | **Holds** | None. |
| A12 | `PUT /media/upload` auth and returned URL | **Holds** (different auth) | Blossom kind 24242 auth, not NIP-98. Reading media also needs auth, so Mattermost clients cannot load relay media URLs. |
| X1 | (new) `X-Pubkey` header cannot impersonate a key | **Failed, fixed** | Default config let anyone read as any key. Set `BUZZ_REQUIRE_AUTH_TOKEN=true`. |
| X2 | (new, Q14) How Team Edition enforces its user cap | **Hard limit** | 250 active users; bots and deactivated users do not count. Mostlymatter and our own fork have no cap. |

## A1: publishing as many keys over HTTP

**Result: holds.**

Evidence (`pnpm spike A1`):

- Five relay-member keys published kind 9 through `POST /events` from one process, each request with its own NIP-98 header: all `200 {"accepted":true}`. Stored events carry each author's pubkey.
- Auth key different from `event.pubkey`: `403 "invalid: event pubkey does not match authenticated identity"`.
- A reused `Authorization` header: `401 "NIP-98: replay detected"`. Each auth event id is accepted once (120 s guard, *(source)*).
- Two auth headers for the same body in the same second without a nonce have the same event id (signatures differ, ids do not), so the retry gets `401 replay detected`. With a `["nonce", random]` tag the retry returns `200 "duplicate:"`.
- Rate limit with the relay defaults: call 301 within 883 ms got `429 {"error":"rate-limited: quota exceeded; retry in 59s"}`. Another key was unaffected. The limit is per key: 300 HTTP calls per minute; over WebSocket 60 EVENTs per minute and 50 frames per 5 s *(source)*.
- With `BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN=1200` and `BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=50` (D20), the 429 came on call 1201 (after 3.3 s), and in a burst of WebSocket REQs the first `CLOSED "rate-limited: …"` was REQ #251, so both variables work as named.

Wire shapes: `POST /events` takes one event object and returns `{"event_id","accepted","message"}`; `POST /query` takes an array of filters and returns a flat array of events; errors are `{"error": "..."}`, except 403 for non-members: `{"error":"relay_membership_required","message":"..."}`.

Spec changes: bridge-spec §2 (publishing path confirmed, WebSocket pool fallback dropped, nonce, throttling to stay under the per-key limits), architecture §6 (the relay does rate-limit).

## A2: channel creation (kind 9007)

**Result: holds, with a better option than the spec assumed.**

- Without an `h` tag the relay creates the channel and generates the UUID, but the response is `200 {"accepted":true,"message":""}` with no UUID. The UUID can be recovered from kind 39000 (by name) or from the creator's 44100 notification.
- With `["h", <uuid>]` the relay uses that UUID. Sending it again returns `200 {"accepted":false,"message":"duplicate: channel already exists"}`.
- `visibility` accepts `open` (39000 carries a `public` tag) and `private` (a `private` tag). Anything else: `400 "invalid visibility: secret"`. Default is `open` *(source)*.
- The signer becomes channel owner (39001 `["p", key, "owner"]`).
- Channel names are not unique: two channels with the same name were both created.

Spec change (bridge-spec §4): the bridge chooses the relay channel UUID, derived deterministically from the Mattermost channel id, so creation is idempotent and needs no discovery query.

## A3: mentions

**Result: holds.**

- Kind 9 with `["p", agent_pubkey]` is accepted and delivered live, tag intact, to a reader subscribed with `{"kinds":[9],"#h":[channel]}`. Content is stored exactly as sent; the relay never rewrites or parses it.
- A live subscription filtered only by `#p` (no `#h`) receives nothing (see A7). A historical query by `#p` finds the event.
- The Buzz desktop client writes a mention as plain `@DisplayName` in the content plus one `["p", hex]` per mentioned member *(source: desktop/src/features/messages/lib/useMentions.ts, desktop/src-tauri/src/events.rs)*.
- `/query` with `feed_types: ["mentions"]` must also name `kinds`; without it the relay answers `403 "restricted: p-gated kinds require #p tag matching your pubkey"`.

Spec changes: agents-and-ingestion A.3 (match mentions client-side on per-channel subscriptions), bridge-spec §5 (content keeps `@Display Name`, one `p` tag per mapped identity).

## A4: edits and rich content

**Result: holds.**

- Kind 40003: tags `[["h", channel], ["e", target_id]]`, content is the full new text. Stored as a separate event; the original stays unchanged. Find edits with `{"kinds":[40003],"#e":[id]}`; they are delivered live on the channel subscription.
- Only the author may edit: `400 "invalid: must be event author to edit"`. `h` must match the target's channel: `400 "invalid: target event belongs to a different channel"`. Missing `h`: `400 "invalid: channel-scoped events must include an h tag"`.
- Kind 40002: any content with an `h` tag is accepted; there is no schema and no Buzz client renders it.

Spec changes: bridge-spec §5 and §6 (edit shape, latest edit by `created_at` wins), agents-and-ingestion B.1 (apply edits per target).

## A5: past created_at

**Result: fails for backfill.** The relay accepts `created_at` within ±900 s of its clock.

| Offset | Result |
| --- | --- |
| −60 s, −600 s, −890 s, +600 s, +890 s | accepted |
| −910 s, −1 h, −1 day, −30 days, −1 year, +910 s | `400 "invalid: event timestamp too far from server time"` |

Identical inputs inside the window give the same event id, and republishing it returns `200 "duplicate:"`.

Spec change, agreed with the owner (bridge-spec §5, §7; agents-and-ingestion A.3, B.2):

- Use the Mattermost `create_at` as `created_at` only when it is within 10 minutes of now; otherwise use the current time. Always add `["mm_ts", "<create_at ms>"]`; consumers use `mm_ts` as the message time.
- Do not rely on re-signing producing the same id. Persist the signed event before the first publish and resend that exact event on retry; `duplicate:` counts as success.
- Because backfilled and caught-up events carry a recent `created_at`, the dispatcher's age guard must use `mm_ts` when present, and backfilled events carry `["backfill", "1"]` so they never trigger agents.

## A6: membership

**Result: holds.**

Relay membership:

- A non-member's NIP-42 auth fails with `restricted: not a relay member`; over HTTP it gets `403 relay_membership_required`.
- After the bridge (relay owner) publishes kind 9030 `[["p", key], ["role", "member"]]` the key can authenticate. A plain member's 9030: `400 "invalid: actor not authorized: must be admin or owner"`.
- Ten 9030 adds sent concurrently: all ten keys authenticate and appear in the relay-signed roster (kind 13534). Membership lives in a database table; 13534 is only a snapshot *(source)*. The same-second roster collision documented for `buzz-admin` does not apply to 9030 *(source)*.
- After a 9031 removal, new connections by that key are refused, **but an already-open socket kept publishing**. The relay checks membership only at AUTH *(source)*.

Channel membership (private channel owned by the bridge):

- The owner adds a person key and an agent key that never published kind 10100 with kind 9000 `[["h", channel], ["p", key]]`: accepted, listed in 39002.
- A plain channel member adding someone: `400 "invalid: only owners/admins may add private-channel members"`.
- A key that published kind 10100 `{"channel_add_policy":"nobody"}`: `400 "invalid: policy:nobody — this agent has disabled external channel additions"`. After it publishes `anyone`, the add works. Default with no 10100 is `anyone` *(source)*.
- Adding a key that is not a relay member to a channel is accepted.

Watching membership as the reader:

- A reader subscribed with `{"kinds":[39002],"#h":[channel]}` receives the updated 39002 live when an agent is added.
- The reader gets a 44100 only when it is itself added. Subscribing to another key's 44100/44101 is refused: `CLOSED "restricted: p-gated events require #p matching your pubkey"`.

Spec changes: bridge-spec §2 and §4 (identity and channel adds confirmed; handle `policy:` errors; removing relay membership does not cut open sockets), agents-and-ingestion A.3 (membership cache from per-channel 39002, not membership notifications).

## A7: subscriptions, limits, paging

**Result: partly fails.**

| Check | Observed |
| --- | --- |
| One filter, 3 channels in `#h`, history | Events from all 3 channels |
| Same filter, live | **0 of 3** new events delivered |
| One REQ with two filters for two channels, live | **0 of 2** |
| One subscription per channel, live | 1 of 1 for each channel |
| Historical results per filter | Capped at **1000** (`limit` 5000 returned 1000; no limit also 1000) |
| Paging over WebSocket with `until` (inclusive) | 277 of 1050 unique, 323 repeats: stuck on events sharing the boundary second |
| Paging over `POST /query` with `until` + `before_id` | 1050 of 1050 in 7 pages |
| Subscriptions per connection | 1024 held; the 1025th got `CLOSED "error: too many subscriptions"` |
| 11 filters in one REQ | `NOTICE "invalid message: ... REQ contains 11 filters, maximum is 10"` (no CLOSED) |

NIP-11 `limitation`: `max_message_length` 524288, `max_subscriptions` 1024, `max_filters` 10, `max_limit` 1000, `max_subid_length` 256, `auth_required` true, `restricted_writes` true. Opening subscriptions at 40 per 5 s per key stayed under the WebSocket rate limit.

A subscription is channel-scoped only when every filter names the same single channel in `#h`; anything else is treated as global and gets no live channel events *(source)*.

Spec change, agreed with the owner (bridge-spec §6 and §8, agents-and-ingestion A.3 and B.1):

- Every live consumer holds one subscription per channel with a single `#h` value; up to about 1000 per connection, sharded beyond that.
- The bridge, agent-runtime and ingestion share one reader key (owner's answer to Q12), so they share its rate-limit budget. Our relay config raises the WebSocket limit to 50 frames per second per key (D20); each service opens subscriptions at no more than 40 per second and backs off on `rate-limited:`. Three services with 300 channels each then need about 20 s at startup.
- Catch-up pages through `POST /query` with `until` plus the relay's `before_id` extension, not with `until` alone.

## A8: profiles

**Result: holds.**

- A custodial key's kind 0 is accepted. The stored content is byte-for-byte what was sent, including non-standard fields (`mm_user_id`). A newer kind 0 replaces the old one.
- Non-JSON content: `400 "invalid: kind:0 content must be valid JSON"`.
- *(source)* The relay also copies `display_name` (or `name`), `picture` (or `image`), `about`, and a `nip05` on the relay's own domain into its users table; an off-domain `nip05` is dropped there.

Spec changes: none needed. Profiles carry `name`, `display_name` and `picture` (the Mattermost avatar URL, which relay-side readers cannot fetch without a Mattermost session).

## A9: custom tags

**Result: holds.** Tags `[["h",…],["mm","<post id>"],["mm_ts","…"],["x-custom","a","b","c"]]` came back unchanged and in order.

Correction (found in Phase 1): the relay silently ignores filters on multi-letter tags. A query `{"kinds":[9],"#mm":["<value no event carries>"]}` returns unrelated events, while a single-letter filter such as `#e` with no match returns none. The first version of this spike wrongly reported that `#mm` filtering works, because its query was also limited to a channel holding that one event. The `mm` tag is still useful when reading events, but finding the event for a post goes through the bridge's message map (or a per-channel query filtered on the client).

## A10: Mattermost events

**Result: partly fails.**

- The `posted` event sent to the bot carries `mentions` as a JSON string listing **only the receiving user**: the bot's own id when it is mentioned, and no `mentions` field for a post that mentions only `@bob`. The bridge cannot learn who else was mentioned from the event.
- A system-admin bot got no `posted` events from a public or a private channel it is not a member of.
- `GET /channels/{id}/posts?since=` returns edited posts (new message, `edit_at` > 0) and deleted posts (`delete_at` > 0, message emptied) without `include_deleted`.
- The bot receives `post_edited`, `post_deleted`, `user_added` (`data.user_id`, `broadcast.channel_id`) and `user_removed` (`data.user_id`, `data.remover_id`) for its channels, and `user_added` for itself when it is added to a channel: the opt-in signal.
- The system-admin bot adds itself to a private channel: `201`.

Spec change, agreed with the owner (bridge-spec §5): extract `@username` tokens from the message text, resolve them through `POST /api/v4/users/usernames` (cached), and add one `p` tag per mapped identity. Channel enablement and membership mirroring use the confirmed `user_added` / `user_removed` events.

## A11: bot accounts on Team Edition

**Result: holds.** Server reports Version 11.7.12, `BuildEnterpriseReady=false`, `IsLicensed=false`. Creating a bot, creating its token, and posting with it all work; the server adds `props.from_bot = "true"` to bot posts. Disabling the bot makes its token return 401.

## A12: media upload

**Result: holds, but the auth scheme is Blossom, not NIP-98.**

- `PUT /media/upload` without auth, or with a NIP-98 header: `401 {"error":"authentication failed"}`.
- With `Authorization: Nostr <base64 kind 24242>` carrying `["t","upload"]`, `["x",sha256]` and `["expiration",ts]`, plus header `X-SHA-256`: `200 {"url":"http://localhost:3000/media/<sha256>.png","sha256","size","type","uploaded","dim","blurhash","thumb":"http://localhost:3000/media/<sha256>.thumb.jpg"}`. The URL base comes from the request Host *(source)*.
- `GET` of that URL without auth: 401. With a kind 24242 `["t","get"]` from a relay member: 200 and the same bytes.

Spec change (bridge-spec §5): relay media URLs cannot be shown to Mattermost clients (auth plus relay membership required, and the relay is internal). Attachments stay Mattermost permalinks; relay upload is only for agents, if ever (Phase 4).

## X1: X-Pubkey impersonation (found during the spike)

**Result: failed on the default config; fixed in `infra/compose.yml`.**

With `BUZZ_REQUIRE_AUTH_TOKEN` unset (default `false`), an unauthenticated `POST /query` with the header `X-Pubkey: <member pubkey>` returned a private channel's message (HTTP 200). The relay has this as a development fallback *(source)*. With `BUZZ_REQUIRE_AUTH_TOKEN=true` the same request gets 401 and nothing. The flag does not affect NIP-42 or NIP-98, and it makes `BUZZ_RELAY_PRIVATE_KEY` mandatory *(source)*. Decision D16 requires it in every environment.

## X2: Team Edition user cap (owner question Q14)

**Result: the cap is a hard limit in the official build.** `pnpm spike X2` is opt-in because it creates users; it deactivates them again afterwards.

- `GET /api/v4/limits/server` reports `{"maxUsersLimit":200,"maxUsersHardLimit":250,"activeUserCount":3,…}`: a warning at 200 and a hard stop at 250. The stack had 6 active accounts but only 3 counted, because bots do not.
- After 247 users were created (250 active), the next `POST /api/v4/users` failed: `400 api.user.create_user.user_limits.exceeded` "Can't create user. Server exceeds safe user limit. Contact your administrator with: ERROR_SAFETY_LIMITS_EXCEEDED."
- At the limit, existing users still signed in. After the probe users were deactivated, the active count went back to 3, so deactivated users do not count.
- The limit is code in the official Mattermost builds, not configuration. Mostlymatter describes itself as "a fork of Mattermost without users limit" and publishes 11.7.12 binaries for amd64 and arm64 (no container image). Our own fork (Phase 7) carries the same limits patch. A paid licence, or the nonprofit licence (up to 1,000 users), would also lift it; the owner chose not to buy one (D22).

Consequence: development stays on Team Edition (far below the cap). The Phase 6 load test and staging run on a Mostlymatter build of the same version, as D11 already planned (build-plan Phase 6, Q14).

## Other findings

1. **The Host header selects the relay's community.** The relay serves one community keyed on the host:port of `RELAY_URL`. `Host: 127.0.0.1:3000` or `Host: relay:3000` gets `404 "relay: no community is configured for this host"` on `/events` (NIP-11 answers anyway). Services must reach the relay by exactly that host, and NIP-98 `u` tags must use it. Inside Docker, either set `RELAY_URL` to the internal name everyone uses or send the matching Host header. Changing `RELAY_URL` later starts a new, empty community *(source)*.
2. **Sockets must authenticate within 5 s.** The relay sends `["AUTH", challenge]` immediately and closes sockets that have not authenticated within 5 s *(source; an unauthenticated probe socket was closed)*. Before auth, REQ gets `NOTICE "auth-required: …"` plus `CLOSED`, and EVENT gets `OK false "auth-required: not authenticated"`.
3. **Duplicates are success.** Publishing an already-stored event returns `accepted: true, message: "duplicate:"` (HTTP 200), with no side effects or fan-out.
4. **Relay release vs main.** `relay-v0.2.1` (2026-08-08) is the newest relay release; `main` has 98 relay commits since then and Buzz's own compose bundle defaults to `:main`. The `v*` and `desktop-v*` tags are the desktop app.
5. **MinIO images are gone.** `minio/minio` and `minio/mc` no longer exist on Docker Hub, so the bundle at `relay-v0.2.1` cannot be pulled. Buzz `main` switched to `pgsty/silo` and `pgsty/mc`; so did we.
6. **Mattermost image details.** It is published for amd64 only (runs under Rosetta on Apple Silicon), and has no shell or curl; its healthcheck is `mmctl system status --local`, which needs local mode. Bundled and enabled by default: Calls (makes a STUN request to a public server at startup) and the Mattermost Agents AI plugin (`mattermost-ai` 2.0.9). Playbooks needs a licence. See Q9.
7. **Upstream docs that are wrong for 0.2.1** *(source)*:
   - NOSTR.md says `BUZZ_REQUIRE_AUTH_TOKEN` requires NIP-42 for all connections; it only disables the `X-Pubkey` fallback.
   - ARCHITECTURE.md says rate limiting is not enforced; it is.
   - NOSTR.md says kind 9009 is stored and that authors can always delete with 9005; neither is true.
8. **Known upstream bug, untested** *(source)*: a kind 7 reaction to an event that has no channel (kind 0 or kind 1) panics the handler. The bridge only reacts to channel messages.
9. **Size limits.** Relay content up to 262,144 bytes *(source)*; frames up to 524,288 bytes. Mattermost's post limit (about 16,000 characters) is the binding one.

## Found while building Phases 1 and 2

Verified against the same stack (probes in the Phase 1 and 2 work, now covered by the e2e tests).

10. **`limit: 0` subscriptions.** A REQ with `limit: 0` gets `EOSE` with no stored events, and live delivery still includes events whose `created_at` is in the past (a 5-minute-old event arrived live). Live subscriptions use `limit: 0`; history comes from explicit catch-up.
11. **A REQ for a channel the relay does not know is refused** with `CLOSED "restricted: not a channel member"`, even though open channels are otherwise readable by any member.
12. **Membership notifications work live.** A reader subscribed to `{"kinds":[44100,44101],"#p":[<own pubkey>],"limit":0}` receives 44100 live when added to an open or a private channel. Services discover mirrored channels this way (the bridge adds the reader to every mirrored channel), plus a snapshot from `{"kinds":[39002],"#p":[<own pubkey>]}`.
13. **Catch-up must start when a subscription is confirmed, not when it is requested.** Subscription requests are paced (40/s per connection), so with many channels a new channel's REQ can wait seconds in the queue. An event published in that gap is missed by both the live subscription and a catch-up started at request time. Running each channel's catch-up on its `EOSE` closes the gap; a probe that failed before the fix got its reply in 1.5 s after it.
14. **Mattermost refuses bot creation to bot accounts**, even ones with the system admin role: `POST /api/v4/bots` with the @brain token returned `403 api.context.permissions.app_error`, while other admin actions work for that bot. Agent provisioning therefore uses an admin user's personal access token (D25).
15. **Typing indicators.** The relay refuses kind 20002 over HTTP (`400 "restricted: unknown event kind"`) but accepts it over an authenticated WebSocket and delivers it live to `#h` subscriptions. Mattermost accepts `POST /api/v4/users/{bot id}/typing` from the bot's own token (200). The runtime sends 20002 over a short-lived agent socket while it generates; the bridge shows it in Mattermost as the agent's bot.
16. **Per-channel queries do not scale on one key.** With about 130 mirrored channels, per-channel catch-up (one query per channel per run) pushed the shared reader key past its 1200 calls/min limit, and the e2e suite failed with `429 rate-limited`. One paged query without `#h` covers every readable channel (spike A7), so catch-ups now cost the same at any channel count (D27). `RelayClient.query` also waits out a 429 (up to three retries, honouring the relay's "retry in Ns").

## Found while building Phase 4

Verified against the same stack with probes (Mattermost events, relay deletions, reactions and channel metadata), now covered by `e2e/bridge-completeness.e2e.test.ts`.

17. **Mattermost deletions.** `post_deleted` carries the post with `delete_at: 0` (and `delete_by`); the event itself is the deletion. Deleting a thread root also deletes its replies, with no event for them; a `since` query then returns root and replies with `delete_at` and `update_at` set. Bots may delete their own posts. In Team Edition a channel's creator may not delete other people's posts (403); system admins may.
18. **Mattermost reactions.** `reaction_added` and `reaction_removed` carry the reaction (user, post, emoji name). A reaction bumps the post's `update_at`, and `since` responses list the current reactions in `metadata.reactions`. System emoji names are emoji-datasource short names plus `<name>_<tone>_skin_tone` (`+1_light_skin_tone` accepted; `thumbsup_tone2` and `red_heart` refused); `+1` and `thumbsup` are two separate Mattermost reactions.
19. **Mattermost channel events.** A rename or purpose or header change sends `channel_updated` with the whole channel; a privacy change sends `channel_updated` with the new type and `channel_converted` (team broadcast). Archiving sends `channel_deleted`, restoring `channel_restored`; an archived channel drops out of the bot's channel list but stays readable by id. `posted` carries `metadata.files` (names) for attachments. `/_redirect/pl/<post id>` serves the web app, which finds the team itself.
20. **Relay reactions.** Kind 7 needs no `h` tag (the channel comes from the target), and arrives live on `#h` subscriptions with or without one. A second active reaction with the same author, target and content is answered `accepted: false, "duplicate: reaction already exists"` and not stored. Kind 5 by the reactor removes a reaction; adding it again afterwards works.
21. **Relay deletions.** Kind 5 must come from the target's author: the channel owner's kind 5 on someone else's message gets `400 "invalid: must be event author"`, while its kind 9005 works. A deleted event disappears from queries, its deletion event stays visible, and both kinds arrive live on `#h` subscriptions.
22. **Relay channel metadata.** The owner's kind 9002 sets `name`, `about` (an empty value removes it) and `visibility`; 39000 then shows `public` or `private`. `["archived","true"]` makes the relay refuse every event in the channel, 9000 and 9007 included (`invalid: channel is archived`), until `["archived","false"]`; 39000 shows `["archived","true"]` meanwhile. Removing the reader with 9001 closes its subscription with `CLOSED "restricted: channel access revoked"`, and it can no longer read a private channel.
23. **Identical events are deduplicated by id.** Toggling a channel private, open and private within one second made the third kind 9002 byte-identical to the first (same tags, same second), so the relay answered `duplicate:` and the channel stayed open. The same applies to a reaction removed and re-added, or a member removed and re-added, within one second. The bridge's signers now move such a repeat one second later (D32).

## Found while building Phase 5

24. **Channel metadata arrives live per channel.** After the owner's kind 9002, a reader subscribed with `{"kinds":[9,39000,39002],"#h":[channel]}` received the new 39000 and 39002 live, although those events carry `d`, not `h`. A query `{"kinds":[39000]}` without `#d` returns the metadata of every channel the reader can read.
25. **Same-second ordering.** A reply posted right after its root often has the same `created_at` second, so ordering by `created_at` then id put replies before roots in about half the cases. Thread rendering and agent context now put the root first and order replies by `mm_ts` in milliseconds.

## Found while building Phase 6

26. **Relay ownership can be handed over.** The owner adds a key with 9030 `["role","admin"]` (only the owner may grant admin) and promotes it with 9032 `["role","owner"]`. A channel owner adds another owner with 9000 `["role","owner"]`; the last owner cannot be demoted. An owner cannot remove another owner (9031), and archived channels refuse every change. After the relay restarts with a new `RELAY_OWNER_PUBKEY`, the old key's attempt to step down gets `must be owner`, and the new owner can then remove it. The rotation scripts follow these rules (docs/operations.md section 4).
27. **A restarted relay drops pooled connections.** The first request on a kept-alive connection after a relay restart failed with `fetch failed`. `RelayClient.query` now retries connection errors as it does rate limits.
28. **A wiped relay without the reset dead-letters everything.** When the relay lost its data but our state still marked identities as relay members, every person's publish got `403 You must be a relay member` and was dead-lettered. `pnpm relay:rebuild` resets that state (docs/operations.md section 5). Replaying those dead letters later found the signed events past the relay's 900 s window (`event timestamp too far from server time`), so replay now mirrors such posts again from Mattermost.
29. **Mostlymatter.** Framasoft publishes `mostlymatter-amd64-v11.7.12` (116.9 MB) with a SHA-512 file and a minisign signature. The signature verified with Framasoft's key `RWSoFpHRlDgrwN2JmiT+JoV2nQBDzvhOgk4GGdmpzGRuhSRD4/F81JX3` (trusted comment timestamp 1791472334, 2026-10-08), and the binary reports version 11.7.12. With it, `GET /api/v4/limits/server` reports `maxUsersHardLimit: 10000000`. Building the image needs BuildKit (`docker-buildx`); the classic builder could not resolve the multi-arch Alpine digest.
30. **Mattermost allows 50 members per team by default** (`TeamSettings.MaxUsersPerTeam`). The 51st join fails with `app.team.join_user_to_team.save_member.max_accounts.app_error`. `pnpm dev:seed` now sets it to 10,000; a production workspace needs the same.
31. **Catch-up re-indexing churn (load test).** The first full load run measured a real index lag of 130 s median and 151 s p95, against a 30 s debounce. Ingestion's periodic catch-up re-reads the last 10 minutes and marked every thread it saw as pending again, so all recent threads were indexed again. Those re-indexes competed with new threads for the reader key's 15 requests per second. Messages and changes already handled are now skipped, and a thread is read in one request instead of two. The service's own lag histogram had hidden this: its buckets were too coarse (30 to 60 s), and its base time moved when a thread was postponed. It now measures from the thread's first change, with finer buckets, and the load test measures index lag exactly from each document's first write.

## Found while working on Phase 7

32. **Mattermost's built-in branding works without a licence.** On Team Edition 11.7.12 with no licence, `PUT /api/v4/config/patch` accepts `TeamSettings.SiteName`, `EnableCustomBrand` and `CustomDescriptionText`, and `POST /api/v4/brand/image` (multipart field `image`) stores a login-page image. Mattermost re-encodes that image, so `GET /api/v4/brand/image` does not return the uploaded bytes. The login page then shows the image, the description and the site name, and the tab title reads "Log in - Enterprise Brain". Mattermost's logo and "Team Edition" badge in the login header and the "© Mattermost Inc." footer stay; only the fork can change them. `ServiceSettings.EnableDesktopLandingPage: false` removes the page that offers Mattermost's desktop app before login.
33. **Railway, while deploying staging.** New environments resolve private hostnames over IPv4 as well as IPv6: containers had 10.x addresses, and the relay listening on `[::]:3000` and Postgres, Redis and the S3 store on their defaults were all reachable. `railway environment edit --service-config <service> <path> <value>` answered "No changes to apply" for every path tried (CLI 5.63.1), so the setup uses the public GraphQL API (`serviceInstanceUpdate`, `variableCollectionUpsert`, `volumeCreate`, `serviceDomainCreate`) through `railway api`. `railway up .` fails with "prefix not found"; without a path it uploads the linked directory. Pro volumes default to 50 GB. Railway reformats JSON log lines as `[INFO] message key=value`. `railway ssh` needs a local SSH key, and this CLI login could not list SSH keys ("You do not have access to this resource"). A sandbox created with `--private-network` and `--variable NAME=${{service.NAME}}` runs commands on the private network, with the reference resolved by Railway, so no secret passes through the laptop. On the very first start the relay refused the reader key's queries (`relay_membership_required`) for a moment, until the bridge granted the membership (D45). Mattermost warns that it cannot send welcome emails (no SMTP) and that Calls finds no public IP.
34. **A new agent was ignored for up to 30 seconds.** On staging, an agent created through the admin API and mentioned a few seconds later did not answer: agent-runtime re-read the registry only every 30 seconds. It now also re-reads it when a message names an unknown key (D47); the admin-api e2e test runs with the periodic refresh off to prove it, and on staging a new agent answered 1.2 seconds after it was created.
35. **Our own Mattermost build (D48).** The user limits live in `server/channels/app/limits.go` as constants 200 and 250; the code applies them only when the first is above zero and treats a zero hard limit as none, so zero removes the limit, and `GET /api/v4/limits/server` then reports `maxUsersLimit: 0, maxUsersHardLimit: 0`. Building it in CI taught three things: the server must be built and tested with the Go workspace that `make setup-go-work` creates (plain `go test` compiled against an older published `server/public` and failed), the API tests need a Redis at localhost:6379, and the web app installs only with upstream's Node version from `.nvmrc` (24.11; newer npm rejected upstream's lockfile). Overlaying the release on the Team Edition image works: on the local stack every spike gave its earlier result, the e2e suite passed, and `pnpm spike X3` reached 260 active users. Mattermost accepts empty About, Help, Privacy and problem-report links, which hides them, but puts its own Terms link back when that one is emptied.

