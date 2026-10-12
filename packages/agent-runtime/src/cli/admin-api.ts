// Entry point: `pnpm admin-api`, the internal admin API for the brain product (docs/operations.md).
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, MattermostChatClient, parseConfig, signerFromHex } from '@brain/shared';
import { startAdminApi } from '../admin-api.ts';
import { adminApiConfigSchema } from '../config.ts';

loadDotEnv();
const config = parseConfig(adminApiConfigSchema);
const log = createLogger('admin-api', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
const chat = new MattermostChatClient(config.MM_URL, config.MM_ADMIN_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND });
const brainUserId = (await chat.withToken(config.MM_BRIDGE_TOKEN).getMe()).id;
const api = await startAdminApi({
  host: config.OPS_HOST,
  port: config.ADMIN_API_PORT,
  token: config.ADMIN_API_TOKEN,
  pool,
  chat,
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
  keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
  bridgeSigner: signerFromHex(config.BRIDGE_SECRET_KEY),
  teamName: config.MM_TEAM_NAME,
  brainUserId,
  log,
});

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  void api
    .close()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
