// The open export (NFR-9; docs/brain/export-format.md): every table as JSON Lines, the uploaded files next to
// them, a manifest; an import into an empty brain schema; and a verification that imports the export into a
// temporary database on the same server and compares it with the source.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createPool, migrate, type Pool } from '@brain/shared';
import { BRAIN_MIGRATIONS_DIR, EXPORT_TABLES, type BrainStore, type ExportTable } from './store.ts';

export const EXPORT_FORMAT = 'jsonl/2';

export interface ExportManifest {
  format: string;
  generatedAt: string;
  tables: Record<string, number>;
  files: { count: number; bytes: number };
}

interface FileRow {
  id: string;
  sha256: string;
  size: string | number;
  media_type: string;
  created_by: string;
  created_at: Date | string;
}

/** Columns whose values are JSON documents, written as JSON and read back with a cast. */
const JSON_COLUMNS: Record<string, Set<string>> = {
  containers: new Set(['data']),
  entities: new Set(['data']),
  entity_versions: new Set(['data']),
  links: new Set(['data']),
  chunks: new Set(['metadata']),
  audit_log: new Set(['details']),
  events: new Set(['payload']),
  channel_links: new Set(),
  channels: new Set(),
};
const SEQUENCES: Partial<Record<ExportTable, string>> = { links: 'id', audit_log: 'id', events: 'id' };

/** Write the whole store to `dir`: one `.jsonl` per table, `files/<id>` for uploads, `manifest.json`. */
export async function exportToDirectory(store: BrainStore, dir: string): Promise<ExportManifest> {
  await mkdir(path.join(dir, 'files'), { recursive: true });
  const tables: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const out = createWriteStream(path.join(dir, `${table}.jsonl`));
    let n = 0;
    for await (const row of store.exportRows(table, { withEmbeddings: true })) {
      if (!out.write(`${JSON.stringify(row)}\n`)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      n++;
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    tables[table] = n;
  }
  const files = await store.pool.query<FileRow>('SELECT id, sha256, size, media_type, created_by, created_at FROM brain.files ORDER BY created_at, id');
  let bytes = 0;
  const lines: string[] = [];
  for (const file of files.rows) {
    const content = await store.pool.query<{ bytes: Buffer }>('SELECT bytes FROM brain.files WHERE id = $1', [file.id]);
    await writeFile(path.join(dir, 'files', file.id), content.rows[0]!.bytes);
    bytes += Number(file.size);
    lines.push(JSON.stringify(file));
  }
  await writeFile(path.join(dir, 'files.jsonl'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  const manifest: ExportManifest = { format: EXPORT_FORMAT, generatedAt: new Date().toISOString(), tables, files: { count: files.rows.length, bytes } };
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function* lines(file: string): AsyncGenerator<Record<string, unknown>> {
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
}

/** Load an export into a brain schema whose migrations have run. Rows that already exist (the General container) are kept. */
export async function importFromDirectory(pool: Pool, dir: string): Promise<Record<string, number>> {
  const imported: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const json = JSON_COLUMNS[table] ?? new Set<string>();
    let n = 0;
    for await (const row of lines(path.join(dir, `${table}.jsonl`))) {
      const columns = Object.keys(row);
      const placeholders = columns.map((column, i) => (column === 'embedding' ? `$${i + 1}::vector` : json.has(column) ? `$${i + 1}::jsonb` : `$${i + 1}`));
      const values = columns.map((column) => (json.has(column) ? JSON.stringify(row[column]) : row[column]));
      const r = await pool.query(`INSERT INTO brain.${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`, values);
      n += r.rowCount ?? 0;
    }
    const sequence = SEQUENCES[table];
    if (sequence) await pool.query(`SELECT setval(pg_get_serial_sequence('brain.${table}', '${sequence}'), COALESCE((SELECT max(${sequence}) FROM brain.${table}), 0) + 1, false)`);
    imported[table] = n;
  }
  let files = 0;
  for await (const file of lines(path.join(dir, 'files.jsonl'))) {
    const bytes = await readFile(path.join(dir, 'files', String(file.id)));
    const r = await pool.query('INSERT INTO brain.files (id, sha256, size, media_type, bytes, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING', [file.id, file.sha256, file.size, file.media_type, bytes, file.created_by, file.created_at]);
    files += r.rowCount ?? 0;
  }
  imported.files = files;
  return imported;
}

export interface VerifyReport {
  ok: boolean;
  database: string;
  tables: Record<string, { expected: number; imported: number }>;
  files: { expected: number; imported: number; hashMismatches: string[] };
  entityMismatches: string[];
}

/**
 * Import the export into a temporary database on the same server, compare counts, entity versions and file hashes
 * with the manifest and the export, then drop the database. Needs CREATE DATABASE (our images' brain user has it).
 */
export async function verifyRoundTrip(sourceUrl: string, dir: string): Promise<VerifyReport> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as ExportManifest;
  const name = `brain_verify_${Date.now().toString(36)}`;
  const admin = createPool(sourceUrl, 1);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  const target = createPool(url.toString(), 2);
  try {
    await migrate(target, 'brain', BRAIN_MIGRATIONS_DIR);
    const imported = await importFromDirectory(target, dir);
    const tables: VerifyReport['tables'] = {};
    let ok = true;
    for (const table of EXPORT_TABLES) {
      const r = await target.query<{ n: number }>(`SELECT count(*)::int AS n FROM brain.${table}`);
      const expected = manifest.tables[table] ?? 0;
      // The General container exists before the import; it is in the export too, so the counts agree.
      tables[table] = { expected, imported: r.rows[0]?.n ?? 0 };
      if (tables[table].imported !== expected) ok = false;
    }
    const entityMismatches: string[] = [];
    for await (const row of lines(path.join(dir, 'entities.jsonl'))) {
      const r = await target.query<{ version: number; title: string }>('SELECT version, title FROM brain.entities WHERE id = $1', [row.id]);
      if (!r.rows[0] || r.rows[0].version !== row.version || r.rows[0].title !== row.title) entityMismatches.push(String(row.id));
    }
    const hashMismatches: string[] = [];
    let expectedFiles = 0;
    for await (const file of lines(path.join(dir, 'files.jsonl'))) {
      expectedFiles++;
      const r = await target.query<{ bytes: Buffer }>('SELECT bytes FROM brain.files WHERE id = $1', [file.id]);
      if (!r.rows[0] || createHash('sha256').update(r.rows[0].bytes).digest('hex') !== file.sha256) hashMismatches.push(String(file.id));
    }
    if (entityMismatches.length > 0 || hashMismatches.length > 0 || imported.files !== expectedFiles) ok = false;
    return { ok, database: name, tables, files: { expected: expectedFiles, imported: imported.files ?? 0, hashMismatches }, entityMismatches };
  } finally {
    await target.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined);
    await admin.end();
  }
}

/** Stream one exported file back out (the API's GET /export/files/:id uses the store directly; this is for tools). */
export async function copyFile(dir: string, id: string, to: NodeJS.WritableStream): Promise<void> {
  await pipeline(createReadStream(path.join(dir, 'files', id)), to);
}
