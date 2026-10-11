// Entry point: `pnpm agent-runtime` (reads .env from the repository root).
import { BuzzRelayClient, createLogger, createPool, KeyStore, loadDotEnv, NullBrainClient, parseConfig } from '@brain/shared';
import { runtimeConfigSchema } from './config.ts';
import { providersFromConfig } from './providers.ts';
import { AgentRuntime } from './runtime.ts';

loadDotEnv();
const config = parseConfig(runtimeConfigSchema);
const log = createLogger('agent-runtime', config.LOG_LEVEL);
const pool = createPool(config.STATE_DATABASE_URL);
const runtime = new AgentRuntime({
  config,
  pool,
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL),
  keyStore: new KeyStore(pool, config.KEY_ENCRYPTION_KEY),
  brain: new NullBrainClient(),
  providerFor: providersFromConfig(config),
  log,
});
if (!config.ANTHROPIC_API_KEY) log.warn('ANTHROPIC_API_KEY is not set: only agents with model "echo" will answer');

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  void runtime
    .stop()
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
await runtime.start();
