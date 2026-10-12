# Export format (NFR-9)

The brain exports everything it holds in an open, documented format, so an installation never depends on this software to keep its knowledge. Administrators and the service token may export; every export is audited (`export` action).

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/brain/export/manifest` | `{ format: "jsonl/1", generatedAt, tables: { <table>: <rows> }, files: [...] }` |
| `GET /api/v1/brain/export/<table>.jsonl` | The table as JSON Lines (`application/x-ndjson`): one JSON object per row, keys as the columns below |
| `GET /api/v1/brain/export/chunks.jsonl?embeddings=true` | Chunks with their vectors (`embedding` as a `[…]` string); without the flag vectors are left out |

Tables, in the order they should be imported: `containers`, `channel_links`, `entities`, `entity_versions`, `links`, `chunks`, `audit_log`, `events`, `channels`.

## Columns

Times are ISO-8601 with time zone. Ids are opaque text.

- `containers`: `id, kind (project|topic|general), slug, title, status, owner_id, channel_id (Mattermost id), data (JSON), version, created_by, created_at, updated_at`
- `channel_links`: `mm_channel_id, relay_channel_id, container_id, role (home|requirements|agent|linked), created_by, created_at`
- `entities`: `id, type, title, status, owner_id, container_id, external_key, channel_id (relay id for conversations), visibility (public|members|container), data (JSON), text, version, source_kind, source_ref, created_by, created_at, updated_at, archived_at`
- `entity_versions`: the entity's fields as they were at `version`, plus `actor_id, actor_kind (person|agent|system), source_kind, source_ref, created_at`
- `links`: `id, from_id, to_id, kind, data, created_by, created_at`
- `chunks`: `id (<entity id>:<ordinal>), entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, tokens, metadata (JSON: doc_id, authors, event_ids, anchors with post ids and permalinks, source_url), embedding_model, embedded_at, updated_at` (+ `embedding` on request)
- `audit_log`: `id, at, actor_id, actor_kind, action, entity_id, container_id, details (JSON), ip, request_id`
- `events`: `id, name, payload (JSON), created_at, delivered_at`
- `channels`: the relay-side channel facts ingestion keeps: `channel_id, name, visibility (open|private), active, updated_at`

Phase 1 adds documents' files to the export (as files next to the JSON Lines), and `pnpm brain:export <dir>` writes the whole set to a directory with a verification round trip.
