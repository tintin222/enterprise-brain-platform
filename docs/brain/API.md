# Enterprise Brain API

Generated from the routes by `pnpm brain:api-docs`; do not edit by hand. Version 0.1.0.

The Company Brain (docs/COMPANY_BRAIN_SPEC.md). Sign in with a Mattermost account (cookie) or send `Authorization: Bearer <BRAIN_API_TOKEN>`.

Errors are `{ "error": "<message>", "code": "<code>" }`; validation errors add `issues`.

## Contents

- [Session](#session)
- [Containers](#containers)
- [Entities](#entities)
- [Search](#search)
- [Audit](#audit)
- [Export](#export)
- [Agents](#agents)
- [Setup](#setup)
- [Mattermost](#mattermost)
- [People](#people)
- [Projects](#projects)
- [Topics](#topics)
- [Documents](#documents)
- [Systems](#systems)
- [Tasks](#tasks)

## Session

Who is calling and which features are on

### `GET /api/v1/brain/me`

The caller and the features on this installation

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `principal` | object | yes |
| `features` | object | yes |
| `publicUrl` | string | yes |
| `chatUrl` | string | yes |
| `timezone` | string | yes |

Response 401:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `GET /api/v1/brain/features`

Feature flags (no sign-in needed)

Response 200: Default Response

### `GET /api/v1/brain/me/channels`

The caller's open and private channels (for the forms that link or promote a channel)

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `channels` | array of object | yes |

## Containers

Projects, Topics and General (spec section 3)

### `GET /api/v1/brain/containers`

List Projects and Topics

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `kind` | query | `project` \| `topic` \| `general` | no |
| `status` | query | `active` \| `archived` | no |
| `q` | query | string | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `containers` | array of object | yes |

### `POST /api/v1/brain/containers`

Create a Project or a Topic, optionally linking a channel

Body:

| Field | Type | Required |
| --- | --- | --- |
| `kind` | `project` \| `topic` | yes |
| `title` | string | yes |
| `slug` | string | no |
| `ownerId` | string | no |
| `data` | object | no |
| `channel` | object | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `channel` | object | no |

### `GET /api/v1/brain/containers/{id}`

One container with its channels and entity counts

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `channels` | array of object | yes |
| `counts` | object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/containers/{id}`

Change a container (a new version)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | no |
| `ownerId` | string \| null | no |
| `data` | object | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |

### `POST /api/v1/brain/containers/{id}/archive`

Archive a container (it stays searchable, FR-1.6)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |

### `GET /api/v1/brain/containers/{id}/entities`

A container's entities the caller may see

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `type` | query | `person` \| `system` \| `requirement` \| `document` \| `credential_ref` \| `task` \| `decision` \| `conversation` \| `meeting` \| `package` \| `agent` \| `agent_note` | no |
| `status` | query | string | no |
| `includeArchived` | query | `true` \| `false` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entities` | array of object | yes |

### `POST /api/v1/brain/containers/{id}/channels`

Link a Mattermost channel: its threads become the container's conversations (D50, D57)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `mmChannelId` | string | yes |
| `role` | `home` \| `requirements` \| `agent` \| `linked` | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `channel` | object | yes |

### `DELETE /api/v1/brain/containers/{id}/channels/{mmChannelId}`

Unlink a channel (its conversations go back to General)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `mmChannelId` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `removed` | boolean | yes |

### `GET /api/v1/brain/containers/{id}/home`

A Project's or Topic's home: summary, people, systems, requirements, tasks, decisions, documents, conversations, timeline (FR-1.3, FR-1.8)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `owner` | object \| null | yes |
| `channels` | array of object | yes |
| `people` | array of object | yes |
| `systems` | array of object | yes |
| `requirements` | object | yes |
| `tasks` | object | yes |
| `decisions` | array of object | yes |
| `documents` | array of object | yes |
| `conversations` | array of object | yes |
| `milestones` | array of object | yes |
| `package` | object | yes |
| `stale` | boolean | yes |
| `spawnedFrom` | object \| null | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/containers/{id}/timeline`

Replace a Project's milestones and phases (FR-1.4; members)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `milestones` | array of object | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |

## Entities

Entities, versions and links

### `GET /api/v1/brain/entities`

List entities the caller may see

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `type` | query | `person` \| `system` \| `requirement` \| `document` \| `credential_ref` \| `task` \| `decision` \| `conversation` \| `meeting` \| `package` \| `agent` \| `agent_note` | no |
| `container` | query | string | no |
| `status` | query | string | no |
| `owner` | query | string | no |
| `q` | query | string | no |
| `includeArchived` | query | `true` \| `false` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entities` | array of object | yes |

### `POST /api/v1/brain/entities`

Create an entity (version 1, indexed at once)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `type` | `person` \| `system` \| `requirement` \| `document` \| `credential_ref` \| `task` \| `decision` \| `conversation` \| `meeting` \| `package` \| `agent` \| `agent_note` | yes |
| `title` | string | yes |
| `status` | string | no |
| `ownerId` | string | no |
| `containerId` | string | yes |
| `externalKey` | string | no |
| `visibility` | `public` \| `members` \| `container` | no |
| `data` | object | no |
| `text` | string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `entity` | object | yes |

### `GET /api/v1/brain/entities/{id}`

One entity

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entity` | object | yes |
| `container` | object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/entities/{id}`

Change an entity (a new version; unchanged fields stay)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | no |
| `status` | string | no |
| `ownerId` | string \| null | no |
| `containerId` | string | no |
| `visibility` | `public` \| `members` \| `container` | no |
| `data` | object | no |
| `text` | string | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entity` | object | yes |

### `POST /api/v1/brain/entities/{id}/archive`

Archive an entity (people only; agents cannot)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entity` | object | yes |

### `GET /api/v1/brain/entities/{id}/versions`

Every version of an entity, newest first

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `versions` | array of object | yes |

### `GET /api/v1/brain/entities/{id}/versions/{n}`

One version of an entity

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `n` | path | integer | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `version` | object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `GET /api/v1/brain/entities/{id}/links`

Links from and to an entity

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `kind` | query | `belongs_to` \| `raised_by` \| `implements` \| `depends_on` \| `supersedes` \| `mentioned_in` \| `owns` \| `member_of` \| `attached_to` \| `spawned_from` | no |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `outgoing` | array of object | yes |
| `incoming` | array of object | yes |

### `GET /api/v1/brain/entities/{id}/backlinks`

What points at an entity: incoming links and texts that name it (FR-9.4)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `links` | array of object | yes |
| `mentions` | array of object | yes |

### `POST /api/v1/brain/links`

Link two entities (or an entity and a container)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `fromId` | string | yes |
| `toId` | string | yes |
| `kind` | `belongs_to` \| `raised_by` \| `implements` \| `depends_on` \| `supersedes` \| `mentioned_in` \| `owns` \| `member_of` \| `attached_to` \| `spawned_from` | yes |
| `data` | object | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `link` | object | yes |

### `DELETE /api/v1/brain/links/{id}`

Remove a link

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | integer | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `removed` | boolean | yes |

### `GET /api/v1/brain/entities/{id}/versions/{a}/diff/{b}`

What changed between two versions: text lines and data fields (FR-3.6)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `a` | path | integer | yes |
| `b` | path | integer | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `from` | number | yes |
| `to` | number | yes |
| `title` | object \| null | yes |
| `fields` | array of object | yes |
| `text` | object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

## Search

Hybrid search (FR-9.1, FR-9.2)

### `GET /api/v1/brain/search`

Hybrid search over everything the caller may see, with citations and facets

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `q` | query | string | yes |
| `container` | query | string | no |
| `type` | query | string | no |
| `person` | query | string | no |
| `from` | query | string | no |
| `to` | query | string | no |
| `includeArchived` | query | `true` \| `false` | no |
| `limit` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `results` | array of object | yes |
| `semantic` | boolean | yes |
| `tookMs` | number | yes |
| `facets` | object | yes |

## Audit

The append-only audit log

### `GET /api/v1/brain/audit`

Audit entries (administrators)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `entity` | query | string | no |
| `container` | query | string | no |
| `actor` | query | string | no |
| `from` | query | string | no |
| `to` | query | string | no |
| `limit` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `entries` | array of object | yes |

## Export

Full export in an open format (NFR-9)

### `GET /api/v1/brain/export/manifest`

What an export contains: tables with row counts, the uploaded files

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `format` | string | yes |
| `generatedAt` | string | yes |
| `tables` | object | yes |
| `files` | array of string | yes |
| `uploads` | object | yes |

### `GET /api/v1/brain/export/files/{id}`

One uploaded file by its id (administrators; audited)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200: Default Response

### `GET /api/v1/brain/export/files.jsonl`

The uploaded files' metadata as JSON Lines (administrators)

Response 200: Default Response

### `GET /api/v1/brain/export/{file}`

One table as JSON Lines (administrators); chunks without embeddings unless ?embeddings=true

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `embeddings` | query | `true` \| `false` | no |
| `file` | path | string | yes |

Response 200: Default Response

## Agents

Agents and channels (the former admin API, D43)

### `GET /api/v1/brain/agents`

Agents (without keys or tokens)

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `agents` | array of object | yes |

### `POST /api/v1/brain/agents`

Create or update an agent (bot, token, relay identity, registry record)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `handle` | string | yes |
| `name` | string | yes |
| `provider` | `anthropic` \| `google` \| `echo` | no |
| `model` | string | no |
| `instructions` | string | no |
| `description` | string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `agent` | object | yes |

### `POST /api/v1/brain/channels/{id}/enable`

Add @brain to a channel so it is captured (D5)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 202:

| Field | Type | Required |
| --- | --- | --- |
| `channelId` | string | yes |
| `enabled` | boolean | yes |
| `note` | string | yes |

### `POST /api/v1/brain/channels/{id}/agents`

Add an agent's bot to a channel

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `handle` | string | yes |

Response 202:

| Field | Type | Required |
| --- | --- | --- |
| `channelId` | string | yes |
| `agent` | string | yes |

### `DELETE /api/v1/brain/channels/{id}/agents/{handle}`

Remove an agent's bot from a channel

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `handle` | path | string | yes |

Response 202:

| Field | Type | Required |
| --- | --- | --- |
| `channelId` | string | yes |
| `agent` | string | yes |
| `removed` | boolean | yes |

## Setup

Mattermost integration setup

### `POST /api/v1/brain/setup/mattermost`

Register the brain with Mattermost: allow-list, OAuth app, /brain command (idempotent)

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `allowedHost` | string | yes |
| `oauthClientId` | string | yes |
| `commands` | array of object | yes |

## Mattermost

Callbacks Mattermost makes for slash commands, dialogs and buttons

### `POST /mm/commands/{trigger}`

A slash command (/brain, /project, /topic; form body from Mattermost)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `trigger` | path | `brain` \| `project` \| `topic` \| `task` | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `token` | string | yes |
| `team_id` | string | yes |
| `team_domain` | string | no |
| `channel_id` | string | yes |
| `channel_name` | string | no |
| `user_id` | string | yes |
| `user_name` | string | no |
| `command` | string | yes |
| `text` | string | no |
| `trigger_id` | string | no |
| `response_url` | string | no |
| `root_id` | string | no |

Response 200: Default Response

### `POST /mm/dialogs/{name}`

A dialog submission (JSON from Mattermost)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `name` | path | `link` \| `project` \| `topic` \| `task` \| `task-reassign` | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `type` | `dialog_submission` | no |
| `callback_id` | string | no |
| `state` | string | no |
| `user_id` | string | yes |
| `channel_id` | string | yes |
| `team_id` | string | yes |
| `submission` | object | no |
| `cancelled` | boolean | no |

Response 200: Default Response

### `POST /mm/actions/{name}`

A button on a post (JSON from Mattermost); the context carries a signed state

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `name` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `user_id` | string | yes |
| `channel_id` | string | yes |
| `team_id` | string | yes |
| `post_id` | string | yes |
| `trigger_id` | string | no |
| `type` | string | no |
| `context` | object | no |

Response 200: Default Response

## People

### `GET /api/v1/brain/people`

The people directory (everyone signed in)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `q` | query | string | no |
| `external` | query | `true` \| `false` | no |
| `includeInactive` | query | `true` \| `false` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `people` | array of object | yes |

### `POST /api/v1/brain/people`

An external contact without an account (FR-2.2)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `name` | string | yes |
| `emails` | array of string | no |
| `organisation` | string | no |
| `role` | string | no |
| `notes` | string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `person` | object | yes |

### `POST /api/v1/brain/people/sync`

Create or refresh a person for every chat account now (administrators; the daily job does the same)

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `seen` | number | yes |
| `people` | number | yes |

### `GET /api/v1/brain/people/search`

Who knows about X: people ranked by the evidence that links them to what matches (FR-2.4)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `q` | query | string | yes |
| `limit` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `people` | array of object | yes |
| `semantic` | boolean | yes |

### `GET /api/v1/brain/people/{id}`

One person with their roles in projects and topics

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `person` | object | yes |
| `memberships` | array of object | yes |
| `suggestions` | array of object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/people/{id}`

Edit a profile (the person themselves, or an administrator; external contacts: anyone signed in)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `role` | string | no |
| `organisation` | string | no |
| `expertise` | array of string | no |
| `responsibilities` | array of string | no |
| `workingHours` | string | no |
| `preferredChannel` | string | no |
| `managerId` | string \| null | no |
| `name` | string | no |
| `emails` | array of string | no |
| `notes` | string | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `person` | object | yes |

### `POST /api/v1/brain/people/{id}/suggestions/{n}/{decision}`

Confirm or dismiss a suggested expertise or responsibility (FR-2.5)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `n` | path | integer | yes |
| `decision` | path | `confirm` \| `dismiss` | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `person` | object | yes |

### `GET /api/v1/brain/containers/{id}/members`

A container's people and their roles

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `members` | array of object | yes |

### `POST /api/v1/brain/containers/{id}/members`

Give a person a role in a Project or Topic (members of the container, administrators)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `personId` | string | yes |
| `role` | `sponsor` \| `product_owner` \| `end_user` \| `developer` \| `fde` \| `reviewer` \| `member` \| `contact` | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `link` | object | yes |

### `DELETE /api/v1/brain/containers/{id}/members/{personId}`

Remove a person's role in a container

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `personId` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `removed` | boolean | yes |

## Projects

### `POST /api/v1/brain/projects`

Create a Project with its channel group (FR-1.1, FR-1.2)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | yes |
| `client` | string | no |
| `goal` | string | no |
| `scope` | string | no |
| `stage` | string | no |
| `startsOn` | string | no |
| `endsOn` | string | no |
| `budget` | string | no |
| `stakeholderIds` | array of string | no |
| `parentTopicId` | string | no |
| `channels` | boolean | no |
| `private` | boolean | no |
| `linkChannelIds` | array of string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `channels` | array of object | yes |

### `POST /api/v1/brain/projects/from-topic/{topicId}`

Spawn a Project from a Topic: its people and systems come along (FR-1.9)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `topicId` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | yes |
| `client` | string | no |
| `goal` | string | no |
| `scope` | string | no |
| `stage` | string | no |
| `startsOn` | string | no |
| `endsOn` | string | no |
| `budget` | string | no |
| `stakeholderIds` | array of string | no |
| `channels` | boolean | no |
| `private` | boolean | no |
| `linkChannelIds` | array of string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `channels` | array of object | yes |

## Topics

### `POST /api/v1/brain/topics`

Create a Topic from an existing channel or with a new one (FR-1.7)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | yes |
| `kind` | `internal` \| `external` | no |
| `organisation` | string | no |
| `description` | string | no |
| `ownerId` | string | no |
| `contactIds` | array of string | no |
| `systemIds` | array of string | no |
| `channel` | object \| object | yes |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `container` | object | yes |
| `channel` | object | yes |

### `POST /api/v1/brain/topics/{id}/move-items`

Move or link a Topic's requirements, tasks, documents and decisions into a Project (FR-1.9)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `projectId` | string | yes |
| `entityIds` | array of string | yes |
| `mode` | `move` \| `link` | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `moved` | array of string | yes |
| `linked` | array of string | yes |
| `skipped` | array of string | yes |

## Documents

### `POST /api/v1/brain/documents`

Upload a file to a container or an entity (multipart: file, attachTo, useAsContext, confidential, noAi, artifact, title, description)

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `document` | object | yes |
| `created` | boolean | yes |

### `GET /api/v1/brain/documents`

Documents the caller may see, newest first

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `container` | query | string | no |
| `attachedTo` | query | string | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `documents` | array of object | yes |

### `GET /api/v1/brain/documents/{id}/text`

A document's extracted text (confidential reads are audited)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `text` | string | yes |
| `extracted` | object | yes |

### `GET /api/v1/brain/documents/{id}/file`

Download the file (audited)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200: Default Response

### `PATCH /api/v1/brain/documents/{id}`

Change the flags: use as context, confidential, no-ai, allowed people, artifact kind (FR-5.4, FR-5.5)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `useAsContext` | boolean | no |
| `confidential` | boolean | no |
| `noAi` | boolean | no |
| `allowedPersonIds` | array of string | no |
| `artifact` | `ddl` \| `er_diagram` \| `openapi` \| `wsdl` \| `postman` \| `other` | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `document` | object | yes |

### `POST /api/v1/brain/documents/{id}/extract`

Extract the text again now

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `extracted` | object | yes |

## Systems

### `GET /api/v1/brain/systems`

Every system (installation-wide, FR-3.7)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `q` | query | string | no |
| `container` | query | string | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `systems` | array of object | yes |

### `POST /api/v1/brain/systems`

Create a system (FR-3.1), optionally linked to Projects and Topics

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | yes |
| `description` | string | no |
| `businessOwnerId` | string | no |
| `technicalOwnerId` | string | no |
| `stack` | array of string | no |
| `environments` | array of object | no |
| `repositories` | array of string | no |
| `deployment` | string | no |
| `containerIds` | array of string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `system` | object | yes |

### `GET /api/v1/brain/systems/{id}`

A system with its artifacts, integrations and the containers that use it

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `system` | object | yes |
| `artifacts` | array of object | yes |
| `integrations` | array of object | yes |
| `containers` | array of object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/systems/{id}`

Edit a system: description, owners, stack, environments, repositories, deployment, inventory (FR-3.1, FR-3.5)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `description` | string | no |
| `businessOwnerId` | string | no |
| `technicalOwnerId` | string | no |
| `stack` | array of string | no |
| `environments` | array of object | no |
| `repositories` | array of string | no |
| `deployment` | string | no |
| `title` | string | no |
| `inventory` | object | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `system` | object | yes |

### `POST /api/v1/brain/systems/{id}/containers`

Use the system in a Project or Topic (FR-3.7)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `containerId` | string | yes |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `link` | object | yes |

### `DELETE /api/v1/brain/systems/{id}/containers/{containerId}`

Stop using the system in a container

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `containerId` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `removed` | boolean | yes |

### `POST /api/v1/brain/systems/{id}/integrations`

Record that this system talks to another: protocol, data, direction (FR-3.4)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `toSystemId` | string | yes |
| `protocol` | string | no |
| `payload` | string | no |
| `direction` | `calls` \| `is_called_by` \| `both` | no |
| `notes` | string | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `link` | object | yes |

## Tasks

### `GET /api/v1/brain/containers/{id}/tasks`

A container's tasks, open first, soonest due first

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `state` | query | `open` \| `in_progress` \| `done` \| `dismissed` | no |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `tasks` | array of object | yes |

### `GET /api/v1/brain/tasks/mine`

The caller's tasks across projects and topics, proposals included

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `includeClosed` | query | `true` \| `false` | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `tasks` | array of object | yes |

### `POST /api/v1/brain/tasks`

Create a task (one step: a title; everything else has a default)

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | yes |
| `containerId` | string | no |
| `text` | string | no |
| `assigneeId` | string | no |
| `dueAt` | string | no |
| `priority` | `low` \| `normal` \| `high` | no |
| `evidence` | array of object | no |

Response 201:

| Field | Type | Required |
| --- | --- | --- |
| `task` | object | yes |

### `GET /api/v1/brain/tasks/{id}`

One task

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `task` | object | yes |

Response 404:

| Field | Type | Required |
| --- | --- | --- |
| `error` | string | yes |
| `code` | string | no |

### `PATCH /api/v1/brain/tasks/{id}`

Change a task: title, text, assignee, due date, priority, state, snooze

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `title` | string | no |
| `text` | string | no |
| `assigneeId` | string \| null | no |
| `dueAt` | string \| null | no |
| `priority` | `low` \| `normal` \| `high` | no |
| `state` | `open` \| `in_progress` \| `done` \| `dismissed` | no |
| `snoozedUntil` | string \| null | no |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `task` | object | yes |

### `POST /api/v1/brain/tasks/{id}/comments`

Comment on a task

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |

Body:

| Field | Type | Required |
| --- | --- | --- |
| `text` | string | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `task` | object | yes |

### `POST /api/v1/brain/tasks/{id}/{decision}`

Decide an agent's proposal: accept, edit (with changes) or dismiss (FR-11.3)

| Parameter | In | Type | Required |
| --- | --- | --- | --- |
| `id` | path | string | yes |
| `decision` | path | `accept` \| `edit` \| `dismiss` | yes |

Response 200:

| Field | Type | Required |
| --- | --- | --- |
| `task` | object | yes |
