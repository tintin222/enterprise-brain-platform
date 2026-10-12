// Configuration: .env loading and zod validation. Error messages name variables, never values.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Find the nearest .env, walking up from `start` to the workspace root (the folder with pnpm-workspace.yaml). */
export function findEnvFile(start = process.cwd()): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load .env into process.env. Variables already set in the environment win. */
export function loadDotEnv(file = findEnvFile()): void {
  if (file) process.loadEnvFile(file);
}

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes as 64 hex characters');

/** Settings every service reads. */
export const baseConfigSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STATE_DATABASE_URL: z.string().min(1),
  KEY_ENCRYPTION_KEY: hex32,
  /** Where /healthz, /readyz and /metrics listen; each service has its own port setting. */
  OPS_HOST: z.string().min(1).default('127.0.0.1'),
});

/** Settings for services that talk to the relay. */
export const relayConfigSchema = z.object({
  RELAY_HTTP_URL: z.url(),
  RELAY_WS_URL: z.string().regex(/^wss?:\/\//, 'must be a ws:// or wss:// URL'),
  READER_SECRET_KEY: hex32,
  /** HTTP requests per second per key; the relay allows 1200 per minute per key (D20). */
  RELAY_REQUESTS_PER_SECOND: z.coerce.number().positive().default(15),
});

/** Settings for services that talk to Mattermost. */
export const chatConfigSchema = z.object({
  MM_URL: z.url(),
  /** Mattermost API requests per second per token. */
  MM_REQUESTS_PER_SECOND: z.coerce.number().positive().default(20),
});

export const secretKeySchema = hex32;

export class ConfigError extends Error {}

/** Validate `env` against `schema`. Throws a ConfigError listing the offending variable names. */
export function parseConfig<T extends z.ZodType>(schema: T, env: Record<string, string | undefined> = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
}
