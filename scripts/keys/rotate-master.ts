// pnpm keys:rotate-master: re-encrypt every secret in the key store under a new KEY_ENCRYPTION_KEY
// (docs/operations.md). Stop the bridge, agent-runtime and ingestion first and start them again after.
// The new key is written to .env before any secret depends on it, so a crash never loses it.
import { randomBytes } from 'node:crypto';
import { createPool, KeyStore, withTransaction } from '@brain/shared';
import { loadEnv, removeFromEnvFile, requireValue, updateEnvFile } from '../lib/env.ts';

const env = loadEnv();
const current = requireValue(env, 'KEY_ENCRYPTION_KEY');
const next = env.KEY_ENCRYPTION_KEY_NEXT || randomBytes(32).toString('hex');
updateEnvFile('KEY_ENCRYPTION_KEY_NEXT', next);
const pool = createPool(requireValue(env, 'STATE_DATABASE_URL'));
try {
  let moved = 0;
  if (await new KeyStore(pool, next).opensSecrets()) {
    // An earlier run committed but stopped before switching .env.
    console.log('The secrets already use the new key; finishing the switch.');
  } else {
    moved = await withTransaction(pool, (tx) => new KeyStore(tx, current).reencryptAll(next, tx));
  }
  updateEnvFile('KEY_ENCRYPTION_KEY', next);
  removeFromEnvFile('KEY_ENCRYPTION_KEY_NEXT');
  console.log(`Re-encrypted ${moved} secrets; the new KEY_ENCRYPTION_KEY is in .env. Start the services again.`);
} finally {
  await pool.end();
}
