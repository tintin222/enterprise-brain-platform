# Load test (Phase 6)

Build-plan Phase 6 task 5: load test at the scale of Q7 in `docs/decisions.md` (500 people, 300 channels, 50 agents), checking relay subscription and rate limits. Team Edition stops at 250 users, so the test runs on Mostlymatter 11.7.12 (D40, Q14).

## Method

`pnpm load-test` (`scripts/load/run.ts`), against a fresh local stack on Mostlymatter (`pnpm dev:down --wipe && pnpm dev:up --mostlymatter && pnpm dev:seed`), with the bridge, agent-runtime and ingestion running as separate processes at their default settings (`LOG_LEVEL=warn`). The script:

1. Creates 500 people, 50 agents with the echo model, and 300 channels (every fifth private). Each channel gets 25 people and one agent, so each person is in about 15 channels and each agent in 6.
2. Adds `@brain` to all 300 channels at once and measures **onboarding**: the time until every channel exists on the relay with all its members. That is about 9,400 writes by the bridge key: one channel create and 27 member additions per channel, plus 500 relay memberships for the people's new keys.
3. Waits until agent-runtime and ingestion each hold a confirmed subscription for every channel. That makes 900 subscriptions on the shared reader key, plus the bridge's own.
4. Posts at 5 messages per second for 120 seconds, from 100 logged-in people in channels they belong to. 10% of messages mention the channel's agent; 20% of the rest are thread replies.
5. Checks every post appears on the relay exactly once and every mention gets exactly one agent reply, and reads the services' `/metrics`. Timing quantiles cover only the message phase (the difference between two scrapes).

Targets (D38): onboarding within 15 minutes; Mattermost to relay p95 within 2 s; mention to reply p95 within 10 s (echo model, so model latency is excluded); index lag p95 within the 30 s debounce plus 15 s; no lost, duplicated or failed messages; no new dead letters; every subscription confirmed.

## Results

Run on 2026-10-12, on an arm64 Mac: Colima VM with 4 CPUs and 8 GB, Mattermost under Rosetta (its image is amd64-only), every service at its default settings. The final run started from a wiped stack:

| Measure | Target | Result |
| --- | --- | --- |
| Onboarding: 300 channels with all members on the relay | 15 min | **587 s** (9.8 min) |
| Posts | no loss, duplicate or failure | **600 sent at 5.0 per second; 0 failed, 0 missing, 0 duplicated on the relay** |
| Mattermost to relay | p95 2 s | **p50 0.05 s, p95 0.10 s** |
| Relay to Mattermost (agent messages) | | p50 0.56 s, p95 0.97 s (measured from the relay `created_at`, which has whole seconds) |
| Mention to agent reply in Mattermost (echo model) | p95 10 s | **53 mentions, each answered exactly once; p50 0.11 s, p95 0.15 s, max 1.35 s** |
| Index lag (546 new threads, 30 s debounce) | p95 45 s | **all indexed; p50 30.4 s, p95 30.8 s, max 32.2 s** |
| Relay requests during the message phase | | 4,590; **0 rate-limited**, 0 errors, 0 reconnects |
| Dead letters, retries | none | **none** |
| Confirmed subscriptions | every channel, every service | bridge 302, agent-runtime 303, ingestion 303 (300 test channels plus the seeded ones) |

Every target is met. The JSON report is in `scripts/load/results/` (not committed).

### What the first runs found

- **Mattermost allows 50 members per team by default.** The first attempt stopped at the 51st person (`max_accounts`). `pnpm dev:seed` now sets `TeamSettings.MaxUsersPerTeam` to 10,000 (D42); a production workspace needs the same setting.
- **Ingestion re-indexed every recent thread on each catch-up.** The first complete run met every target except indexing. Measured exactly, the index lag was a median of 130 s and a p95 of 151 s, against the 30 s debounce. Catch-up re-reads an overlap window and marked each thread it saw as pending again. Fixed by skipping messages and changes already handled, and by reading a thread in one relay request instead of two (spike findings, item 31). The service's own lag histogram had under-reported the problem; it now measures from a thread's first change, with finer buckets.

### Limits and headroom

- **Onboarding is bounded by the relay's per-key limit on the bridge key.** Enabling 300 channels with 25 people each takes about 9,400 bridge-key writes. At the bridge's throttle of 15 per second (the relay allows 20 with D20's settings) that is about 10 minutes. It is a one-time cost per channel. Raising `BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN`, together with `RELAY_REQUESTS_PER_SECOND`, would shorten it proportionally.
- **The shared reader key carries the bridge's, agent-runtime's and ingestion's reads.** Each process throttles itself to 15 requests per second, but the relay counts all three against one 20-per-second limit. Across the measured window (about 158 s from the end of onboarding to the end of the checks), the services made about 29 relay requests per second over all keys, with no 429. A busier workspace may see occasional 429s on the reader key. They are retried; if they persist, raise the relay limit (D20).
- **Model time is not included.** The echo model answers instantly. With a real model, reply latency adds the model's response time, typically several seconds; the rest of the path stays under 0.2 s at p95.
- **Real hardware will differ.** These numbers come from a laptop running everything in one VM. Run `pnpm load-test` in staging with production resources before launch (docs/phase7.md).
