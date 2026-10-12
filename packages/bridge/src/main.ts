// Entry point: `pnpm bridge` (reads .env from the repository root).
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, MattermostChatClient, parseConfig } from '@brain/shared';
import { Bridge } from './bridge.ts';
import { bridgeConfigSchema } from './config.ts';

loadDotEnv();
const config = parseConfig(bridgeConfigSchema);
const log = createLogger('bridge', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
const bridge = new Bridge({
  config,
  pool,
  chat: new MattermostChatClient(config.MM_URL, config.MM_BRIDGE_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND }),
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
  keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
  log,
});

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  void bridge
    .stop()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await bridge.start();
