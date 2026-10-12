# Security review (Phase 6)

Scope: the prompt path (chat content to model to reply), private-channel retrieval, and secrets in logs, as build-plan Phase 6 task 7 asks; plus the trust boundaries in `docs/architecture.md` section 6. Reviewed on 2026-10-12 against the code at the Phase 6 commit. Findings marked **fixed** were changed in Phase 6 and are covered by tests.

## 1. Prompt path

| # | Finding | Status |
| --- | --- | --- |
| P1 | The channel's name and purpose (built from the Mattermost purpose and header, which any channel member can edit) were placed in the system prompt, so a member could inject instructions with the agent's authority. | **Fixed.** The system prompt now holds only the agent's name, its registry instructions and the fixed rules. The channel's name and purpose go in the user turn as quoted JSON data, like the conversation (`llm/prompt.ts`; unit test "keeps chat content out of the system prompt"). |
| P2 | An agent reply, possibly steered by injected text, could contain `@channel`, `@all` or `@here` and notify a whole channel. | **Fixed.** The bridge breaks these with a zero-width space before posting agent text to Mattermost (`neutralizeSpecialMentions`, unit tested). People's own mentions are unaffected. |
| P3 | Chat content and knowledge passages are untrusted. | Holds. Both are passed as quoted JSON in the user turn. The system prompt says they are data, not instructions, and tells the model to ignore requests to change its role, rules, tools or permissions. |
| P4 | Instructions and tool permissions must come from the registry only. | Holds. `instructions` comes from `runtime.agents`; chat cannot change a registry record. No tools are enabled (`tools: []`), so a successful injection can only shape one reply's text. Enabling tools later needs a fresh review. |
| P5 | Knowledge passages from open channels can carry injected text into another channel's answer. | Accepted risk, mitigated by P3 and P4. With no tools and capped replies (D26), the impact is limited to the reply's text. |
| P6 | Loops and floods. | Holds. Agents answer agents only on an explicit mention, replies per agent and thread are capped, and mentions older than `MAX_EVENT_AGE_SECONDS` or tagged `backfill` are never answered (e2e: two agents do not loop; backfill and a relay rebuild do not trigger agents). |
| P7 | Refusals. | Holds. A refusal (`stop_reason: refusal`, after the API's server-side fallback) becomes a short decline instead of an empty reply. |

## 2. Private-channel retrieval

| # | Finding | Status |
| --- | --- | --- |
| R1 | A search made in channel X must never return content from private channel Y. | Holds (D35). The brain returns documents from X itself and from active open channels only; e2e "B.5 test 5". The asking person's own membership of Y does not widen the scope, because the answer is visible to everyone in X. |
| R2 | A channel made private must leave other channels' results. | Holds, with a short window. Mattermost's `channel_updated` makes the bridge publish kind 9002 at once; the relay emits a new 39000, which ingestion receives live and passes to the brain (e2e: Z made private leaves X's results within seconds). If the bridge misses the event, reconciliation repairs it within `RECONCILE_INTERVAL_SECONDS` (default 300). During that window the channel's existing documents remain searchable from open-channel context. |
| R3 | Paused and archived channels must not be retrieved (Q4). | Holds. The bridge removes the reader key from them (D28); ingestion marks them inactive in the brain and the search excludes inactive channels, except the asking channel itself. |
| R4 | Documents must not snapshot membership. | Holds. Documents store the channel id only; visibility and active state are channel facts looked up at query time. |
| R5 | Agents act only where they are members. | Holds. The runtime checks relay channel membership (kind 39002), which the bridge mirrors from Mattermost; an agent bot outside a channel is not a relay member there and is not triggered (e2e). Bots in channels without `@brain` are reported by reconciliation (Q2). |
| R6 | Only agents' relay events flow back to Mattermost. | Holds. The bridge mirrors relay events to Mattermost only when their author is a registered agent identity. A person's custodial key, if stolen, cannot post into Mattermost through the bridge. |
| R7 | Search input. | Holds. Queries are parameterized SQL; the full-text query is built from the database's own lexemes with `quote_literal` (`packages/brain/src/search.ts`); the vector is passed as a parameter. |
| R8 | The brain API's access (Phase 0). | Holds, with a window. A person's channel list comes from Mattermost through the bot's token and is cached 20 s (`packages/brain-api/src/access.ts`), so a membership change shows in search within that time; private content is filtered in SQL by relay channel id, container entities by the containers of the person's channels, and administrators see everything. Cookie-authenticated writes need `X-Requested-With`; Mattermost's callbacks are verified by the command token and by signed states. The e2e test "a private channel's conversation is visible to its members only" covers it. |

## 3. Secrets

| # | Finding | Status |
| --- | --- | --- |
| S1 | No secret may appear in logs. | Holds. `pnpm check:logs` searches for every `.env` secret and every key store secret, decrypted, as text, hex and base64. It found none in the full e2e suite run with `E2E_LOG_LEVEL=trace` (174 KiB of service logs, including standalone service runs) or in the relay and Mattermost container logs (1.5 MiB). It does find a token planted in a test file. |
| S2 | Secrets at rest. | Holds. Key store secrets use AES-256-GCM with the reference as associated data (a ciphertext cannot be moved to another identity). `.env` is mode 600 and ignored by git. Rotation procedures exist and were exercised (docs/operations.md section 4). |
| S3 | Relay authentication. | Holds. `BUZZ_REQUIRE_AUTH_TOKEN=true` closes the `X-Pubkey` impersonation path (spike X1); relay membership is required; every host port binds to 127.0.0.1. |
| S4 | A removed relay member keeps an already open socket (spike A6). | Accepted, documented. After removing a reader or agent key, restart what may hold its socket (docs/operations.md section 4). |
| S5 | `MM_ADMIN_TOKEN` is a system admin token. | Accepted for now. Mattermost has no narrower permission for bot creation (D25). Only agent provisioning uses it; keep it out of the services that run continuously, and rotate it like the bridge token. |
| S6 | Dead-letter payloads can contain message text. | Accepted. They live in our state database, and `pnpm dead-letter list` prints no message text; `show` does, for an operator. |
| S7 | Operations endpoints. | Holds. They bind to 127.0.0.1 by default and expose counts and timings only, with no content, names or tokens. The brain API shares its public port with its pages, so its `/metrics` needs the service token or an administrator's session (`/healthz` and `/readyz` stay open for the platform's checks). |
