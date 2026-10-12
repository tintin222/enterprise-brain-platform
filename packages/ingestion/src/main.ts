// Entry point: `pnpm ingestion` (reads .env from the repository root).
import { PostgresBrainClient } from '@brain/brain';
import { BuzzRelayClient, createLogger, createPool, loadDotEnv, parseConfig } from '@brain/shared';
import { ingestionConfigSchema } from './config.ts';
import { Ingestion } from './ingestion.ts';

loadDotEnv();
const config = parseConfig(ingestionConfigSchema);
const log = createLogger('ingestion', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
// The knowledge store: threads become conversation entities and chunks (docs/brain/01-phase0-plan.md section 6).
const brain = new PostgresBrainClient(pool, { log });
await brain.init();
const ingestion = new Ingestion({ config, pool, relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }), brain, log });

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  void ingestion
    .stop()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await ingestion.start();
