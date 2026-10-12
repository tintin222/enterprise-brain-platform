// pnpm agent:provision --handle <handle> --name "<Display Name>" [--model <id>] [--instructions "<text>"]
// Creates (or updates) an agent: key, Mattermost bot and token, relay identity, registry record.
import { parseArgs } from 'node:util';
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, MattermostChatClient, parseConfig, signerFromHex } from '@brain/shared';
import { provisionConfigSchema } from '../config.ts';
import { provisionAgent } from '../provisioning.ts';

const { values } = parseArgs({
  options: {
    handle: { type: 'string' },
    name: { type: 'string' },
    model: { type: 'string' },
    instructions: { type: 'string' },
    description: { type: 'string' },
  },
});
if (!values.handle || !values.name) {
  console.error('Usage: pnpm agent:provision --handle <handle> --name "<Display Name>" [--model <id>] [--instructions "<text>"]');
  process.exit(2);
}

loadDotEnv();
const config = parseConfig(provisionConfigSchema);
const log = createLogger('provision', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
try {
  const agent = await provisionAgent(
    {
      pool,
      chat: new MattermostChatClient(config.MM_URL, config.MM_ADMIN_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND }),
      relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
      keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
      bridgeSigner: signerFromHex(config.BRIDGE_SECRET_KEY),
      teamName: config.MM_TEAM_NAME,
      log,
    },
    {
      handle: values.handle,
      displayName: values.name,
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values.instructions === undefined ? {} : { instructions: values.instructions }),
      ...(values.description === undefined ? {} : { description: values.description }),
    },
  );
  console.log(`Agent @${agent.handle} is ready (pubkey ${agent.nostrPubkey}, bot ${agent.mmBotUserId}). Add the bot to a channel that has @brain.`);
} finally {
  await pool.end();
}
