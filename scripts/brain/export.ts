// pnpm brain:export <dir> [--verify]: write the whole brain (every table as JSON Lines, the uploaded files, a
// manifest) to a directory (NFR-9; docs/brain/export-format.md). With --verify the export is imported into a
// temporary database on the same server and compared with the source; the database is dropped afterwards.
import { parseArgs } from 'node:util';
import { BrainStore, exportToDirectory, verifyRoundTrip } from '@brain/brain';
import { createPool, loadDotEnv } from '@brain/shared';

const { values, positionals } = parseArgs({ options: { verify: { type: 'boolean', default: false } }, allowPositionals: true });
const dir = positionals[0];
if (!dir) {
  console.error('Usage: pnpm brain:export <dir> [--verify]');
  process.exit(2);
}
loadDotEnv();
const url = process.env.STATE_DATABASE_URL ?? '';
const pool = createPool(url, 4);
try {
  const store = new BrainStore(pool);
  await store.init();
  const manifest = await exportToDirectory(store, dir);
  console.log(`Exported to ${dir}: ${Object.entries(manifest.tables).map(([table, n]) => `${table} ${n}`).join(', ')}; ${manifest.files.count} file(s), ${manifest.files.bytes} bytes.`);
  if (values.verify) {
    const report = await verifyRoundTrip(url, dir);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
