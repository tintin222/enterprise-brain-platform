// pnpm brain:bench [--chunks 60000] [--queries 200] [--clean]: the NFR-1 measurement. Seeds synthetic entities
// and chunks into a dedicated "bench" container of the local brain (text and random unit vectors generated in
// SQL, so nothing crosses the wire), then times keyword, semantic and hybrid searches directly against the
// store (no HTTP). Semantic queries use the vectors of random stored chunks, so nearest neighbours exist.
// `--clean` removes the synthetic data. The numbers come from a laptop; the gate report says so.
import { parseArgs } from 'node:util';
import { BrainStore } from '@brain/brain';
import { createPool, loadDotEnv } from '@brain/shared';

const { values } = parseArgs({ options: { chunks: { type: 'string', default: '60000' }, queries: { type: 'string', default: '200' }, clean: { type: 'boolean', default: false } } });
const target = Number(values.chunks);
const queryCount = Number(values.queries);
const BENCH_SLUG = 'bench-nfr-1';
const DIMENSIONS = 1536;
const WORDS = ('warehouse migration erp invoice schema customer order shipment forecast budget review decision requirement api endpoint ' +
  'release deploy outage incident vendor contract renewal license audit compliance kvkk gdpr retention backup restore cluster ' +
  'latency throughput queue worker embedding search index channel thread message meeting transcript action owner deadline').split(' ');
const TYPES = ['conversation', 'decision', 'requirement', 'document', 'task', 'system'];
const PER_ENTITY = 5;

function quantile(sorted: number[], q: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function sentence(seed: number, words: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(WORDS[x % WORDS.length]!);
  }
  return out.join(' ');
}

loadDotEnv();
const pool = createPool(process.env.STATE_DATABASE_URL ?? '', 4);
const store = new BrainStore(pool);
await store.init();
const ctx = { actor: { kind: 'system' as const, id: 'bench' }, source: { kind: 'system' as const } };
try {
  let bench = await store.getContainer(BENCH_SLUG);
  if (values.clean) {
    if (bench) {
      await pool.query('DELETE FROM brain.chunks WHERE container_id = $1', [bench.id]);
      await pool.query('DELETE FROM brain.entity_versions WHERE entity_id IN (SELECT id FROM brain.entities WHERE container_id = $1)', [bench.id]);
      await pool.query('DELETE FROM brain.entities WHERE container_id = $1', [bench.id]);
      await pool.query('DELETE FROM brain.containers WHERE id = $1', [bench.id]);
      console.log('Removed the bench data.');
    }
    process.exit(0);
  }
  bench ??= await store.createContainer({ kind: 'project', title: 'Bench (NFR-1)', slug: BENCH_SLUG }, ctx);
  const existing = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM brain.chunks WHERE container_id = $1', [bench.id])).rows[0]?.n ?? 0);
  console.log(`bench container ${bench.id}: ${existing} chunks present, target ${target}`);
  const started = Date.now();
  const entitiesWanted = Math.ceil(target / PER_ENTITY);
  const entitiesPresent = Math.ceil(existing / PER_ENTITY);
  // Entities and chunks in batches of SQL-generated rows: a deterministic word salad per row, a random unit vector.
  for (let from = entitiesPresent; from < entitiesWanted; from += 1000) {
    const to = Math.min(entitiesWanted, from + 1000);
    await pool.query(
      `INSERT INTO brain.entities (id, type, title, status, container_id, visibility, data, text, version, source_kind, created_by)
       SELECT 'bench-' || $1 || '-' || n, ($2::text[])[1 + n % $3], 'Bench ' || n || ' ' || ($4::text[])[1 + (n * 7) % $5] || ' ' || ($4::text[])[1 + (n * 13) % $5],
              'active', $6, 'public', '{"bench": true}', '', 1, 'system', 'bench'
       FROM generate_series($7::int, $8::int - 1) AS n ON CONFLICT (id) DO NOTHING`,
      [bench.id.slice(0, 8), TYPES, TYPES.length, WORDS, WORDS.length, bench.id, from, to],
    );
    await pool.query(
      `INSERT INTO brain.chunks (id, entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, metadata, embedding, embedding_model, embedded_at)
       SELECT e.id || ':' || c, e.id, e.type, e.container_id, NULL, 'public', c,
              e.title || '. ' || (SELECT string_agg(($1::text[])[1 + ((n * 31 + c * 17 + w * 7) % $2)], ' ') FROM generate_series(1, 60) AS w),
              '{"bench": true}',
              (SELECT array_agg(random() - 0.5) FROM generate_series(1, $3))::vector,
              'bench', now()
       FROM generate_series($4::int, $5::int - 1) AS n
       JOIN brain.entities e ON e.id = 'bench-' || $6 || '-' || n
       CROSS JOIN generate_series(0, $7::int - 1) AS c
       ON CONFLICT (id) DO NOTHING`,
      [WORDS, WORDS.length, DIMENSIONS, from, to, bench.id.slice(0, 8), PER_ENTITY],
    );
    console.log(`  seeded ${Math.min(to * PER_ENTITY, target)} chunks (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  // Random vectors are not unit length; cosine distance does not care, but normalise for realism once.
  if (entitiesWanted > entitiesPresent) await pool.query('UPDATE brain.chunks SET embedding = l2_normalize(embedding) WHERE container_id = $1 AND embedding_model = $2', [bench.id, 'bench']);
  await pool.query('ANALYZE brain.chunks');
  const total = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM brain.chunks')).rows[0]?.n ?? 0);
  console.log(`total chunks in the store: ${total} (seeding took ${Math.round((Date.now() - started) / 1000)} s)`);

  const modes = { keyword: [] as number[], semantic: [] as number[], hybrid: [] as number[] };
  const sampled = await pool.query<{ embedding: string }>('SELECT embedding::text AS embedding FROM brain.chunks TABLESAMPLE SYSTEM (2) WHERE embedding IS NOT NULL LIMIT $1', [queryCount]);
  const vectors = sampled.rows.map((row) => JSON.parse(row.embedding) as number[]);
  if (vectors.length === 0) throw new Error('No embedded chunks to sample query vectors from');
  for (let i = 0; i < 5; i++) await store.search({ query: sentence(i, 3), scope: { kind: 'all' }, limit: 20 });
  for (let i = 0; i < queryCount; i++) {
    const q = sentence(7919 + i, 3);
    const embedding = vectors[i % vectors.length]!;
    const t0 = performance.now();
    await store.search({ query: q, scope: { kind: 'all' }, limit: 20 });
    const t1 = performance.now();
    await store.search({ query: '​', embedding, maxDistance: 0.9, scope: { kind: 'all' }, limit: 20 });
    const t2 = performance.now();
    await store.search({ query: q, embedding, maxDistance: 0.9, scope: { kind: 'all' }, limit: 20 });
    const t3 = performance.now();
    modes.keyword.push(t1 - t0);
    modes.semantic.push(t2 - t1);
    modes.hybrid.push(t3 - t2);
  }
  const report: Record<string, { p50: number; p95: number; max: number }> = {};
  for (const [mode, samples] of Object.entries(modes)) {
    const sorted = [...samples].sort((a, b) => a - b);
    report[mode] = { p50: Math.round(quantile(sorted, 0.5)), p95: Math.round(quantile(sorted, 0.95)), max: Math.round(sorted.at(-1) ?? 0) };
  }
  console.log(JSON.stringify({ chunks: total, queries: queryCount, latencyMs: report, nfr1: { targetP95Ms: 1500, hybridP95Ms: report.hybrid?.p95, met: (report.hybrid?.p95 ?? Infinity) < 1500 } }, null, 2));
} finally {
  await pool.end();
}
