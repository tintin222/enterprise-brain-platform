// The local .env file: creation from .env.example, generated secrets, and reads/updates.
// Secret values are never printed; callers log key names only.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { newSecretKeyHex, pubkeyOf } from './nostr.ts';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
export const envPath = path.join(repoRoot, '.env');
export const envExamplePath = path.join(repoRoot, '.env.example');

export type EnvValues = Record<string, string>;
type Generator = () => string;

const hex32: Generator = () => randomBytes(32).toString('hex');
const dbPassword: Generator = () => randomBytes(18).toString('base64url');
// Mattermost password rules are configurable; the fixed prefix covers upper, lower, digit and symbol.
const userPassword: Generator = () => `Aa1-${randomBytes(18).toString('base64url')}`;

export const generators: Record<string, Generator> = {
  BRIDGE_SECRET_KEY: newSecretKeyHex,
  READER_SECRET_KEY: newSecretKeyHex,
  BUZZ_RELAY_PRIVATE_KEY: newSecretKeyHex,
  KEY_ENCRYPTION_KEY: hex32,
  ADMIN_API_TOKEN: hex32,
  BUZZ_GIT_HOOK_HMAC_SECRET: hex32,
  STATE_DB_PASSWORD: dbPassword,
  MM_DB_PASSWORD: dbPassword,
  BUZZ_DB_PASSWORD: dbPassword,
  BUZZ_REDIS_PASSWORD: dbPassword,
  BUZZ_S3_ACCESS_KEY: () => randomBytes(10).toString('hex'),
  BUZZ_S3_SECRET_KEY: () => randomBytes(20).toString('hex'),
  MM_ADMIN_PASSWORD: userPassword,
  MM_PERSON_PASSWORD: userPassword,
};

/** Values computed from other values; recomputed on every run so they cannot drift. */
export function deriveValues(values: EnvValues): EnvValues {
  const derived: EnvValues = {};
  if (values.BRIDGE_SECRET_KEY) derived.RELAY_OWNER_PUBKEY = pubkeyOf(values.BRIDGE_SECRET_KEY);
  if (values.STATE_DB_PASSWORD && values.STATE_DB_PORT) {
    derived.STATE_DATABASE_URL = `postgres://brain:${values.STATE_DB_PASSWORD}@localhost:${values.STATE_DB_PORT}/brain`;
  }
  return derived;
}

/**
 * Merge the template defaults, the current values and generated secrets. Current non-empty values
 * always win, so re-running never rotates a key or password.
 */
export function resolveEnv(
  templateText: string,
  current: EnvValues,
  gens: Record<string, Generator> = generators,
): { values: EnvValues; generated: string[] } {
  const defaults = parseEnv(templateText);
  const values: EnvValues = { ...current };
  const generated: string[] = [];
  for (const [key, fallback] of Object.entries(defaults)) {
    if (values[key]) continue;
    const gen = gens[key];
    if (fallback) values[key] = fallback;
    else if (gen) {
      values[key] = gen();
      generated.push(key);
    } else values[key] = '';
  }
  return { values: { ...values, ...deriveValues(values) }, generated };
}

function formatValue(value: string): string {
  return /^[\w\-.:/@?&=+,%]*$/.test(value) ? value : JSON.stringify(value);
}

/** Render values in the template's order, keeping its comments; unknown keys go at the end. */
export function renderEnv(templateText: string, values: EnvValues): string {
  const seen = new Set<string>();
  const lines = templateText.split('\n').map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match?.[1]) return line;
    seen.add(match[1]);
    return `${match[1]}=${formatValue(values[match[1]] ?? '')}`;
  });
  const extra = Object.keys(values).filter((key) => !seen.has(key));
  if (extra.length > 0) {
    lines.push('# --- Local additions (not in .env.example) ---');
    for (const key of extra) lines.push(`${key}=${formatValue(values[key] ?? '')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function readEnvFile(file = envPath): EnvValues {
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as EnvValues) : {};
}

function writeEnvFile(values: EnvValues): void {
  // Derived values (RELAY_OWNER_PUBKEY, STATE_DATABASE_URL) follow every change of what they derive from.
  writeFileSync(envPath, renderEnv(readFileSync(envExamplePath, 'utf8'), { ...values, ...deriveValues(values) }), { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

/** Create or complete .env. Returns the names of the keys it generated. */
export function ensureEnvFile(): { created: boolean; generated: string[] } {
  const created = !existsSync(envPath);
  const { values, generated } = resolveEnv(readFileSync(envExamplePath, 'utf8'), readEnvFile());
  writeEnvFile(values);
  return { created, generated };
}

/** Set one key in .env, keeping everything else. */
export function updateEnvFile(key: string, value: string): void {
  writeEnvFile({ ...readEnvFile(), [key]: value });
}

/** Remove a key from .env (keys from .env.example stay, empty). */
export function removeFromEnvFile(key: string): void {
  const values = readEnvFile();
  delete values[key];
  writeEnvFile(values);
}

/** Load .env for a script; fails with a hint when the stack has not been set up. */
export function loadEnv(): EnvValues {
  if (!existsSync(envPath)) throw new Error('No .env found. Run `pnpm dev:up` first.');
  return readEnvFile();
}

export function requireValue(env: EnvValues, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is empty in .env. Run \`pnpm dev:up\` (or \`pnpm dev:seed\` for MM_BRIDGE_TOKEN).`);
  return value;
}
