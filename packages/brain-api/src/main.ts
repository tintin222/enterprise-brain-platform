// Entry point: `pnpm brain-api` (reads .env from the repository root). Starts the API, the pages and the
// embedding worker; migrations run first.
import { RUNTIME_MIGRATIONS_DIR } from '@brain/agent-runtime';
import { BrainStore, DatabaseFileStore } from '@brain/brain';
import { embeddingProviderFromConfig } from '@brain/models';
import { BuzzRelayClient, chatApiUrl, createLogger, createPool, IDENTITY_MIGRATIONS_DIR, KeyStore, loadDotEnv, MattermostChatClient, migrate, parseConfig, signerFromHex } from '@brain/shared';
import { AccessService } from './access.ts';
import { buildApp } from './app.ts';
import { brainApiConfigSchema } from './config.ts';
import { startJobRunner } from './jobs.ts';
import { PeopleService } from './people.ts';
import { registerPhase1Jobs } from './phase1-jobs.ts';
import { TokenSigner } from './sessions.ts';
import { startEmbeddingWorker } from './worker.ts';

loadDotEnv();
const config = parseConfig(brainApiConfigSchema);
const log = createLogger('brain-api', config.LOG_LEVEL);
if (!config.BRAIN_FEATURE_API) {
  log.warn('BRAIN_FEATURE_API is false: the brain API is switched off on this installation; exiting');
  process.exit(0);
}
const pool = createPool(config.STATE_DATABASE_URL);
const store = new BrainStore(pool);
await store.init();
await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
await migrate(pool, 'runtime', RUNTIME_MIGRATIONS_DIR);

const embeddings = config.BRAIN_FEATURE_SEMANTIC_SEARCH === 'false' ? undefined : embeddingProviderFromConfig(config);
if (config.BRAIN_FEATURE_SEMANTIC_SEARCH === 'true' && !embeddings) throw new Error('BRAIN_FEATURE_SEMANTIC_SEARCH=true needs an embedding provider (GEMINI_API_KEY or EMBEDDING_PROVIDER=mock)');
if (!embeddings) log.warn('No embedding provider: search is keyword-only (set GEMINI_API_KEY for semantic search, D53)');

const chat = new MattermostChatClient(chatApiUrl(config), config.MM_BRIDGE_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND });
const adminChat = new MattermostChatClient(chatApiUrl(config), config.MM_ADMIN_TOKEN, { requestsPerSecond: config.MM_REQUESTS_PER_SECOND });
const botUserId = (await chat.getMe()).id;
const keyStore = new KeyStore(pool, config.KEY_ENCRYPTION_KEY);
const people = new PeopleService({ store, chat, pool, log });
const access = new AccessService(chat, store, people);
const files = new DatabaseFileStore(pool);
const jobs = startJobRunner({ pool, log, tickMs: 60_000 });
const worker = embeddings ? startEmbeddingWorker({ store, embeddings, log, intervalMs: config.EMBED_INTERVAL_SECONDS * 1000, batchSize: config.EMBED_BATCH_SIZE }) : undefined;

const app = await buildApp({
  config,
  pool,
  store,
  embeddings,
  chat,
  adminChat,
  relay: new BuzzRelayClient(config.RELAY_HTTP_URL, { perKeyPerSecond: config.RELAY_REQUESTS_PER_SECOND }),
  keyStore,
  bridgeSigner: signerFromHex(config.BRIDGE_SECRET_KEY),
  access,
  tokens: new TokenSigner(config.BRAIN_SESSION_SECRET),
  people,
  files,
  jobs,
  botUserId,
  teamName: config.MM_TEAM_NAME,
  log,
  readiness: { mattermost: async () => (await chat.getMe()).id === botUserId },
});

registerPhase1Jobs({ config, store, people, chat, jobs, log, botUserId });

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  jobs.stop();
  void Promise.all([app.close(), worker?.stop()])
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await app.listen({ host: config.BRAIN_API_HOST, port: config.BRAIN_API_PORT });
log.info({ host: config.BRAIN_API_HOST, port: config.BRAIN_API_PORT, publicUrl: config.BRAIN_PUBLIC_URL, pages: Boolean(config.BRAIN_WEB_DIR), semantic: embeddings !== undefined }, 'Brain API listening');
