// pnpm check:logs [--env-only] <file> [<file> ...]: fail if any secret appears in the given log files (Phase 6
// acceptance: no secret in logs). Secrets are the .env secrets plus every secret in the key store, decrypted here
// and searched for as text, hex and base64. Matches are reported by secret name only, never by value.
// --env-only skips the key store, for a state database this machine cannot reach (staging, ENV_FILE=.env.staging).
import { readFileSync } from 'node:fs';
import { createPool, KeyStore } from '@brain/shared';
import { loadEnv, requireValue } from '../lib/env.ts';

const envOnly = process.argv.includes('--env-only');
const files = process.argv.slice(2).filter((arg) => arg !== '--env-only');
if (files.length === 0) {
  console.error('Usage: pnpm check:logs [--env-only] <log file> [<log file> ...]');
  process.exit(2);
}

const ENV_SECRETS = [
  'KEY_ENCRYPTION_KEY',
  'BRIDGE_SECRET_KEY',
  'READER_SECRET_KEY',
  'BUZZ_RELAY_PRIVATE_KEY',
  'BUZZ_GIT_HOOK_HMAC_SECRET',
  'STATE_DB_PASSWORD',
  'MM_DB_PASSWORD',
  'BUZZ_DB_PASSWORD',
  'BUZZ_REDIS_PASSWORD',
  'BUZZ_S3_ACCESS_KEY',
  'BUZZ_S3_SECRET_KEY',
  'MM_ADMIN_PASSWORD',
  'MM_PERSON_PASSWORD',
  'MM_BRIDGE_TOKEN',
  'MM_ADMIN_TOKEN',
  'ANTHROPIC_API_KEY',
];

const env = loadEnv();
const secrets = new Map<string, string[]>();
const add = (name: string, value: string | Buffer): void => {
  const forms = typeof value === 'string' ? [value] : [value.toString('hex'), value.toString('base64'), value.toString('utf8')];
  // Short values (or printable forms of binary keys) would match by chance.
  secrets.set(name, [...new Set(forms.filter((form) => form.length >= 12))]);
};
for (const name of ENV_SECRETS) if (env[name]) add(name, env[name]);

if (envOnly) {
  console.log('Key store secrets not checked (--env-only).');
} else {
  const pool = createPool(requireValue(env, 'STATE_DATABASE_URL'));
  try {
    const keyStore = new KeyStore(pool, requireValue(env, 'KEY_ENCRYPTION_KEY'));
    const rows = await pool.query<{ ref: string; kind: string }>('SELECT ref, kind FROM identity.secrets');
    for (const row of rows.rows) {
      const value = await keyStore.getSecret(row.ref);
      if (value) add(`key store ${row.kind} (${row.ref})`, row.kind === 'agent-token' ? value.toString('utf8') : value);
    }
  } finally {
    await pool.end();
  }
}

let found = 0;
let bytes = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  bytes += text.length;
  for (const [name, forms] of secrets) {
    if (forms.some((form) => text.includes(form))) {
      found++;
      console.log(`SECRET FOUND in ${file}: ${name}`);
    }
  }
}
console.log(`Checked ${files.length} file(s), ${Math.round(bytes / 1024)} KiB, for ${secrets.size} secrets: ${found === 0 ? 'none found' : `${found} found`}.`);
process.exit(found === 0 ? 0 : 1);
