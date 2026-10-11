# Starter kit: agent-enabled chat on Mattermost with a Buzz relay

Planning documents for an AI coding agent. They describe what to build, in what order, and what must be checked against the real systems first.

## What is in the kit

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Project guide the coding agent reads at the start of every session |
| `docs/architecture.md` | Components, sources of truth, identity model, security |
| `docs/bridge-spec.md` | The Mattermost <-> Buzz bridge in detail |
| `docs/agents-and-ingestion.md` | Agent runtime and brain ingestion |
| `docs/build-plan.md` | Eight phases with acceptance criteria |
| `docs/decisions.md` | Decisions, verified facts, assumptions to test, open questions |

## How to use it

1. Create an empty git repository and copy these files into its root, keeping the `docs/` folder.
2. Open `docs/decisions.md` and answer the open questions (Q1..Q8) you already know, by editing the "Default" column or adding a note. Q1 (language) matters most before any code exists.
3. Start the coding agent in the repository and give it the first prompt below.
4. Review `docs/spike-findings.md` when Phase 0 finishes, then continue one phase at a time.

You need Docker on the machine where the coding agent runs.

## First prompt

```
Read CLAUDE.md and every file in docs/. Then do Phase 0 from docs/build-plan.md
and nothing beyond it.

Before writing code, tell me your plan for Phase 0 and list anything in the docs
that looks contradictory or unclear.

While working: pin every image and dependency, test each assumption A1..A12
against the running local stack, and record the result in docs/spike-findings.md.
Where reality differs from the specs, update the specs.

Stop when Phase 0's acceptance criteria pass and give me a short report:
what works, what failed, and which open questions you need me to answer.
```

## Prompt for each later phase

```
Read CLAUDE.md, docs/spike-findings.md and docs/build-plan.md. Do Phase N only.
Start by restating the acceptance criteria and your plan. Stop when they pass
and report what you verified and what remains uncertain.
```

## Things to know before you start

- Several details of how the Buzz relay behaves are marked as assumptions because they could not be confirmed from its documentation. Phase 0 exists to test them. Expect some spec changes after it.
- Buzz is young and changes quickly. The plan pins one release and keeps all relay access behind a single interface.
- Development uses the standard Mattermost Team Edition container. Mostlymatter and your own branded build come in Phase 7.
