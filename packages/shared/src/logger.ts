// Structured JSON logging. Fields that can carry secrets are redacted wherever they appear.
import { pino, type Logger } from 'pino';

export type { Logger };

const SECRET_FIELDS = ['secret', 'secretKey', 'secret_key', 'token', 'password', 'authorization', 'Authorization', 'ciphertext', 'signed_event', 'sig'];

const REDACT_PATHS = [...SECRET_FIELDS, ...SECRET_FIELDS.map((field) => `*.${field}`), ...SECRET_FIELDS.map((field) => `*.*.${field}`)];

export function createLogger(service: string, level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name: service,
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** A logger that discards everything, for tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Error details safe to log: message and name, no request bodies. */
export function errorFields(error: unknown): { err: { name: string; message: string } } {
  if (error instanceof Error) return { err: { name: error.name, message: error.message } };
  return { err: { name: 'Unknown', message: String(error) } };
}
