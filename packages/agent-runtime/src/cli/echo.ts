// pnpm agent:echo [--handle echo]: run the echo agent (provision it first with pnpm agent:provision).
import { parseArgs } from 'node:util';
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, parseConfig, signerFromHex } from '@brain/shared';
import { runtimeConfigSchema } from '../config.ts';
import { EchoAgent } from '../echo-agent.ts';
import { AgentRepository } from '../registry.ts';

const { values } = parseArgs({ options: { handle: { type: 'string', default: 'echo' } } });
loadDotEnv();
const config = parseConfig(runtimeConfigSchema);
const log = createLogger('echo-agent', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
const agent = await new AgentRepository(pool).getByHandle(values.handle);
if (!agent) {
  console.error(`No agent @${values.handle}. Run: pnpm agent:provision --handle ${values.handle} --name "Echo"`);
  process.exit(1);
}
const echo = new EchoAgent({
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
  keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
  readerSigner: signerFromHex(config.READER_SECRET_KEY),
  agent,
  relayWsUrl: config.RELAY_WS_URL,
  log,
  maxEventAgeSeconds: config.MAX_EVENT_AGE_SECONDS,
  overlapSeconds: config.RELAY_OVERLAP_SECONDS,
});
const shutdown = (): void => void echo.stop().then(() => pool.end()).finally(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await echo.start();
