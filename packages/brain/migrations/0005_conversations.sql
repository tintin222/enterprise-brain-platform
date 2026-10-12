-- The local brain's thread documents (D34) become conversation entities and chunks in General. A document id is
-- 'thread:<relay channel>:<root event>' or, for a chunk of a long thread, that plus ':<n>'.
WITH threads AS (
  SELECT regexp_replace(d.id, ':[0-9]{1,4}$', '') AS external_key,
         d.channel_id,
         min(d.text)                              AS first_text,
         string_agg(d.text, E'\n' ORDER BY d.id)  AS full_text,
         max(d.channel_name)                      AS channel_name,
         max(d.source_url)                        AS source_url,
         min(d.first_at)                          AS first_at,
         max(d.last_at)                           AS last_at,
         min(d.created_at)                        AS created_at,
         max(d.updated_at)                        AS updated_at
  FROM brain.documents d
  GROUP BY 1, 2
)
INSERT INTO brain.entities (type, title, status, container_id, external_key, channel_id, visibility, data, text, version, source_kind, created_by, created_at, updated_at)
SELECT 'conversation',
       left(split_part(t.first_text, E'\n', 1), 120),
       'active',
       'general',
       t.external_key,
       t.channel_id,
       CASE WHEN c.visibility = 'open' THEN 'public' ELSE 'members' END,
       jsonb_strip_nulls(jsonb_build_object('channel_name', t.channel_name, 'source_url', t.source_url, 'first_at', t.first_at, 'last_at', t.last_at)),
       t.full_text,
       1,
       'migration',
       'system',
       t.created_at,
       t.updated_at
FROM threads t
LEFT JOIN brain.channels c ON c.channel_id = t.channel_id;

INSERT INTO brain.entity_versions (entity_id, version, title, status, owner_id, container_id, visibility, data, text, actor_id, actor_kind, source_kind, source_ref, created_at)
SELECT e.id, 1, e.title, e.status, e.owner_id, e.container_id, e.visibility, e.data, e.text, 'system', 'system', 'migration', NULL, e.created_at
FROM brain.entities e
WHERE e.type = 'conversation' AND e.source_kind = 'migration';

INSERT INTO brain.chunks (id, entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, metadata, updated_at)
SELECT e.id || ':' || COALESCE(substring(d.id FROM ':([0-9]{1,4})$')::int, 0),
       e.id,
       'conversation',
       e.container_id,
       e.channel_id,
       e.visibility,
       COALESCE(substring(d.id FROM ':([0-9]{1,4})$')::int, 0),
       d.text,
       jsonb_strip_nulls(jsonb_build_object('doc_id', d.id, 'authors', d.authors, 'event_ids', to_jsonb(d.event_ids), 'first_at', d.first_at, 'last_at', d.last_at, 'source_url', d.source_url)),
       d.updated_at
FROM brain.documents d
JOIN brain.entities e ON e.external_key = regexp_replace(d.id, ':[0-9]{1,4}$', '');

DROP TABLE brain.documents;
