// The local brain (D34): BrainClient over our state database, schema "brain", with Postgres full-text
// search standing in for the brain's retrieval until a brain API exists (Q3). Access is decided at query
// time (B.3, D35): a search from channel X sees X itself and every active open channel, never another
// private channel, because the answer is posted where everyone in X can read it.
import path from 'node:path';
import type { BrainChannel, BrainClient, BrainDocument, BrainSearchInput, RetrievedPassage } from './brain.ts';
import { migrate, withTransaction, type Pool } from './db.ts';

export const BRAIN_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations/brain');

/** Passages longer than this are returned as the fragments around the matching words. */
const PASSAGE_CHARS = 2000;

interface SearchRow {
  id: string;
  channel_id: string;
  channel_name: string;
  source_url: string | null;
  last_at: Date;
  passage: string;
  score: number;
}

export class PostgresBrainClient implements BrainClient {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Create or upgrade the brain tables. */
  async init(): Promise<void> {
    await migrate(this.#pool, 'brain', BRAIN_MIGRATIONS_DIR);
  }

  async search(input: BrainSearchInput): Promise<RetrievedPassage[]> {
    // Any word may match (OR), ranked by cover density: questions rarely repeat a thread's exact phrasing.
    // The query's own lexemes are stemmed once ('english') and then matched as they are ('simple').
    const r = await this.#pool.query<SearchRow>(
      `WITH q AS (
         SELECT to_tsquery('simple', array_to_string(array(
           SELECT quote_literal(lexeme) FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lexeme
         ), ' | ')) AS query
       )
       SELECT d.id, d.channel_id, d.channel_name, d.source_url, d.last_at,
              CASE WHEN length(d.text) <= $4 THEN d.text
                   ELSE ts_headline('english', d.text, q.query, 'StartSel="",StopSel="",MaxFragments=4,MaxWords=60,MinWords=20,FragmentDelimiter=" … "')
              END AS passage,
              ts_rank_cd(d.search, q.query) AS score
       FROM brain.documents d
       CROSS JOIN q
       LEFT JOIN brain.channels c ON c.channel_id = d.channel_id
       WHERE d.search @@ q.query
         AND (d.channel_id = $2 OR (c.visibility = 'open' AND c.active))
       ORDER BY score DESC, d.last_at DESC
       LIMIT $3`,
      [input.query, input.channelId, input.limit, PASSAGE_CHARS],
    );
    return r.rows.map((row) => ({
      id: row.id,
      text: row.passage,
      title: `${row.channel_name}, ${row.last_at.toISOString().slice(0, 10)}`,
      ...(row.source_url ? { sourceUrl: row.source_url } : {}),
      channelId: row.channel_id,
      score: Number(row.score),
    }));
  }

  async upsertDocuments(docs: BrainDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await withTransaction(this.#pool, async (tx) => {
      for (const doc of docs) {
        await tx.query(
          `INSERT INTO brain.documents (id, channel_id, channel_name, text, authors, first_at, last_at, source_url, event_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             channel_id = EXCLUDED.channel_id, channel_name = EXCLUDED.channel_name, text = EXCLUDED.text,
             authors = EXCLUDED.authors, first_at = EXCLUDED.first_at, last_at = EXCLUDED.last_at,
             source_url = EXCLUDED.source_url, event_ids = EXCLUDED.event_ids, updated_at = now()`,
          [doc.id, doc.channelId, doc.channelName, doc.text, JSON.stringify(doc.authors), doc.firstAt, doc.lastAt, doc.sourceUrl ?? null, doc.eventIds],
        );
      }
    });
  }

  async deleteDocuments(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.#pool.query('DELETE FROM brain.documents WHERE id = ANY($1)', [ids]);
  }

  async upsertChannels(channels: BrainChannel[]): Promise<void> {
    for (const channel of channels) {
      await this.#pool.query(
        `INSERT INTO brain.channels (channel_id, name, visibility, active) VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id) DO UPDATE SET name = EXCLUDED.name, visibility = EXCLUDED.visibility, active = EXCLUDED.active, updated_at = now()`,
        [channel.channelId, channel.name, channel.visibility, channel.active],
      );
    }
  }

  /** One document by id (tests and tools). */
  async getDocument(id: string): Promise<(BrainDocument & { updatedAt: Date }) | undefined> {
    const r = await this.#pool.query<{
      id: string;
      channel_id: string;
      channel_name: string;
      text: string;
      authors: { id: string; name: string }[];
      first_at: Date;
      last_at: Date;
      source_url: string | null;
      event_ids: string[];
      updated_at: Date;
    }>('SELECT id, channel_id, channel_name, text, authors, first_at, last_at, source_url, event_ids, updated_at FROM brain.documents WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      text: row.text,
      authors: row.authors,
      firstAt: row.first_at,
      lastAt: row.last_at,
      sourceUrl: row.source_url ?? undefined,
      eventIds: row.event_ids,
      updatedAt: row.updated_at,
    };
  }

  /** Ids of every document of a channel (tests and tools). */
  async documentIds(channelId: string): Promise<string[]> {
    const r = await this.#pool.query<{ id: string }>('SELECT id FROM brain.documents WHERE channel_id = $1 ORDER BY id', [channelId]);
    return r.rows.map((row) => row.id);
  }
}
