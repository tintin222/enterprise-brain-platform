# Company Brain — Requirements & Roadmap

Oct 12, 2026 · @özgür göksu

> Converted on 2026-10-12 from the owner's PDF "Company Brain — Requirements & Roadmap" (30 pages). The wording is the PDF's; the two figures (the five-layer architecture and the roadmap) are described in text where they appeared. Requirement ids (FR-x.y, NFR-x) are stable and are referenced from commits, tests and `docs/brain/`.

## 1. Purpose and how to use this document

This document is the product specification for turning the existing Mattermost clone into a **Company Brain**: a messaging platform that captures, structures and keeps alive everything a company knows, and lets agents act on it. It is written to be handed to the Claude Code session that built the clone.

How to use it in Claude Code:

1. Save this document as `docs/COMPANY_BRAIN_SPEC.md` in the repository and reference it from `CLAUDE.md`.
2. Start with section 12 (instructions for the session): inspect the current codebase, map existing entities to the domain model in section 3, and produce a gap analysis before writing code.
3. Implement phase by phase (section 11). Each phase ends with its acceptance criteria green and a demo in the running app.
4. Requirement IDs (FR-x.y, NFR-x) are stable. Reference them in commits, PRs and tests so coverage is traceable.

The product is **installed separately for each customer company**; there is no multi-tenant layer. Two kinds of installation run the same code: **Infinics itself** (an agentic AI development company running client projects) and **enterprise customers** (any company that wants one place where mail, documents, systems knowledge and people knowledge stop getting lost). The Infinics installation is the first target; enterprise needs must not be designed out.

## 2. Vision

A company brain is a single, continuously updated model of what the company knows: its projects, its people, its systems, its decisions, its commitments and its documents, linked together and reachable by both humans and agents. Today that knowledge is scattered across mailboxes, shared drives, IT systems and people's heads, and it leaks every time someone leaves, a thread goes quiet or a document is overwritten.

The messaging platform is the right host for the brain because it is where the company already talks. Every channel, thread and direct message is a feed into the brain; every agent output is a message back into the conversation. The brain is not a separate wiki people forget to update; it is updated as a side effect of working.

### Design principles

1. **Capture at the source.** Information enters the brain from where it is created (chat, mail, documents, forms, integrations), not through manual re-entry.
2. **Everything is linked to a project or a topic.** A requirement, a credential, a mail thread or a decision that is not attached to a container is a loss waiting to happen.
3. **Agents are first-class members.** The analyst, the follow-up agent and the packager are workspace members with permissions, audit trails and their own channels.
4. **Humans stay in control.** Agents propose; people confirm. Credentials and outbound actions (sending mail, creating tasks for others) always pass through a human or an explicit policy.
5. **Exportable by design.** Any project can be packaged into a self-contained bundle a forward deployed engineer can hand to Claude Code and continue from.
6. **One installation per customer.** Each customer runs its own instance with its own database and keys; isolation is physical, not a column. Infinics' own instance is the reference installation.

### Two operating modes

| Mode | Primary user | Top-level containers | First-class entities |
| --- | --- | --- | --- |
| Dev company (Infinics) | Forward deployed engineers, founders | Project: a client engagement to build or extend a system; Topic: an ongoing client or internal concern | Client, Project, Topic, Target System, Requirement, Dev Package |
| Enterprise | Department staff, managers, IT | Project: a bounded initiative; Topic: ongoing work held in a channel, internal or with external parties | Topic, Project, Team, Process, Decision, Document |

Both modes share the same data model; the difference is which entity types are enabled in the installation and which agent playbooks run.

### Projects and Topics

Not everything is a project. In an enterprise much of the work is an ongoing concern with no end date: a vendor relationship, a recurring compliance process, a product line, a client account, an internal initiative. These are **Topics**. A Topic is a channel, internal or shared with external participants, that is also a knowledge container: it carries the same attachments as a Project (people, systems, documents, decisions, tasks, credentials, requirements) but has no stage, timeline or end date. When work inside a Topic becomes bounded, a Project is spawned from it and stays linked to it. Projects and Topics are the two top-level containers; everything else hangs off one of them.

## 3. Core domain model

Everything in the brain is an **entity** with a type, an owner, a version history, an access policy and a set of typed **links** to other entities. The messaging layer already has Teams, Channels, Posts and Users; the brain adds the entities below and links them to conversations rather than replacing them.

*Figure: "Everything captured is linked, stored once and acted on by agents" (company brain architecture, 5 layers).* Four sources (chat channels and DMs; mail and calendar; documents and uploads; git, tickets, Teams) feed one ingestion step (parse, classify, link to a project, embed, dedupe), which fills the knowledge store (entities, typed links, versions, vectors, encrypted credentials). Three agents read from the store: the Analyst agent produces requirements and decisions, the Follow-up agent produces tasks posted back to chat, and the Packager agent produces the dev package for Claude Code. Agents read only from the store; humans confirm what agents write back.

Sources feed one ingestion step, the store is the single truth, and the three agents produce requirements, tasks and the development package from it.

| Entity | What it holds | Key links |
| --- | --- | --- |
| Project (top-level) | Name, client, goal, status, stage, start/end, stakeholders, channels | has Requirements, Systems, Documents, Credentials, Tasks, Decisions, Package; may be spawned from a Topic |
| Topic (top-level) | An ongoing internal or external concern backed by a channel: name, kind (internal/external), external organization, owner, description | has the same children as a Project except Package and timeline; spawns Projects |
| Person | Internal user or external contact: role, org, expertise, responsibilities, availability, contact channels | member of Projects and Topics, owner of Tasks, source of Requirements |
| System (Target System) | An existing or planned IT system: description, tech stack, environments, repos, database schemas, API specs, integrations, runbooks | installation-wide; linked to many Projects and Topics; has Documents and Credentials |
| Requirement | A single user need: title, narrative, acceptance criteria, source (person + conversation), priority, status, version | belongs to Project or Topic, raised by Person, implemented by Tasks, traced to Decisions |
| Document | Any file or page: PDF, Word, spreadsheet, image, markdown; parsed text, embeddings, tags, version chain | attached to Project, Topic, System, Requirement, Person |
| Credential | Username/password, API key, certificate, config file, connection string; stored encrypted, never in chat | belongs to System, Project or Topic; access-scoped per Person |
| Task | Actionable item with assignee, due date, source (agent, human, mail), status, linked evidence | belongs to Project or Topic, assigned to Person, generated from Conversation / Mail / Requirement |
| Decision | A recorded choice with context, options considered, outcome, date, deciders | belongs to Project or Topic, references Requirements and Conversations |
| Conversation | A channel thread, DM, mail thread or meeting, normalized into messages with participants and timestamps | source for Requirements, Tasks, Decisions; linked to Project or Topic |
| Meeting | A calendar event with participants, agenda, notes, transcript and recording link, from any meeting provider | a kind of Conversation; linked to Project or Topic |
| Package | A generated, versioned development bundle for a Project (section 10) | derived from all of the above |
| Agent | A non-human member: playbook, model, tools, permissions, audit log | acts in Projects and Topics |

### Rules

- Project and Topic are the only top-level containers; every other entity belongs to at least one of them (a System or a Person may belong to several).
- Links are typed (`raised_by`, `implements`, `depends_on`, `supersedes`, `mentioned_in`, `spawned_from`) and bidirectional in queries.
- Every create/update is versioned with `actor` (human or agent) and `source` (chat post id, mail message id, meeting id, upload id). Nothing is overwritten silently.
- Free text on every entity is embedded for semantic search; structured fields are indexed for filters.

## 4. Functional requirements

Requirements are grouped by module. FR-1 to FR-8 map directly to the eight needs in the original brief; FR-9 and FR-10 are the glue that makes the others work.

### FR-1 Project and Topic workspaces

- **FR-1.1** Create a Project from a form or from a chat command (`/project new`). Fields: name, client, goal, scope, status, stage, dates, budget (optional), stakeholders, linked channels, parent Topic (optional).
- **FR-1.2** Each Project gets a dedicated channel group (`#proj-<slug>`, `#proj-<slug>-requirements`, `#proj-<slug>-agent`) created automatically; existing channels can be linked.
- **FR-1.3** Project home page shows: summary, people and roles, systems, open requirements, open tasks, recent decisions, documents, package status.
- **FR-1.4** Project timeline: milestones, phases and key dates editable by project members.
- **FR-1.5** Project status is derived: a project with no activity for N days is flagged "stale" to its owner.
- **FR-1.6** Projects can be archived; archived projects remain searchable and packageable.
- **FR-1.7** Create a Topic from any existing channel (`/topic here`) or new (`/topic new`): name, kind (internal or external), external organization and contacts for external topics, owner, description, linked systems and people. The channel becomes the Topic's home; its threads are the Topic's conversations.
- **FR-1.8** Topic home page shows the same panels as a Project except timeline and package: people, systems, documents, open requirements, open tasks, decisions, and for external topics the counterpart organization and its contacts.
- **FR-1.9** `/project new --from-topic` spawns a Project linked to the Topic; requirements, tasks and documents raised in the Topic can be moved or linked to the Project in one action.
- **FR-1.10** A channel that is neither a Project channel nor a Topic is plain chat; the Follow-up agent still reads it but attributes findings to a "General" container that admins can later file into a Topic.

### FR-2 People directory

- **FR-2.1** Every workspace user has a profile: role, organization, expertise tags, responsibilities, working hours, preferred contact channel, manager.
- **FR-2.2** External contacts (client staff, vendors) exist as Person records without a login; they are linked to mail addresses so inbound mail is attributed.
- **FR-2.3** Role-in-project assignments: sponsor, product owner, end user, developer, FDE, reviewer.
- **FR-2.4** "Who knows about X" search: people ranked by linked requirements, documents, decisions and conversation participation.
- **FR-2.5** Expertise and responsibilities are updated by agents from observed activity, as suggestions the person confirms.

### FR-3 Technical knowledge (Systems)

- **FR-3.1** Create a System with: description, business owner, technical owner, stack, environments (dev/test/prod with URLs), repositories, deployment method.
- **FR-3.2** Database schemas: upload DDL, ER diagrams or connect read-only and introspect; store tables, columns, keys, relationships, with free-text annotations.
- **FR-3.3** API catalog: upload OpenAPI/Swagger/WSDL/Postman collections; store endpoints, auth, request/response samples.
- **FR-3.4** Integration map: which System talks to which, by what protocol, with what data.
- **FR-3.5** Existing-application inventory: screens, modules, known issues, pain points (often collected during analysis).
- **FR-3.6** Every technical artifact is versioned; diffs between versions are viewable.
- **FR-3.7** Systems are installation-wide and are linked to many Projects and Topics; a client's ERP is described once and reused.

### FR-4 Requirements capture with the Analyst agent

- **FR-4.1** Any internal user can submit a requirement via a form, a chat message in a requirements channel, a mail, or a meeting note upload. Client users have no login in the first release: they submit through a tokenized project form link or by mail to the project address, and the analyst continues the conversation on that same channel.
- **FR-4.2** The Analyst agent responds on the channel the requirement arrived on (chat thread, mail reply or form follow-up): asks clarifying questions (who, what, why, when, acceptance criteria, exceptions), proposes a structured Requirement, and links it to the Project and the raising Person.
- **FR-4.3** Requirement record: id, title, narrative, user story form, acceptance criteria, priority (MoSCoW), status (draft, clarifying, confirmed, in development, delivered, rejected), source links, version history.
- **FR-4.4** The analyst detects duplicates and conflicts with existing requirements and flags them.
- **FR-4.5** Requirements can be grouped into epics/features and traced to Tasks, Decisions and delivered commits.
- **FR-4.6** Requirement review: a product owner confirms or rejects; confirmation posts to the project channel.
- **FR-4.7** Export requirements as Markdown, Word or a structured JSON for the package.
- **FR-4.8** Analyst sessions can be run as guided interviews (`/interview @person` for internal users, or a mail-and-form interview for an external contact) that walk through a template for the project type.

### FR-5 Document store

- **FR-5.1** Upload any file type (PDF, DOCX, XLSX, PPTX, images, markdown, code archives) to a Project, System, Requirement or Person.
- **FR-5.2** Text extraction and OCR on upload; chunked and embedded for retrieval; tables extracted where possible.
- **FR-5.3** Documents are versioned; a new upload with the same name creates a version, not a copy.
- **FR-5.4** Documents can be tagged "use as context" so agents include them in the package and in retrieval; others are searchable only.
- **FR-5.5** Documents can be marked confidential; access follows the entity's policy and is logged.
- **FR-5.6** Mail attachments and chat attachments are ingested through the same pipeline with their source link.

### FR-6 Credentials and configuration vault

- **FR-6.1** Store credentials (username/password, API keys, tokens, certificates, SSH keys) and configuration files (`.env`, connection strings, YAML) per System or Project.
- **FR-6.2** Encrypted at rest with an installation master key held outside the database; secrets are never stored in message text, embeddings or logs.
- **FR-6.3** Fine-grained access: per Person, per role, time-boxed grants; every read is audited.
- **FR-6.4** Secrets are referenced by handle (`{{secret:client-erp-db}}`) in documents and packages; the package resolves handles only for an authorized engineer at export time.
- **FR-6.5** Chat scanner: if a message or upload looks like a credential, the system offers to move it to the vault and redacts the original.
- **FR-6.6** Rotation reminders and expiry dates.

### FR-7 Development package generator

- **FR-7.1** One action (`/package build`) produces a versioned bundle for a Project (section 10 defines its contents).
- **FR-7.2** The bundle includes a generated `CLAUDE.md` and `README.md` so Claude Code can start from it without further explanation.
- **FR-7.3** Package diff: what changed since the last build (new requirements, changed schemas, new decisions).
- **FR-7.4** Package delivery: zip download is the default FDE workflow; push to a Git repository and an MCP endpoint that Claude Code can read directly are secondary options.
- **FR-7.5** Package provenance: every file lists the entities and versions it was generated from.

### FR-8 Communication integration and proactive follow-up

- **FR-8.1** Connect mailboxes per user and per shared project address; a user can connect several mailboxes (Gmail first, Microsoft 365 later, IMAP after that), all attributed to that user. Inbound mail is matched to Projects or Topics by participants, subject, thread and content.
- **FR-8.2** Calendar and meeting systems (Microsoft Teams, Google Meet, Zoom) are reached through one MeetingProvider interface (section 6). The first release ships the interface, a manual provider (upload notes, transcripts or recordings and link them to a project or topic) and a mock provider for tests; real Teams, Meet and Zoom providers are a later phase. Meetings are Conversations of kind `meeting`.
- **FR-8.3** Bridges to external chat (Microsoft Teams, Slack, WhatsApp Business where allowed) so client conversations land in the brain.
- **FR-8.4** The Follow-up agent runs continuously: it reads new Conversations, detects commitments ("I will send the schema by Friday"), questions awaiting an answer, deadlines, blockers and decisions.
- **FR-8.5** It generates Tasks with assignee, due date and evidence link, posts them to the relevant person as a proposal; the person accepts, edits or dismisses in one click.
- **FR-8.6** It escalates: a task overdue by its grace period is surfaced to the project owner in the daily digest.
- **FR-8.7** Daily and weekly digests per person and per project: what happened, what is waiting on you, what is waiting on others.
- **FR-8.8** Outbound: the agent can draft a reply mail or message, but sending requires the user's confirmation unless a policy allows auto-send for a category.

### FR-9 Search, retrieval and the brain query

- **FR-9.1** Unified search across messages, documents, entities, meetings and mail with filters by project or topic, person, type, date.
- **FR-9.2** Semantic search (vector) plus keyword (full-text) with hybrid ranking.
- **FR-9.3** "Ask the brain" chat command and side panel: natural-language questions answered with citations to the exact message, document chunk or entity version.
- **FR-9.4** Entity pages show backlinks: every conversation, document and task that references them.
- **FR-9.5** Retrieval respects access policy: a user never sees a citation they cannot open.

### FR-10 Decisions and institutional memory

- **FR-10.1** Record a Decision from a thread (`/decide`) with context, options, outcome and deciders; the agent drafts it from the thread.
- **FR-10.2** Decision log per project, per topic and installation-wide, searchable, linked to superseded decisions.
- **FR-10.3** Offboarding mode: when a Person leaves, the system lists their open tasks, owned systems, undocumented knowledge (conversations where they are the only expert) and proposes handover tasks.
- **FR-10.4** Knowledge gaps report: systems without owners, requirements without acceptance criteria, projects without decisions in the last month.

### FR-11 Built-in tasks and GitHub Issues sync

- **FR-11.1** Tasks live in the brain: list and board views per Project and Topic, a "My tasks" view per person, due dates, priority, status, comments, linked evidence. Designed for non-technical enterprise users: create a task from any message or mail with one click, no external tool required.
- **FR-11.2** Daily reminders for due and overdue tasks arrive as chat messages and in the digest (FR-8.7); a task can be reassigned or snoozed from the message.
- **FR-11.3** Agent-proposed tasks (FR-8.5) and human tasks share one model; a proposal becomes a normal task on acceptance.
- **FR-11.4** GitHub Issues sync, enabled per Project: tasks mirror to issues in the linked repository and back (title, body, assignee, state, labels); the brain stays the source of truth for links to requirements and evidence. Used by Infinics projects; enterprise installations can leave it off.
- **FR-11.5** Other trackers (Jira, Azure Boards) are out of scope for the first releases.

## 5. Agent layer

Three agents cover the brief; all are built on one shared runtime so adding a fourth is configuration, not code.

| Agent | Trigger | Reads | Writes (as proposals unless policy says otherwise) |
| --- | --- | --- | --- |
| Analyst | Message in a requirements channel, `/interview`, mail tagged as a request | Project, existing Requirements, Systems, Documents marked as context | Requirement drafts, clarifying questions, duplicate/conflict flags |
| Follow-up | New Conversation (chat, mail, meeting note), hourly sweep, daily digest schedule | All Conversations in the project, Tasks, People, deadlines | Task proposals, digests, escalation posts, draft replies |
| Packager | `/package build`, scheduled nightly for active projects, on-demand by API | Every entity of the Project, secret handles | Package bundle, package diff, provenance manifest |

### Shared agent runtime

- **Model access.** One provider abstraction with two implementations, Anthropic (Claude) and Google (Gemini), both with tool use; playbooks are provider-neutral. Provider and model are chosen per agent in the installation config; default a mid-tier model for sweeps and a top-tier model for analysis and packaging.
- **Tools.** Agents act only through a typed tool layer over the brain API: `search_brain`, `get_entity`, `propose_entity`, `propose_task`, `post_message`, `draft_mail`, `read_secret_handle` (never the secret value). Each tool call is logged with inputs and outputs.
- **Context assembly.** Retrieval-augmented: the runtime builds context from the project's entities and the top-k retrieved chunks, within a token budget, and records which chunks were used so every output can cite its sources.
- **Playbooks.** Each agent has a versioned system prompt and a set of templates stored in the database and editable by admins (for example a requirement-interview template for ERP projects).
- **Proposal protocol.** Agent writes land as `proposed` with the agent as actor. A human accepts, edits or dismisses from the chat message or the entity page. Accepted proposals become normal entities; dismissed ones are kept for learning but hidden.
- **Memory.** Agents have per-project working memory (summaries of long threads, open questions) stored as entities of type `AgentNote`, visible to humans.
- **Guardrails.** Agents cannot: read secret values, send outbound mail without confirmation, delete entities, or act outside their project or topic scope. Rate limits and a monthly cost budget for the installation with alerts.
- **Evaluation.** A golden set of threads and expected tasks/requirements per installation; a regression run on every playbook change reports precision and recall of proposals.
- **MCP server.** The brain exposes an MCP server so Claude Code (and other MCP clients) can query the brain directly during development: `brain.search`, `brain.get_project`, `brain.get_requirements`, `brain.get_system_schema`, `brain.log_decision`.

## 6. Integrations

All integrations go through one **connector framework**: a connector declares its auth (OAuth2, API key, IMAP credentials), its sync mode (webhook, polling, both), the entity types it produces, and a mapping from external ids to brain ids. Connectors are configured once per installation; user-level connectors (a personal mailbox, a personal calendar) are per user with the user's consent.

| Integration | Direction | Produces | Priority |
| --- | --- | --- | --- |
| Google Workspace: Gmail, Calendar (several mailboxes per user) | In + draft out | Conversations, Documents (attachments), calendar events, People | P0 (Phase 4; Infinics' own mail) |
| Microsoft 365 (Graph): mail, calendar | In + draft out | Conversations, Documents, calendar events, People | P1 (Phase 5; most Turkish enterprise clients) |
| Generic IMAP/SMTP | In + draft out | Conversations | P2 |
| Meeting systems via the MeetingProvider interface: manual and mock providers | In + create | Meetings (notes, transcripts, recordings) as Conversations of kind `meeting` | P0 for the interface, manual and mock providers |
| Real meeting providers, in this order: Microsoft Teams, then Google Meet, then Zoom | In + create | Meetings pulled from the provider; meetings created from the brain | P1 Teams (Phase 5), P2 Google Meet, P3 Zoom; none in the first release |
| Git (GitHub, GitLab, Azure DevOps) | In + package push | Repos linked to Systems, commits traced to Requirements, package delivery (secondary to zip) | P0 |
| GitHub Issues (per-project toggle, FR-11.4) | Two-way for Tasks | Tasks mirrored to issues for Infinics projects; brain remains source of truth | P1 (Phase 4) |
| Slack / Teams chat bridge | In | Client conversations as Conversations in a Topic or Project | P1 |
| WhatsApp Business API | In | Client conversations where the client works there | P2 |
| Database introspection (PostgreSQL, SQL Server, Oracle, MySQL; read-only) | In | System schema snapshots | P1 |
| Claude Code | Out | Package via zip (default), Git push or MCP server | P0 |
| Webhooks and public REST API | Both | Anything, for client-specific systems | P1 |
| Jira, Azure Boards and other trackers | – | Not planned; the built-in task system covers enterprise users | – |

### MeetingProvider interface

All meeting systems are hidden behind one interface so the brain, the agents and the UI never depend on a vendor. The first release implements only `manual` and `mock`; `teams`, `google_meet` and `zoom` are registered as provider names with a "not implemented" status visible in the connector settings, to be built in that order: Teams first, then Google Meet, then Zoom. Creating meetings from the brain is part of the interface, so `createMeeting` is required, not optional.

```ts
interface MeetingProvider {
  id: 'manual' | 'mock' | 'teams' | 'google_meet' | 'zoom';
  capabilities(): { listMeetings: boolean; transcript: boolean; recording: boolean; webhook: boolean; create: boolean };
  listMeetings(range: { from: Date; to: Date }, user?: PersonId): Promise<MeetingRef[]>;
  getMeeting(ref: MeetingRef): Promise<Meeting>;                     // title, time, participants, agenda, join link
  getTranscript(ref: MeetingRef): Promise<Transcript | null>;        // speaker-labelled segments with timestamps
  getRecording(ref: MeetingRef): Promise<RecordingLink | null>;
  subscribe(callback: (event: MeetingEvent) => void): Promise<void>; // created, started, ended, transcript ready
  createMeeting(input: NewMeeting): Promise<MeetingRef>;             // title, time, participants, agenda, container; manual = record + mail invite only
  cancelMeeting(ref: MeetingRef): Promise<void>;
}
```

- `manual`: a user uploads notes, a transcript file or a recording, or pastes a join link and summary, and links the meeting to a Project or Topic; `createMeeting` makes the Meeting record and sends a calendar invite through the user's mail connector, with no video link. This is the only way meetings enter the brain in the first release.
- `mock`: returns fixture meetings and transcripts for tests and demos.
- Calendar events from the mail connectors (Gmail first, M365 later) create Meeting records with provider `manual`; the user attaches notes afterwards.
- `/meeting new` in a project or topic channel calls `createMeeting` on the installation's default provider; once Teams is live the same command produces a Teams meeting.
- The Follow-up agent treats a Meeting like any Conversation: commitments, decisions and open questions in the transcript or notes become proposals.

### Ingestion rules

- Every ingested item keeps its external id, source URL and raw payload so it can be re-processed when classifiers improve.
- Project matching uses, in order: explicit tag or channel, participant mapping (Person to Project), thread continuity, then a classifier over content; low-confidence matches are queued for a human to confirm.
- Duplicate suppression: the same mail arriving through two mailboxes is one Conversation with two sources.
- Sync health is visible per connector: last sync, items processed, failures, re-auth needed.

## 7. Security, permissions and audit

The brain holds client credentials and client data, so security is a release gate, not a later phase.

- **Installation isolation.** One instance, one database and one key set per customer; no shared infrastructure between customers. The Infinics instance holds Infinics data only.
- **Roles.** Admin, project or topic owner, member, guest (reserved for a later release; client users have no login at first), agent. Permissions are per entity type and per container; defaults are deny.
- **Guests.** No client logins in the first release. Client users interact through tokenized, expiring per-project form links and mail to the project address; a later release may add guest accounts scoped to a Project or an external Topic.
- **Secrets.** Built in-app, no external vault product: envelope encryption with a data key wrapped by an installation master key kept in a sealed key file or the host's KMS; secret values are decrypted only in the vault service, never returned to agents, logs or search. Handles are what travel.
- **Audit.** Append-only audit log of reads and writes on Credentials, Documents marked confidential, and all agent actions, with actor, time, IP and purpose; exportable.
- **Data residency.** Deployable on-premises or in a region the customer chooses; no customer data leaves the installation except model API calls, which are configurable per installation (provider, region, allowed data classes).
- **Model-call privacy.** Secrets and documents marked `no-ai` are never sent to a model; PII redaction before model calls is an installation option.
- **Authentication.** SSO (SAML/OIDC, Microsoft Entra, Google), MFA enforced for admins and anyone with vault access, session and API-token management.
- **Retention.** Retention policies for conversations, mail and meetings; legal hold; right-to-erasure for a Person while preserving project history.
- **Compliance targets.** KVKK (Turkey) and GDPR by design; SOC 2-style controls documented for enterprise sales.

## 8. Non-functional requirements

| Id | Requirement | Target |
| --- | --- | --- |
| NFR-1 | Search latency | Hybrid search p95 under 1.5 s for an installation with 1 M messages and 50 k document chunks |
| NFR-2 | Ingestion lag | Mail and chat available in the brain within 2 minutes of arrival |
| NFR-3 | Agent response | Analyst first reply in a thread within 20 s; follow-up sweep hourly, digest by 08:00 local |
| NFR-4 | Package build | Under 2 minutes for a project with 500 requirements and 200 documents |
| NFR-5 | Scale | 2,000 users, 100 active projects and 300 topics on one installation without architectural change |
| NFR-6 | Availability | Single-node install on the customer's infrastructure, installed and operated by Infinics; 99.5% monthly target |
| NFR-7 | Cost control | Model spend per month capped and reported; retrieval before generation to keep prompts small |
| NFR-8 | Observability | Traces for every agent run (prompt, retrieved chunks, tool calls, output, cost); dashboards for sync health and queue depth |
| NFR-9 | Portability | Full installation export (entities, links, documents, audit) in an open format; no lock-in |
| NFR-10 | Localization | English only in the first release; all UI strings in a catalog and a per-user language setting so Turkish can be added later |
| NFR-11 | Testability | Every FR has at least one automated test; agent playbooks have golden-set regression runs |
| NFR-12 | Installability | A new customer installation from a clean machine with one documented command set (containers plus a config file) in under one hour |

## 9. Data model and API surface

The schema below is a starting point; the Claude Code session should adapt names to the clone's existing conventions and keep the messaging tables untouched.

```sql
-- Core (single installation: no tenant column anywhere)
containers(id, kind, title, status, owner_id, channel_id, data jsonb, created_by, created_at, updated_at)
  -- kind in ('project','topic'); a project row may carry spawned_from (a topic id) in data
entities(id, type, title, status, owner_id, container_id, data jsonb, created_by, created_at, updated_at)
  -- type in ('person','system','requirement','document','credential_ref','task','decision','conversation','meeting','package','agent','agent_note')
  -- container_id is the primary container; extra containers (a System used by several projects) are links
entity_versions(id, entity_id, version, data jsonb, actor_id, actor_kind, source_kind, source_ref, created_at)
links(id, from_id, to_id, kind, data jsonb, created_by, created_at)
  -- kind in ('belongs_to','raised_by','implements','depends_on','supersedes','mentioned_in','owns','member_of','attached_to','spawned_from')

-- Retrieval
chunks(id, entity_id, container_id, ordinal, text, embedding vector(1536), tokens, metadata jsonb)
-- full-text index on chunks.text; vector index on chunks.embedding

-- Ingestion
sources(id, connector_id, external_id, kind, raw jsonb, received_at, processed_at, entity_id null, container_id null, confidence, review_state)
connectors(id, user_id null, provider, auth_ref, config jsonb, last_sync_at, health)
meeting_providers(id, name, status, config jsonb)   -- 'manual','mock' implemented; 'teams','google_meet','zoom' registered as not_implemented

-- Vault (separate schema or service)
secrets(id, handle, scope_entity_id, kind, ciphertext, key_version, expires_at, rotated_at)
secret_grants(id, secret_id, person_id, role null, valid_from, valid_to)
secret_access_log(id, secret_id, person_id, agent_id null, action, purpose, at, ip)

-- Agents
agent_playbooks(id, agent_kind, version, system_prompt, templates jsonb, model, active)
agent_runs(id, agent_kind, trigger, container_id, input_refs jsonb, retrieved_chunk_ids jsonb, tool_calls jsonb, output jsonb, cost_usd, started_at, ended_at, status)
proposals(id, run_id, entity_type, payload jsonb, state, decided_by, decided_at)

-- Audit
audit_log(id, actor_id, actor_kind, action, entity_id, details jsonb, ip, at)
```

### API surface (REST, `/api/v1/brain/...`, plus the MCP server)

| Area | Endpoints |
| --- | --- |
| Containers | `GET /containers?kind=project` |
| Projects | `POST /projects` (creates channels), `POST /projects/from-topic/{topicId}`, `GET /projects/{id}/timeline` |
| Topics | `POST /topics` (new or from an existing channel), `PATCH /topics/{id}`, `POST /topics/{id}/move-items` (requirements, tasks, documents into a project) |
| Entities | `GET/POST /entities`, `GET/PATCH /entities/{id}`, `GET /entities/{id}/versions`, `GET /entities/{id}/backlinks` |
| Links | `POST /links`, `DELETE /links/{id}`, `GET /entities/{id}/links?kind=` |
| Requirements | `POST /containers/{id}/requirements`, `POST /requirements/{id}/confirm`, `GET /containers/{id}/requirements/export?format=md` |
| Documents | `POST /documents` (multipart), `GET /documents/{id}/text`, `GET /documents/{id}/versions` |
| Meetings | `GET /meetings?container=&from=&to=`, `POST /meetings/import` (manual provider: notes, transcript, recording), `GET /meeting-providers` (status per provider) |
| Vault | `POST /secrets`, `GET /secrets/{handle}/meta`, `POST /secrets/{handle}/reveal` (audited, MFA), `POST /secrets/{handle}/grants` |
| Search | `GET /search?q=&container=&type=&from=&to=`, `POST /ask` (question, scope) returns answer + citations |
| Agents | `POST /agents/{kind}/run`, `GET /runs/{id}`, `POST /proposals/{id}/accept` |
| Packages | `POST /projects/{id}/package`, `GET /packages/{id}`, `GET /packages/{id}/download`, `GET /packages/{id}/diff?against=` |
| Connectors | `POST /connectors`, `POST /connectors/{id}/sync`, `GET /connectors/{id}/health`, `POST /webhooks/{provider}` |
| Chat commands | `/project`, `/topic`, `/req`, `/interview`, `/decide`, `/task`, `/meeting`, `/package`, `/ask`, `/secret` mapped to the endpoints above |

Events (internal bus, also exposed as outbound webhooks): `entity.created`, `entity.updated`, `conversation.ingested`, `proposal.created`, `proposal.decided`, `package.built`, `secret.accessed`, `connector.failed`.

## 10. Development package specification

The package is the product of the dev-company mode: a forward deployed engineer opens it in Claude Code and continues development with full context and no re-briefing. It is generated, versioned and reproducible.

```
<project-slug>-package-v<N>/
  CLAUDE.md                     # how to work in this project: conventions, do/don't, where things are
  README.md                     # project summary, client, goal, current stage, who is who
  PACKAGE_MANIFEST.json         # version, build time, entity ids + versions each file came from
  CHANGELOG.md                  # what changed since v<N-1> (new/changed requirements, schemas, decisions)
  project/
    overview.md                 # scope, milestones, constraints, success criteria
    people.md                   # stakeholders, roles, contact channels, decision rights
    decisions.md                # decision log, newest first, with rationale
    open-questions.md           # unanswered questions the analyst collected
  requirements/
    index.md                    # table: id, title, priority, status, epic
    REQ-001.md ...              # one file per requirement: story, acceptance criteria, source links
    requirements.json           # machine-readable export
  systems/
    <system-slug>/
      overview.md               # stack, environments, owners, repos, deployment
      schema.sql | schema.md    # database schema with annotations
      api/openapi.yaml          # API specs as collected
      integrations.md           # what it talks to
      known-issues.md
  documents/
    <files marked "use as context">, plus extracted-text .md next to each binary
  config/
    env.template                # every variable with description; values as {{secret:handle}}
    secrets.handles.json        # handles + scope + who can resolve; never values
  tasks/
    backlog.md                  # open tasks for the engineer, linked to requirements
  .claude/
    settings.json               # suggested Claude Code settings, allowed tools
    commands/                   # slash commands: /req, /decide, /sync-brain (write back to the brain via MCP)
    mcp.json                    # brain MCP server connection for this project
```

### Build rules

1. Only confirmed Requirements and current entity versions are included; drafts go to `open-questions.md`.
2. `CLAUDE.md` is generated from an installation template plus project facts: naming conventions, branch strategy, how to record a decision back into the brain, which files are authoritative.
3. Secret handles are resolved only when the engineer runs `brain package resolve` locally with vault access; the downloadable zip never contains values.
4. Every generated Markdown file ends with a provenance footer listing source entity ids and versions.
5. A package can be pushed to a Git repository branch `brain/package-v<N>` so the engineer merges it into the working repo.
6. Write-back: the `/sync-brain` command in Claude Code posts new decisions, completed tasks and discovered schema changes back to the brain through the MCP server, closing the loop.
7. A Project spawned from a Topic includes the Topic's decisions and context documents in `project/background.md`; a Topic itself can be packaged (`/package build --topic`) as a context bundle without the development scaffolding.

### Acceptance test

A new engineer with no prior contact with the project opens the package in Claude Code, runs `claude`, asks "what should I build next and why", and gets a correct answer citing requirements and decisions, within five minutes of download.

## 11. Roadmap

Six phases, each ending at a gate that is demonstrated in the running app on a real Infinics project. Durations are indicative for one engineer working with Claude Code full time; adjust after Phase 0.

*Figure: "Six gated phases; the package gate in phase 3 must never regress" (roadmap, 6 phases, 6 gates).* 0 Foundation (weeks 1–3: projects, topics, entity model, audit, API, search; gate: clean install test passes, new entities searchable in 5 s). 1 Project and topic memory (weeks 4–6: projects, people, systems, documents, FR-1, 2, 3, 5; gate: one real client project fully described, expert search correct). 2 Analyst (weeks 7–9: agent runtime, proposals, requirements, decisions, /ask; gate: guest interview done, 10 reqs confirmed, duplicates flagged). 3 Vault and package (weeks 10–12: encrypted vault, package builder, MCP server; gate: 5-minute new-engineer test, no secret value in any export). 4 Communications (weeks 13–17: Gmail, GitHub Issues, meeting stubs, follow-up, digests; gate: task proposals 70% precision, 60% recall, daily digest by 08:00). 5 Enterprise (weeks 18–22: SSO, retention, M365 mail, Teams meetings, on-prem; gate: first enterprise installation live with SSO, M365 mail and Teams).

Each diamond is a gate demonstrated in the running app; the phase 3 gate (a new engineer productive from the package in five minutes) is re-run at the end of every later phase.

| Phase | Weeks | Scope (requirement ids) | Deliverables | Gate (acceptance criteria) |
| --- | --- | --- | --- | --- |
| 0 Foundation | 1–3 | Container (Project, Topic) and entity/link/version model, audit log, brain API, hybrid search, model-provider abstraction (Anthropic, Gemini), clean-install script (FR-9.1, 9.2, 9.4; NFR-1, 9, 12) | Migrations, `/api/v1/brain`, container and entity pages in the UI, search box, install guide | Clean install from scratch passes its test; any entity is searchable within 5 s of creation |
| 1 Project and topic memory | 4–6 | FR-1, FR-2, FR-3, FR-5, FR-11.1–11.3 | Project home, Topic from a channel, people directory, systems with schema/API upload, document pipeline with extraction and embeddings, built-in task lists and boards | One real Infinics client project and one internal topic fully described; "who knows about X" returns correct people; a non-technical user creates and completes a task without help |
| 2 Analyst | 7–9 | Agent runtime, proposal protocol, FR-4, FR-10.1–10.2, FR-9.3 | Analyst agent in requirements channels, project form links, `/interview`, `/decide`, `/ask` with citations | A client completes a mail-and-form interview without a login; 10 requirements confirmed with acceptance criteria; duplicates flagged |
| 3 Vault and package | 10–12 | FR-6, FR-7, MCP server | In-app encrypted vault with grants and audit, `/package build`, zip download (default) + Git push, `brain` MCP server, `/sync-brain` | Section 10 acceptance test passes with a new engineer from a zip; no secret value appears in any export or log |
| 4 Communications | 13–17 | Connector framework, Gmail + Google Calendar with several mailboxes per user, Git + GitHub Issues sync (FR-11.4), MeetingProvider interface with manual and mock providers, FR-8 | Mail and calendar ingestion, manual meeting import and `/meeting new`, container matching queue, Follow-up agent, task proposals, daily digest, draft replies | On a two-week golden set, task proposals reach 70% precision and 60% recall; a manually imported transcript yields correct task proposals; digest delivered daily by 08:00; a task closed in GitHub closes in the brain |
| 5 Enterprise | 18–22 | SSO, retention, residency, Microsoft 365 mail and calendar, Slack/Teams chat bridge, FR-10.3–10.4, eval harness, on-prem packaging; real Teams meeting provider (Google Meet next, Zoom last) | Enterprise installation template, M365 connector, Teams meetings read and created from the brain, offboarding and knowledge-gap reports, playbook regression runs, install guide | First external enterprise installation live with SSO, M365 mailbox connector and Teams meetings |

### Sequencing rules

- Phase 0 and 1 are prerequisites for everything; do not start agents on an unstructured store.
- Vault (Phase 3) precedes mail ingestion (Phase 4) so that credentials arriving by mail are caught by the scanner from day one. Real meeting providers are built only after the manual provider has proven what the agents need from a transcript.
- Each phase ships behind a feature flag in the installation config; Infinics' own installation is always on the newest phase.
- Run the Section 10 acceptance test again at the end of every later phase; the package must never regress.

## 12. Instructions for the Claude Code session

Paste the block below as the first message of the session, after the spec is in the repository.

```
You are continuing development of our Mattermost clone for Infinics. Read
docs/COMPANY_BRAIN_SPEC.md in full before doing anything. Section 13 lists
decisions that are final; do not reopen them.

Context you must keep in mind:
- The system is installed separately for each customer. There is NO multi-
tenant layer: no tenant table, no tenant_id column, no cross-customer code
paths.
- The two top-level containers are Project and Topic. A Topic is a channel
(internal or external) that someone promoted with /topic here; other channels
stay plain chat. Everything else belongs to a Project or a Topic.
- Client users have no login in the first release. They work through
tokenized project form links and mail to the project address.
- Models: build one provider abstraction with Anthropic (Claude) and Google
(Gemini) implementations; provider and model are chosen per agent in the
installation config.
- Mail: Gmail first, several mailboxes per user, Microsoft 365 later. Tasks:
built-in task system first (simple for non-technical users), GitHub Issues
two-way sync as a per-project toggle. Package: zip download is the default.
Vault: in-app, master key, no external vault product. Language: English only,
strings in a catalog.
- Meeting systems are reached only through the MeetingProvider interface.
Implement the interface (including createMeeting), the `manual` and `mock`
providers, and register teams, google_meet and zoom as not_implemented in
that order. Do not build real Teams/Meet/Zoom integrations unless I ask.

Step 1 — Codebase audit (no code changes). Produce docs/brain/00-gap-
analysis.md:
- Stack, database, auth, storage, job/queue system, search capability and
existing entity model of the clone.
- Map existing tables/models to the entities in spec section 3; list what can
be reused, what must be added. Confirm how channels can be promoted to
Topics.
- Confirm whether the database supports vector search (pgvector or
equivalent); if not, propose the least invasive option.
- Identify where to hook: message create pipeline, file upload pipeline,
slash commands, side panels, bot/webhook accounts.
- List risks and anything in the spec that conflicts with the current
architecture. Stop and ask before resolving conflicts.

Step 2 — Phase 0 plan. Produce docs/brain/01-phase0-plan.md with migrations,
API routes, UI entry points, tests, the clean-install script, and a task list
referencing FR/NFR ids. Wait for approval.

Step 3 — Implement phase by phase as in spec section 11. Rules:
- Never modify core messaging tables; extend through new tables and links.
- Every change references an FR/NFR id in the commit message.
- Every FR gets an automated test; agents get a golden-set test fixture under
tests/brain/golden/.
- Feature-flag every brain feature in the installation config.
- Secrets: no plaintext secret may appear in code, fixtures, logs or test
output; add a CI check for it.
- Keep docs/brain/CHANGELOG.md updated per phase, and regenerate
docs/brain/API.md from the routes.
- At the end of each phase, run the gate from section 11 and write the result
to docs/brain/gates/phase-N.md.

Ask me when: a decision affects the data model or the container model, an
external dependency is needed, or a gate cannot be met as written.
```

### Files the session should create

| File | Purpose |
| --- | --- |
| `docs/COMPANY_BRAIN_SPEC.md` | This document |
| `docs/brain/00-gap-analysis.md` | Audit of the clone against the spec |
| `docs/brain/01-phase0-plan.md` … `06-phase5-plan.md` | Per-phase implementation plans |
| `docs/brain/API.md` | Generated API reference |
| `docs/brain/CHANGELOG.md` | Per-phase changes |
| `docs/brain/gates/phase-N.md` | Gate run results |
| `tests/brain/golden/` | Golden-set conversations and expected proposals |
| `CLAUDE.md` (updated) | Pointer to the spec and the brain conventions |

## 13. Decisions (settled 12 Oct 2026)

These answers are final for the first release and are already applied throughout the spec.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Hosting | Simplest model: one installation per customer on the customer's own infrastructure (or Infinics' cloud for the Infinics instance), installed and operated by Infinics. No hosted multi-instance fleet. |
| 2 | Model provider | Provider abstraction with two implementations: Anthropic (Claude) and Google (Gemini). Provider and model are chosen per agent in the installation config. |
| 3 | Mailbox platform | Gmail first (Phase 4), Microsoft 365 second (Phase 5), IMAP after. A user can connect several mailboxes; mail from any of them is attributed to that user. |
| 4 | Client users | No logins for clients in the first release. They submit requirements and answer the analyst through per-project form links and mail to the project address. |
| 5 | Package delivery | Zip download is the default FDE workflow; Git push and MCP live access are secondary. |
| 6 | Vault | Built in-app: envelope encryption with an installation master key; no external vault product. |
| 7 | Task system | The brain's built-in task system is the primary one and must be simple enough for non-technical enterprise users. Infinics projects additionally sync two-way with GitHub Issues (FR-11). Jira and other trackers are not planned. |
| 8 | Topics | Only channels someone explicitly promotes with `/topic here` become Topics; other channels stay plain chat under the "General" container (FR-1.10). |
| 9 | Meeting providers | Build order after the manual and mock providers: Microsoft Teams, then Google Meet, then Zoom. The brain can also create meetings, so `createMeeting` is part of the interface. |
| 10 | Language | English only in the first release; string catalog kept so Turkish can be added later. |
