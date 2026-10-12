# Export format (NFR-9)

The brain exports everything it holds in an open, documented format, so an installation never depends on this software to keep its knowledge. Administrators and the service token may export; every export is audited (`export` action).

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/brain/export/manifest` | `{ format: "jsonl/2", generatedAt, tables: { <table>: <rows> }, files: [...], uploads: { count, bytes } }` |
| `GET /api/v1/brain/export/<table>.jsonl` | The table as JSON Lines (`application/x-ndjson`): one JSON object per row, keys as the columns below |
| `GET /api/v1/brain/export/chunks.jsonl?embeddings=true` | Chunks with their vectors (`embedding` as a `[…]` string); without the flag vectors are left out |
| `GET /api/v1/brain/export/files.jsonl` | The uploaded files' metadata: `id, sha256, size, media_type, created_by, created_at` |
| `GET /api/v1/brain/export/files/<id>` | One uploaded file, byte for byte, with its media type |

`pnpm brain:export <dir>` writes all of it to a directory: `manifest.json`, one `.jsonl` per table (chunks with their vectors), `files.jsonl` and `files/<id>`. `pnpm brain:export <dir> --verify` then imports the directory into a temporary database on the same server, compares every table's count, every entity's version and title, and every file's hash with the export, prints the report and drops the database (exit code 1 on any difference). The import itself is `importFromDirectory(pool, dir)` in `packages/brain`, usable on any empty brain schema whose migrations have run.

Tables, in the order they should be imported: `containers`, `channel_links`, `entities`, `entity_versions`, `links`, `chunks`, `audit_log`, `events`, `channels`, then `files`.

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
- `files`: the uploaded files (D63): `id, sha256, size, media_type, created_by, created_at`, the bytes in `files/<id>`; document entities reference them through `data.fileId`

Not exported: `settings` (the installation's own Mattermost registration), `jobs` (run bookkeeping), `lexeme_stats` (derived from the chunks, rebuilt by a job).
