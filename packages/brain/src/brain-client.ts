// BrainClient over the knowledge store: what agents search and ingestion fills (docs/agents-and-ingestion.md A.6).
// Thread documents become conversation entities with one chunk per document (plan section 6); retrieval for an
// agent keeps the D35 scope (the asking channel, active public channels, the channel's container) and is hybrid
// when an embedding provider is configured (D53).
import type { EmbeddingProvider } from '@brain/models';
import { errorFields, threadDocId, type BrainChannel, type BrainClient, type BrainDocument, type BrainSearchInput, type Logger, type Pool, type RetrievedPassage } from '@brain/shared';
import { approximateTokens } from './chunker.ts';
import { BrainStore } from './store.ts';
import { GENERAL_CONTAINER_ID, type ChunkInput, type Entity, type SearchResult, type WriteContext } from './types.ts';

/** Passages longer than this are returned as the search snippet instead of the whole chunk. */
const PASSAGE_CHARS = 2000;
const TITLE_CHARS = 120;
const INGESTION: WriteContext = { actor: { kind: 'system', id: 'ingestion' }, source: { kind: 'chat' } };

export interface PostgresBrainClientOptions {
  embeddings?: EmbeddingProvider | undefined;
  log?: Logger;
}

/** `thread:<channel>:<root>` and the chunk ordinal of a thread document id (`:<n>` suffix; none means 0). */
export function splitDocId(docId: string): { base: string; ordinal: number | undefined } {
  const match = /^(thread:[^:]+:[0-9a-f]{64}):(\d{1,4})$/.exec(docId);
  return match ? { base: match[1]!, ordinal: Number(match[2]) } : { base: docId, ordinal: undefined };
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const withoutAuthor = line.replace(/^[^:\n]{1,64}: /, '');
  return (withoutAuthor || line).slice(0, TITLE_CHARS) || 'Conversation';
}

export class PostgresBrainClient implements BrainClient {
  readonly store: BrainStore;
  readonly #embeddings: EmbeddingProvider | undefined;
  readonly #log: Logger | undefined;

  constructor(pool: Pool, options: PostgresBrainClientOptions = {}) {
    this.store = new BrainStore(pool);
    this.#embeddings = options.embeddings;
    this.#log = options.log;
  }

  /** Create or upgrade the brain tables. */
  init(): Promise<void> {
    return this.store.init();
  }

  async #embedQuery(query: string): Promise<number[] | undefined> {
    if (!this.#embeddings) return undefined;
    try {
      return (await this.#embeddings.embed([query], 'query'))[0];
    } catch (error) {
      this.#log?.warn(errorFields(error), 'Query embedding failed; searching by keywords only');
      return undefined;
    }
  }

  async search(input: BrainSearchInput): Promise<RetrievedPassage[]> {
    const link = await this.store.channelLinkByRelay(input.channelId);
    const results = await this.store.search({
      query: input.query,
      embedding: await this.#embedQuery(input.query),
      ...(this.#embeddings ? { maxDistance: this.#embeddings.relevanceDistance } : {}),
      scope: { kind: 'channel', channelId: input.channelId, ...(link ? { containerId: link.containerId } : {}) },
      limit: input.limit,
    });
    return results.map(toPassage);
  }

  /** Thread documents, grouped by thread, become one conversation entity each with a chunk per document. */
  async upsertDocuments(docs: BrainDocument[]): Promise<void> {
    const threads = new Map<string, BrainDocument[]>();
    for (const doc of docs) {
      const { base } = splitDocId(doc.id);
      const list = threads.get(base) ?? [];
      list.push(doc);
      threads.set(base, list);
    }
    for (const [base, list] of threads) {
      const sorted = [...list].sort((a, b) => (splitDocId(a.id).ordinal ?? 0) - (splitDocId(b.id).ordinal ?? 0));
      const first = sorted[0]!;
      const [facts, link] = await Promise.all([this.store.channelFacts(first.channelId), this.store.channelLinkByRelay(first.channelId)]);
      const authors = [...new Map(sorted.flatMap((doc) => doc.authors).map((author) => [author.id, author])).values()];
      const firstAt = new Date(Math.min(...sorted.map((doc) => doc.firstAt.getTime())));
      const lastAt = new Date(Math.max(...sorted.map((doc) => doc.lastAt.getTime())));
      const chunks: ChunkInput[] = sorted.map((doc) => ({
        ordinal: splitDocId(doc.id).ordinal ?? 0,
        text: doc.text,
        tokens: approximateTokens(doc.text),
        metadata: {
          doc_id: doc.id,
          authors: doc.authors,
          event_ids: doc.eventIds,
          first_at: doc.firstAt.toISOString(),
          last_at: doc.lastAt.toISOString(),
          ...(doc.sourceUrl ? { source_url: doc.sourceUrl } : {}),
          ...(doc.anchors ? { anchors: doc.anchors.map((anchor) => ({ eventId: anchor.eventId, author: anchor.author, at: anchor.at.toISOString(), ...(anchor.postId ? { postId: anchor.postId } : {}), ...(anchor.url ? { url: anchor.url } : {}) })) } : {}),
          ...(doc.files && doc.files.length > 0 ? { files: doc.files } : {}),
        },
      }));
      const { entity, changed } = await this.store.upsertEntityByExternalKey(
        {
          type: 'conversation',
          title: firstLine(first.text),
          containerId: link?.containerId ?? GENERAL_CONTAINER_ID,
          externalKey: base,
          channelId: first.channelId,
          visibility: facts?.visibility === 'open' ? 'public' : 'members',
          data: {
            channel_name: first.channelName,
            authors,
            first_at: firstAt.toISOString(),
            last_at: lastAt.toISOString(),
            messages: sorted.reduce((n, doc) => n + doc.eventIds.length, 0),
            ...(first.sourceUrl ? { source_url: first.sourceUrl } : {}),
            ...(link ? { mm_channel_id: link.mmChannelId } : {}),
          },
          text: sorted.map((doc) => doc.text).join('\n'),
          chunks,
        },
        { ...INGESTION, source: { kind: 'chat', ref: base } },
      );
      if (changed) await this.store.appendEvent('conversation.ingested', { entityId: entity.id, containerId: entity.containerId, channelId: entity.channelId, chunks: chunks.length });
    }
  }

  /** A whole-thread id archives the conversation; a chunk id removes that chunk (and archives a chunkless thread). */
  async deleteDocuments(ids: string[]): Promise<void> {
    const touched = new Map<string, Entity>();
    for (const id of ids) {
      const { base, ordinal } = splitDocId(id);
      const entity = touched.get(base) ?? (await this.store.getEntityByExternalKey(base));
      if (!entity) continue;
      touched.set(base, entity);
      if (ordinal === undefined) await this.store.archiveEntity(entity.id, INGESTION);
      else await this.store.deleteChunk(`${entity.id}:${ordinal}`);
    }
    for (const entity of touched.values()) {
      if (entity.archivedAt === null && (await this.store.chunksOf(entity.id)).length === 0) await this.store.archiveEntity(entity.id, INGESTION);
    }
  }

  /** Channel facts for access decisions (D36); a visibility change follows through to the channel's conversations. */
  async upsertChannels(channels: BrainChannel[]): Promise<void> {
    for (const channel of channels) {
      await this.store.pool.query(
        `INSERT INTO brain.channels (channel_id, name, visibility, active) VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id) DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility, active = EXCLUDED.active, updated_at = now()`,
        [channel.channelId, channel.name, channel.visibility, channel.active],
      );
      const visibility = channel.visibility === 'open' ? 'public' : 'members';
      await this.store.pool.query(`UPDATE brain.entities SET visibility = $2, updated_at = now() WHERE type = 'conversation' AND channel_id = $1 AND visibility <> $2`, [channel.channelId, visibility]);
      await this.store.pool.query(`UPDATE brain.chunks SET visibility = $2 WHERE entity_type = 'conversation' AND channel_id = $1 AND visibility <> $2`, [channel.channelId, visibility]);
    }
  }

  /** One thread document by its ingestion id (tests and tools). */
  async getDocument(id: string): Promise<(BrainDocument & { updatedAt: Date }) | undefined> {
    const { base, ordinal } = splitDocId(id);
    const entity = await this.store.getEntityByExternalKey(base);
    if (!entity || entity.archivedAt !== null) return undefined;
    const chunk = (await this.store.chunksOf(entity.id)).find((candidate) => candidate.ordinal === (ordinal ?? 0));
    if (!chunk) return undefined;
    const meta = chunk.metadata as { authors?: { id: string; name: string }[]; event_ids?: string[]; first_at?: string; last_at?: string; source_url?: string };
    return {
      id,
      text: chunk.text,
      channelId: entity.channelId ?? '',
      channelName: typeof entity.data.channel_name === 'string' ? entity.data.channel_name : '',
      authors: meta.authors ?? [],
      firstAt: new Date(meta.first_at ?? entity.createdAt.toISOString()),
      lastAt: new Date(meta.last_at ?? entity.updatedAt.toISOString()),
      sourceUrl: meta.source_url,
      eventIds: meta.event_ids ?? [],
      updatedAt: entity.updatedAt,
    };
  }

  /** Ids of every thread document of a channel (tests and tools). */
  async documentIds(channelId: string): Promise<string[]> {
    const r = await this.store.pool.query<{ doc_id: string }>(
      `SELECT c.metadata->>'doc_id' AS doc_id FROM brain.chunks c JOIN brain.entities e ON e.id = c.entity_id
       WHERE e.type = 'conversation' AND e.channel_id = $1 AND e.archived_at IS NULL ORDER BY 1`,
      [channelId],
    );
    return r.rows.map((row) => row.doc_id);
  }
}

export function toPassage(result: SearchResult): RetrievedPassage {
  const channelName = typeof result.metadata.channel_name === 'string' ? result.metadata.channel_name : undefined;
  const title = result.entityType === 'conversation' ? `${channelName ?? result.title}, ${result.updatedAt.toISOString().slice(0, 10)}` : result.title;
  return {
    id: result.docId,
    text: result.text.length <= PASSAGE_CHARS ? result.text : result.snippet,
    title,
    ...(result.citation.url ? { sourceUrl: result.citation.url } : {}),
    ...(result.channelId ? { channelId: result.channelId } : {}),
    score: result.score,
  };
}

export { threadDocId };
