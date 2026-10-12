// pnpm brain:setup: register the brain with Mattermost (allow-list, OAuth app, /brain command), as the seed
// and the installer do. Idempotent. Reads .env.
import { BrainStore } from '@brain/brain';
import { createLogger, createPool, KeyStore, loadDotEnv, MattermostChatClient, parseConfig } from '@brain/shared';
import { brainApiConfigSchema } from '../config.ts';
import { ensureMattermostIntegration } from '../mattermost-setup.ts';

loadDotEnv();
const config = parseConfig(brainApiConfigSchema);
const log = createLogger('brain-setup', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
try {
  const store = new BrainStore(pool);
  await store.init();
  const result = await ensureMattermostIntegration({
    adminChat: new MattermostChatClient(config.MM_URL, config.MM_ADMIN_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND }),
    store,
    keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
    publicUrl: config.BRAIN_PUBLIC_URL,
    internalUrl: config.BRAIN_INTERNAL_URL,
    log,
  });
  console.log(`Mattermost knows the brain: allow-listed ${result.allowedHost}, OAuth app ${result.oauthClientId}, /brain in ${result.commands.length} team(s).`);
} finally {
  await pool.end();
}
