// Ingestion state tables (schema "ingestion", migrations/0001_init.sql).
import path from 'node:path';
import type { Queryable } from '@brain/shared';

export const INGESTION_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

export interface ThreadKey {
  channelId: string;
  rootId: string;
}

export interface PendingThread extends ThreadKey {
  version: number;
  dueAt: Date;
  /** The thread's first change since it was last indexed. */
  firstAt: Date;
}

export type ExclusionKind = 'channel' | 'author';

export class IngestionStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async getCursor(stream: string): Promise<number | undefined> {
    const r = await this.#db.query<{ position: string }>('SELECT position FROM ingestion.cursors WHERE stream = $1', [stream]);
    return r.rows[0] ? Number(r.rows[0].position) : undefined;
  }

  async setCursor(stream: string, position: number): Promise<void> {
    await this.#db.query(
      `INSERT INTO ingestion.cursors (stream, position) VALUES ($1, $2)
       ON CONFLICT (stream) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
      [stream, position],
    );
  }

  async recordMessage(eventId: string, thread: ThreadKey, author: string): Promise<void> {
    await this.#db.query('INSERT INTO ingestion.messages (event_id, channel_id, root_id, author) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
      eventId,
      thread.channelId,
      thread.rootId,
      author,
    ]);
  }

  /** Event ids of the thread's messages that ingestion has seen. */
  async messageIds(thread: ThreadKey): Promise<string[]> {
    const r = await this.#db.query<{ event_id: string }>('SELECT event_id FROM ingestion.messages WHERE channel_id = $1 AND root_id = $2', [thread.channelId, thread.rootId]);
    return r.rows.map((row) => row.event_id);
  }

  /** True if this edit or deletion was handled before (catch-up re-reads an overlap window). */
  async changeSeen(eventId: string): Promise<boolean> {
    const r = await this.#db.query('SELECT 1 FROM ingestion.seen_changes WHERE event_id = $1', [eventId]);
    return (r.rowCount ?? 0) > 0;
  }

  async markChangeSeen(eventId: string): Promise<void> {
    await this.#db.query('INSERT INTO ingestion.seen_changes (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  }

  /** The thread a message belongs to, if ingestion has seen it. */
  async threadOf(eventId: string): Promise<ThreadKey | undefined> {
    const r = await this.#db.query<{ channel_id: string; root_id: string }>('SELECT channel_id, root_id FROM ingestion.messages WHERE event_id = $1', [eventId]);
    return r.rows[0] ? { channelId: r.rows[0].channel_id, rootId: r.rows[0].root_id } : undefined;
  }

  /** Mark a thread for indexing. The first mark sets when it is due; later marks only count as changes. */
  async markPending(thread: ThreadKey, dueAt: Date): Promise<void> {
    await this.#db.query(
      `INSERT INTO ingestion.pending (channel_id, root_id, due_at) VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, root_id) DO UPDATE SET version = ingestion.pending.version + 1`,
      [thread.channelId, thread.rootId, dueAt],
    );
  }

  async duePending(now: Date, limit: number): Promise<PendingThread[]> {
    const r = await this.#db.query<{ channel_id: string; root_id: string; version: number; due_at: Date; first_at: Date }>(
      'SELECT channel_id, root_id, version, due_at, first_at FROM ingestion.pending WHERE due_at <= $1 ORDER BY due_at LIMIT $2',
      [now, limit],
    );
    return r.rows.map((row) => ({ channelId: row.channel_id, rootId: row.root_id, version: row.version, dueAt: row.due_at, firstAt: row.first_at }));
  }

  /**
   * Clear a pending thread after indexing it. If it changed again since `version` was read, keep it and make
   * it due again at `nextDueAt`, so an active thread is re-indexed at most once per debounce window.
   */
  async finishPending(item: PendingThread, nextDueAt: Date): Promise<void> {
    const r = await this.#db.query('DELETE FROM ingestion.pending WHERE channel_id = $1 AND root_id = $2 AND version = $3', [item.channelId, item.rootId, item.version]);
    if (r.rowCount === 0) await this.postponePending(item, nextDueAt);
  }

  async postponePending(thread: ThreadKey, dueAt: Date): Promise<void> {
    await this.#db.query('UPDATE ingestion.pending SET due_at = $3 WHERE channel_id = $1 AND root_id = $2', [thread.channelId, thread.rootId, dueAt]);
  }

  async pendingCount(): Promise<number> {
    const r = await this.#db.query<{ count: string }>('SELECT count(*) AS count FROM ingestion.pending');
    return Number(r.rows[0]?.count ?? 0);
  }

  async getThreadDocs(thread: ThreadKey): Promise<string[]> {
    const r = await this.#db.query<{ doc_ids: string[] }>('SELECT doc_ids FROM ingestion.threads WHERE channel_id = $1 AND root_id = $2', [thread.channelId, thread.rootId]);
    return r.rows[0]?.doc_ids ?? [];
  }

  async setThreadDocs(thread: ThreadKey, docIds: string[]): Promise<void> {
    if (docIds.length === 0) {
      await this.#db.query('DELETE FROM ingestion.threads WHERE channel_id = $1 AND root_id = $2', [thread.channelId, thread.rootId]);
      return;
    }
    await this.#db.query(
      `INSERT INTO ingestion.threads (channel_id, root_id, doc_ids) VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, root_id) DO UPDATE SET doc_ids = EXCLUDED.doc_ids, indexed_at = now()`,
      [thread.channelId, thread.rootId, docIds],
    );
  }

  /** Every indexed thread of a channel, with its documents. */
  async threadsOfChannel(channelId: string): Promise<(ThreadKey & { docIds: string[] })[]> {
    const r = await this.#db.query<{ channel_id: string; root_id: string; doc_ids: string[] }>('SELECT channel_id, root_id, doc_ids FROM ingestion.threads WHERE channel_id = $1', [channelId]);
    return r.rows.map((row) => ({ channelId: row.channel_id, rootId: row.root_id, docIds: row.doc_ids }));
  }

  /** Every thread an author wrote in. */
  async threadsOfAuthor(author: string): Promise<ThreadKey[]> {
    const r = await this.#db.query<{ channel_id: string; root_id: string }>('SELECT DISTINCT channel_id, root_id FROM ingestion.messages WHERE author = $1', [author]);
    return r.rows.map((row) => ({ channelId: row.channel_id, rootId: row.root_id }));
  }

  async addExclusion(kind: ExclusionKind, value: string): Promise<void> {
    await this.#db.query('INSERT INTO ingestion.exclusions (kind, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [kind, value]);
  }

  async exclusions(): Promise<{ channels: Set<string>; authors: Set<string> }> {
    const r = await this.#db.query<{ kind: ExclusionKind; value: string }>('SELECT kind, value FROM ingestion.exclusions');
    return {
      channels: new Set(r.rows.filter((row) => row.kind === 'channel').map((row) => row.value)),
      authors: new Set(r.rows.filter((row) => row.kind === 'author').map((row) => row.value)),
    };
  }
}
