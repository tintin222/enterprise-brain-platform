// Uploaded files (FR-5, D63): bytes in the state database, deduplicated by SHA-256. Documents reference a file
// by id; the same content uploaded twice is stored once. Size limits are the caller's (BRAIN_FILE_MAX_MB).
import { createHash } from 'node:crypto';
import type { Pool } from '@brain/shared';

export interface FileRecord {
  id: string;
  sha256: string;
  size: number;
  mediaType: string;
  createdBy: string;
  createdAt: Date;
}

export interface StoredFile extends FileRecord {
  bytes: Buffer;
}

interface FileRow {
  id: string;
  sha256: string;
  size: string;
  media_type: string;
  created_by: string;
  created_at: Date;
  bytes?: Buffer;
}

const toRecord = (row: FileRow): FileRecord => ({ id: row.id, sha256: row.sha256, size: Number(row.size), mediaType: row.media_type, createdBy: row.created_by, createdAt: row.created_at });

export interface FileStore {
  put(bytes: Uint8Array, mediaType: string, createdBy: string): Promise<{ file: FileRecord; created: boolean }>;
  get(id: string): Promise<StoredFile | undefined>;
  meta(id: string): Promise<FileRecord | undefined>;
}

export class DatabaseFileStore implements FileStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async put(bytes: Uint8Array, mediaType: string, createdBy: string): Promise<{ file: FileRecord; created: boolean }> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inserted = await this.#pool.query<FileRow>(
      `INSERT INTO brain.files (sha256, size, media_type, bytes, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha256) DO NOTHING RETURNING id, sha256, size, media_type, created_by, created_at`,
      [sha256, bytes.byteLength, mediaType || 'application/octet-stream', Buffer.from(bytes), createdBy],
    );
    if (inserted.rows[0]) return { file: toRecord(inserted.rows[0]), created: true };
    const existing = await this.#pool.query<FileRow>('SELECT id, sha256, size, media_type, created_by, created_at FROM brain.files WHERE sha256 = $1', [sha256]);
    return { file: toRecord(existing.rows[0]!), created: false };
  }

  async get(id: string): Promise<StoredFile | undefined> {
    const r = await this.#pool.query<FileRow>('SELECT id, sha256, size, media_type, created_by, created_at, bytes FROM brain.files WHERE id = $1', [id]);
    const row = r.rows[0];
    return row ? { ...toRecord(row), bytes: row.bytes ?? Buffer.alloc(0) } : undefined;
  }

  async meta(id: string): Promise<FileRecord | undefined> {
    const r = await this.#pool.query<FileRow>('SELECT id, sha256, size, media_type, created_by, created_at FROM brain.files WHERE id = $1', [id]);
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }
}
