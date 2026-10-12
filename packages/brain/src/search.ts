// Hybrid search (FR-9.1, FR-9.2, FR-9.5): the top keyword hits and the top vector hits over the chunks a scope
// allows, fused by reciprocal rank, one result per entity. The scope and chunk-level filters sit in the WHERE of
// both halves, so the GIN and HNSW indexes serve them; entity-level filters apply to the fused candidates.
import type { Queryable } from '@brain/shared';
import type { Citation, EntityType, Scope, SearchFilters, SearchParams, SearchResult } from './types.ts';

const CANDIDATES = 60;
const RRF_K = 60;
/** A vector index returns its k nearest whatever the query; beyond this cosine distance a hit is noise. */
const DEFAULT_MAX_DISTANCE = 0.5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_CHARS = 300;

/** Collects parameters and hands out their placeholders. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The WHERE fragment that keeps only chunks the scope may see (table alias `c`). */
export function scopeSql(scope: Scope, params: Params): string {
  switch (scope.kind) {
    case 'all':
      return 'TRUE';
    case 'person': {
      const channels = params.add(scope.channelIds);
      const containers = params.add(scope.containerIds);
      return `(c.visibility = 'public' OR (c.visibility = 'members' AND c.channel_id = ANY(${channels}::text[])) OR (c.visibility = 'container' AND c.container_id = ANY(${containers}::text[])))`;
    }
    case 'channel': {
      // D35: the asking channel itself, active public channels, public entities without a channel, the channel's container.
      const channel = params.add(scope.channelId);
      const container = params.add(scope.containerId ?? '');
      return `(c.channel_id = ${channel} OR (c.visibility = 'public' AND (c.channel_id IS NULL OR EXISTS (SELECT 1 FROM brain.channels ch WHERE ch.channel_id = c.channel_id AND ch.active))) OR c.container_id = ${container})`;
    }
  }
}

function chunkFilterSql(filters: SearchFilters | undefined, params: Params): string {
  const clauses: string[] = [];
  if (filters?.containerId) clauses.push(`c.container_id = ${params.add(filters.containerId)}`);
  if (filters?.types && filters.types.length > 0) clauses.push(`c.entity_type = ANY(${params.add(filters.types)}::text[])`);
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

function entityFilterSql(filters: SearchFilters | undefined, params: Params): string {
  const clauses: string[] = [];
  if (!filters?.includeArchived) clauses.push('e.archived_at IS NULL');
  if (filters?.from) clauses.push(`e.updated_at >= ${params.add(filters.from)}`);
  if (filters?.to) clauses.push(`e.updated_at <= ${params.add(filters.to)}`);
  if (filters?.personId) {
    const person = params.add(filters.personId);
    clauses.push(`(e.owner_id = ${person} OR c.metadata->'authors' @> jsonb_build_array(jsonb_build_object('id', ${person}::text)))`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : 'TRUE';
}

/**
 * The query's lexemes, stemmed once. Chunks holding all of them are ranked first; only when none does, chunks
 * holding any of them (D34: questions rarely repeat a text's exact phrasing). Ranking every chunk that holds any
 * common word costs seconds at 250 k chunks, so the any-term half runs only as the fallback (D61).
 */
const LEXEMES = `array(SELECT quote_literal(lexeme) FROM unnest(tsvector_to_array(to_tsvector('english', $QUERY))) AS lexeme)`;
const tsquery = (operator: '&' | '|'): string => `to_tsquery('simple', array_to_string(${LEXEMES}, ' ${operator} '))`;

interface Row {
  chunk_id: string;
  entity_id: string;
  entity_type: EntityType;
  title: string;
  container_id: string;
  channel_id: string | null;
  version: number;
  updated_at: Date;
  text: string;
  metadata: Record<string, unknown>;
  score: string;
  keyword: boolean;
  semantic: boolean;
  headline: string | null;
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((x) => (Number.isFinite(x) ? x.toString() : '0')).join(',')}]`;
}

function citationOf(row: Row): Citation {
  const metadata = row.metadata;
  const anchors = Array.isArray(metadata.anchors) ? (metadata.anchors as { postId?: string; eventId?: string; url?: string }[]) : [];
  const first = anchors.find((anchor) => anchor.postId) ?? anchors[0];
  if (row.entity_type === 'conversation') {
    const url = (first?.url ?? metadata.source_url) as string | undefined;
    return { kind: 'post', ...(url ? { url } : {}), ...(first?.postId ? { postId: first.postId } : {}), ...(first?.eventId ? { eventId: first.eventId } : {}) };
  }
  return { kind: 'entity' };
}

export async function hybridSearch(db: Queryable, input: SearchParams): Promise<SearchResult[]> {
  const params = new Params();
  const query = params.add(input.query);
  const allTerms = tsquery('&').replace('$QUERY', query);
  const anyTerm = tsquery('|').replace('$QUERY', query);
  const scope = scopeSql(input.scope, params);
  const chunkFilters = chunkFilterSql(input.filters, params);
  const candidates = params.add(CANDIDATES);
  const vectorHalf = input.embedding
    ? `SELECT id, entity_id, distance FROM (
         SELECT c.id, c.entity_id, (c.embedding <=> ${params.add(toVectorLiteral(input.embedding))}::vector) AS distance
         FROM brain.chunks c
         WHERE c.embedding IS NOT NULL AND ${scope}${chunkFilters}
         ORDER BY distance
         LIMIT ${candidates}
       ) nearest WHERE distance <= ${params.add(input.maxDistance ?? DEFAULT_MAX_DISTANCE)}`
    : `SELECT NULL::text AS id, NULL::text AS entity_id, 0::float8 AS distance WHERE FALSE`;
  const entityFilters = entityFilterSql(input.filters, params);
  const limit = params.add(Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sql = `
    WITH q AS (SELECT ${allTerms} AS all_terms, ${anyTerm} AS any_term),
    kw_all AS (
      SELECT c.id, c.entity_id, ts_rank_cd(c.search, q.all_terms) AS rank
      FROM brain.chunks c, q
      WHERE c.search @@ q.all_terms AND ${scope}${chunkFilters}
      ORDER BY rank DESC
      LIMIT ${candidates}
    ),
    kw_any AS (
      SELECT c.id, c.entity_id, ts_rank_cd(c.search, q.any_term) AS rank
      FROM brain.chunks c, q
      WHERE NOT EXISTS (SELECT 1 FROM kw_all) AND c.search @@ q.any_term AND ${scope}${chunkFilters}
      ORDER BY rank DESC
      LIMIT ${candidates}
    ),
    kw AS (SELECT id, entity_id, rank FROM kw_all UNION ALL SELECT id, entity_id, rank FROM kw_any),
    kwr AS (SELECT id, entity_id, row_number() OVER (ORDER BY rank DESC) AS r FROM kw),
    vec AS (${vectorHalf}),
    vecr AS (SELECT id, entity_id, row_number() OVER (ORDER BY distance) AS r FROM vec),
    fused AS (
      SELECT id, entity_id, sum(1.0 / (${RRF_K} + r)) AS score, bool_or(src = 'keyword') AS keyword, bool_or(src = 'semantic') AS semantic
      FROM (SELECT id, entity_id, r, 'keyword' AS src FROM kwr UNION ALL SELECT id, entity_id, r, 'semantic' AS src FROM vecr) u
      GROUP BY id, entity_id
    ),
    best AS (SELECT DISTINCT ON (entity_id) id, entity_id, score, keyword, semantic FROM fused ORDER BY entity_id, score DESC)
    SELECT b.id AS chunk_id, e.id AS entity_id, e.type AS entity_type, e.title, e.container_id, e.channel_id, e.version, e.updated_at,
           c.text, c.metadata, b.score::text AS score, b.keyword, b.semantic,
           CASE WHEN b.keyword THEN ts_headline('english', c.text, q.any_term, 'StartSel="",StopSel="",MaxFragments=2,MaxWords=40,MinWords=15,FragmentDelimiter=" … "') END AS headline
    FROM best b
    JOIN brain.chunks c ON c.id = b.id
    JOIN brain.entities e ON e.id = b.entity_id
    CROSS JOIN q
    WHERE ${entityFilters}
    ORDER BY b.score DESC, e.updated_at DESC
    LIMIT ${limit}`;
  const result = await db.query<Row>(sql, params.values);
  return result.rows.map((row) => {
    const snippet = (row.headline && row.headline.trim()) || row.text.slice(0, SNIPPET_CHARS).trim();
    const docId = typeof row.metadata.doc_id === 'string' ? row.metadata.doc_id : row.chunk_id;
    const matched: ('keyword' | 'semantic')[] = [];
    if (row.keyword) matched.push('keyword');
    if (row.semantic) matched.push('semantic');
    return {
      entityId: row.entity_id,
      entityType: row.entity_type,
      title: row.title,
      containerId: row.container_id,
      channelId: row.channel_id,
      version: row.version,
      updatedAt: row.updated_at,
      chunkId: row.chunk_id,
      docId,
      snippet,
      text: row.text,
      score: Number(row.score),
      matched,
      citation: citationOf(row),
      metadata: row.metadata,
    };
  });
}
