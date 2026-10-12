// pnpm relay:rebuild: after the relay lost its data, prepare our services to rebuild it from Mattermost
// (docs/operations.md). Run it with the bridge, agent-runtime and ingestion stopped. It forgets what the bridge
// and ingestion knew about the relay's contents (keys, enabled channels and purges stay) and makes the reader
// key a relay member again. On their next start the bridge creates every enabled channel again and replays its
// whole history from Mattermost as backfill, so agents do not answer it, and ingestion re-indexes everything.
import { resetForRelayRebuild as resetBridge } from '@brain/bridge';
import { resetForRelayRebuild as resetIngestion } from '@brain/ingestion';
import { createPool, migrate, nowSeconds, PostgresBrainClient, signerFromHex, withTransaction } from '@brain/shared';
import { INGESTION_MIGRATIONS_DIR } from '@brain/ingestion';
import { loadEnv, requireValue } from '../lib/env.ts';
import { adminEvent, relayClient } from '../keys/relay-ops.ts';

const env = loadEnv();
const pool = createPool(requireValue(env, 'STATE_DATABASE_URL'));
try {
  const bridge = await withTransaction(pool, (tx) => resetBridge(tx));
  const brain = new PostgresBrainClient(pool);
  await brain.init();
  await migrate(pool, 'ingestion', INGESTION_MIGRATIONS_DIR);
  const ingestion = await resetIngestion({ pool, brain });
  const owner = signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY'));
  const reader = signerFromHex(requireValue(env, 'READER_SECRET_KEY'));
  const refused = await adminEvent(relayClient(env), owner, 9030, [['p', reader.pubkey], ['role', 'member']]);
  if (refused) console.log(`relay refused the reader membership: ${refused}`);
  console.log(`Reset: ${bridge.channels} channels will be created again and replayed; ${ingestion.documents} documents left the brain.`);
  console.log(`Start the bridge, agent-runtime and ingestion now (at ${new Date(nowSeconds() * 1000).toISOString()}).`);
} finally {
  await pool.end();
}
