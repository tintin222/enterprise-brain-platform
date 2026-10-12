# Agent runtime and ingestion

Both services read the Buzz relay with the shared reader key (the bridge uses it too, Q12) and never talk to Mattermost. Items marked **(A#)** depended on an assumption in `docs/decisions.md`; Phase 0 tested each one (`docs/spike-findings.md`). Where an assumption failed, the replacement written here was agreed with the owner on 2026-10-12.

## Part A: Agent runtime

### A.1 Agent registry

An agent is a product object that users create in the enterprise brain. The runtime needs this record:

| Field | Meaning |
| --- | --- |
| `agent_id` | Stable id |
| `handle`, `display_name`, `avatar_url` | How it appears in chat |
| `instructions` | The agent's standing instructions (system prompt) |
| `model` | Model identifier, from configuration. Never hardcode a model id. |
| `tools` | Allow-list of tools the agent may call |
| `knowledge_scope` | Which brain collections it may search, on top of channel access rules |
| `nostr_pubkey`, encrypted secret key | Relay identity. The secret lives in the shared key store (D19). |
| `mm_bot_user_id`, encrypted bot token | Mattermost identity. The token lives in the shared key store (D19). |
| `status` | `active`, `disabled` |

If the brain already stores agent definitions, read them through an adapter and keep only the chat-specific fields (keys, bot ids) in our database.

### A.2 Provisioning an agent

One operation, safe to re-run:

1. Generate a Nostr keypair and store it encrypted in the shared key store (D19).
2. Create a Mattermost bot account (`POST /api/v4/bots`), add it to the team, create an access token for it, store the token encrypted in the same key store **(A11, confirmed)**. These calls use an admin user's token: Mattermost refuses bot creation to bot accounts, even system admins (D25).
3. Register the identity with the bridge (`identity_map`, kind `agent`), which adds it to the relay as a member and publishes its profile.

Disabling an agent deactivates the bot account and stops dispatch; it does not delete history.

### A.3 Dispatch

Use a single dispatcher instead of one relay connection per agent.

1. The dispatcher reads the relay as the shared reader key with one subscription per active channel (catch-up for all of them is one paged `{"kinds":[9],"#p":[<agent keys>],"since":…}` query, D27), each naming that single channel in `#h` **(A7)**. A filter listing several channels, or filtering by `#p` alone, receives nothing live. Limits and pacing are in `docs/bridge-spec.md` section 6.
2. For each chat event (kind 9), collect the mentioned pubkeys from its `["p", …]` tags **(A3, confirmed)** and keep those that belong to active agents. Mention text in content is `@Display Name` and is not needed for matching.
3. For each such agent, check it is a member of the channel (relay kind 39002, cached; seeded for every channel by one `{"kinds":[39002],"#p":[<reader>]}` query). Keep the cache fresh with a `{"kinds":[39002],"#h":[channel]}` subscription per channel, which delivers the updated list live. Membership notifications (44100/44101) only reach the key they are about, so they cannot track agents **(A6)**.
4. Enqueue a job keyed by `(agent_id, thread_root_event_id)`. At most one job runs per key; later mentions in the same thread queue behind it. As built: table `runtime.jobs`, unique on `(agent_id, trigger_event_id)`, which is also the record of processed events; open jobs resume after a restart.

Do not trigger when:

- the event's author is an agent and the mention is not explicit in the content,
- the agent has already replied more than `MAX_REPLIES_PER_THREAD` times in that thread within the window (`REPLY_WINDOW_SECONDS`; queued and running jobs count too, so a burst cannot overshoot),
- the event is older than `MAX_EVENT_AGE` (avoids answering history during catch-up or backfill). Take the age from the `["mm_ts", …]` tag when present, because the bridge cannot give old messages their original `created_at`, and never trigger on events tagged `["backfill", "1"]`,
- the event id was already processed (store processed ids).

A persistent job queue in Postgres is enough for v1.

### A.4 Building context

For a job, assemble:

1. **Thread.** The root event and its replies, oldest first, each as `{author display name, role (person or agent), time, text}`, with each message's newest edit (kind 40003 by its author) applied; the relay already hides deleted messages. Cap by token budget, keeping the root and the most recent messages.
2. **Channel background.** Channel name and purpose, plus the last few channel messages before the thread if the thread is short.
3. **Retrieved knowledge.** Query the brain with the question, passing the channel id and the asking person's identity so retrieval honours access rules. As built: the query is the triggering message without its @mentions, the current thread's own document is left out (it is already in the conversation), and up to 5 passages are passed with their source links, which the model is told to cite.

Present chat content to the model as quoted conversation material. The agent's instructions and tool permissions come only from the registry.

### A.5 Generating and publishing

1. Signal activity: typing (kind 20002, ephemeral) over a short-lived WebSocket authenticated as the agent, repeated every 4 s while generating. The relay refuses 20002 over HTTP. The bridge shows it in Mattermost as the agent's bot.
2. Call the model through a provider interface (`LlmProvider.generate`), with tool calls limited to the agent's allow-list.
3. Publish the reply as kind 9 signed by the agent's key, with the channel tag, a reply tag pointing at the thread root, and `["e", <triggering event id>, "", "mention"]`. The relay ignores that marker for threading, but a `#e` query by the triggering event finds the reply, so a restarted runtime can see which mentions it already answered. The reply also p-tags the author of the triggering message and any registered agent the reply names with `@handle` (D26). Publish through `RelayClient` using the same HTTP path the bridge uses **(A1, confirmed)**. To mention a person, use `@Display Name` in the text and a `["p", pubkey]` tag.
4. The bridge mirrors it into Mattermost. The runtime does not post to Mattermost itself.

Streaming is optional and later: publish a first partial reply, then edit events (kind 40003 `[["h", channel], ["e", reply_id]]` with the full text so far) at a throttled rate **(A4, confirmed)**. The relay allows each key 300 HTTP calls per minute by default.

On failure, publish a short apology reply once, record the error, and do not retry automatically more than twice.

### A.6 Interfaces

```ts
interface LlmProvider {
  generate(input: {
    model: string;
    instructions: string;
    conversation: ConversationTurn[];
    knowledge: RetrievedPassage[];
    tools: ToolSpec[];
  }): Promise<{ text: string; toolCalls?: ToolCall[]; usage: Usage }>;
}

interface BrainClient {
  search(input: {
    query: string;
    channelId: string;          // access scope
    requesterId?: string;       // the person who asked
    scope?: string[];           // the agent's knowledge_scope
    limit: number;
  }): Promise<RetrievedPassage[]>;

  upsertDocuments(docs: BrainDocument[]): Promise<void>;
  deleteDocuments(ids: string[]): Promise<void>;
  // Added in Phase 5: the channel facts needed to scope access at query time (B.3, D36).
  upsertChannels(channels: { channelId: string; name: string; visibility: 'open' | 'private'; active: boolean }[]): Promise<void>;
}
```

The default `LlmProvider` implementation uses the Anthropic Messages API through the official SDK (`@anthropic-ai/sdk`). The model id comes from configuration, default `claude-opus-5-5`, and an agent's `model` field overrides it; the API key comes from the environment (D21). Set effort explicitly, check `stop_reason` for refusals, and enable the API's server-side refusal fallback. Confirm current model identifiers and API details against the provider's documentation at build time.

If the brain has no API yet, implement `BrainClient` against a local Postgres table with vector search behind the same interface, so the rest of the system does not change later. As built: `PostgresBrainClient` (schema `brain`) uses Postgres full-text search instead of vectors, because no embeddings provider is configured (D34).

## Part B: Ingestion

### B.1 Consumer

- One relay subscription per active channel as the shared reader key **(A7)**, plus catch-up on start using the same overlap-and-dedupe approach as the bridge, paging `POST /query` with `until` and `before_id` (`docs/bridge-spec.md`, section 8). As built: active channels are the reader's (ChannelWatcher, as in agent-runtime); catch-up is one paged query across channels (D27) with its own cursor, and the first run reads all history.
- Its own cursor table; it must not depend on the bridge's cursors.
- Handles: kind 9 (message), kind 40003 (edit: a separate event; the newest per target by `created_at` wins), kind 5 and 9005 (deletion: the relay hides deleted events from queries, the deletion event itself stays visible), kind 39000 (channel metadata, delivered live on the channel's `#h` subscription), kind 39002 (membership, for access checks). As built, 39002 is not needed: access follows visibility (B.3).
- Idempotent by event id. Every message's thread is recorded (`ingestion.messages`), because an edit or deletion names only its target and the relay hides deleted events. Catch-up re-reads an overlap window, so a message or change already handled (in `ingestion.messages` or `ingestion.seen_changes`) does not mark its thread again; without that, every catch-up re-indexed every recent thread (Phase 6 load test).
- A change marks its thread pending in a table: the first change sets when it is due (the debounce), later ones only count. When due, the thread is read again from the relay in one request (root, replies, and the newest edits of the messages ingestion has recorded), rendered and upserted, or deleted when nothing is left. A change that lands during indexing keeps the thread pending for another pass, and the table survives restarts.

### B.2 Document model

Index threads, not single messages. A message without replies is a thread of one.

| Field | Value |
| --- | --- |
| `id` | `thread:{relay_channel_id}:{root_event_id}` |
| `text` | Thread rendered as "Author: message" lines in time order |
| `channel_id`, `channel_name` | For filtering and display |
| `authors` | Display names and stable ids |
| `first_at`, `last_at` | Time range, from each message's `mm_ts` tag when present, otherwise `created_at` (A5) |
| `source_url` | Mattermost permalink of the root post. As built: `{MM_URL}/_redirect/pl/{post id}` from the root event's `mm` tag, so ingestion needs neither the bridge's tables nor the team name (D37). A thread whose root is an agent message has no link. |
| `event_ids` | All events included, for deletion handling |

Re-render and upsert the thread document when a message is added, edited or deleted. Debounce per thread (for example 30 seconds) so active threads are not re-indexed on every message. Very long threads are split into overlapping chunks with ids `thread:...:{n}`. As built: `INGEST_DEBOUNCE_SECONDS` (30) counts from a thread's first change, so a busy thread is still indexed within the window; `INGEST_CHUNK_CHARS` (6000) caps a chunk, chunks overlap by one message, and the root comes first, then replies by `mm_ts` in milliseconds (created_at has whole seconds only).

### B.3 Access control

- Store only `channel_id` on the document, never a list of members.
- At query time the brain resolves who may see the document from current channel membership and visibility.
- Open-channel content is visible to everyone in the workspace; private-channel content only to current members.
- If the brain cannot enforce this yet, ingest open channels only and leave private channels for later. Record that choice in `docs/decisions.md`.
- As built (D35): a search made in channel X returns documents from X itself and from active open channels, never from another private channel, because an agent's answer is visible to everyone in X. Ingestion keeps each channel's name, visibility and active state in the brain (`upsertChannels`) from kind 39000 and the reader's membership, so a channel made private leaves other channels' results within about a second.

### B.4 Deletion and retention

- A deletion event removes the message from its thread document; if the thread becomes empty, delete the document.
- When a channel is paused or archived, follow the retention choice in Q4 of `docs/decisions.md`: keep its documents, stop updating them, exclude them from retrieval. The bridge removes the reader key from such channels (D28), so the reader's 44101 notification is the signal.
- Keep a way to purge everything from one channel or one author on request. As built: `pnpm ingest:purge --channel <relay channel id>` or `--author <pubkey>` deletes the documents and records an exclusion, so the content is never indexed again; an author's threads are re-indexed without them.

### B.5 Tests that must exist

1. A new thread appears in the brain within the debounce window.
2. Editing a message changes the indexed text.
3. Deleting a message removes its text; deleting the last message removes the document.
4. Restarting ingestion neither loses nor duplicates documents.
5. A search made in the context of channel X never returns content from private channel Y.

All five are in `e2e/ingestion.e2e.test.ts`, with the purges and an agent answer that cites an earlier thread.
