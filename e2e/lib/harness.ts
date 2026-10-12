// Shared setup for end-to-end tests against the local stack (`pnpm dev:up && pnpm dev:seed`).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { AgentRuntime, EchoAgent, provisionAgent, providersFromConfig, runtimeConfigSchema, type AgentRecord, type ProvisionInput } from '@brain/agent-runtime';
import { BrainStore, DatabaseFileStore, PostgresBrainClient } from '@brain/brain';
import { AccessService, brainApiConfigSchema, buildApp, PeopleService, registerPhase1Jobs, startEmbeddingWorker, startJobRunner, TokenSigner, type BrainApiConfig, type EmbeddingWorker, type JobRunner } from '@brain/brain-api';
import { Bridge, BridgeStore, bridgeConfigSchema, type BridgeConfig } from '@brain/bridge';
import { embeddingProviderFromConfig } from '@brain/models';
import { Ingestion, ingestionConfigSchema } from '@brain/ingestion';
import { MattermostApi, type MmPost, type MmUser } from '@brain/scripts/lib/mattermost.ts';
import {
  BuzzRelayClient,
  createLogger,
  createPool,
  generateSecretKeyBytes,
  IdentityRepository,
  KeyStore,
  loadDotEnv,
  MattermostChatClient,
  nowSeconds,
  NullBrainClient,
  parseConfig,
  relayChannelIdFor,
  SecretKeySigner,
  signerFromHex,
  tagValue,
  type BrainClient,
  type Logger,
  type NostrEvent,
  type Pool,
  type Signer,
} from '@brain/shared';

// Load .env when the harness is imported, so `it.skipIf(!process.env.ANTHROPIC_API_KEY)` sees a key kept there.
loadDotEnv();

export async function waitFor<T>(probe: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function uniqueName(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

export interface MmSession {
  api: MattermostApi;
  user: MmUser;
}

/** Long-lived resources shared by a test file: config, database, relay access and Mattermost sessions. */
export class Stack {
  readonly config: BridgeConfig;
  readonly pool: Pool;
  readonly relay: BuzzRelayClient;
  readonly reader: Signer;
  readonly bridgeSigner: Signer;
  readonly store: BridgeStore;
  readonly identities: IdentityRepository;
  /** The knowledge store that ingestion fills and agents search. */
  readonly brain: PostgresBrainClient;
  readonly env: Record<string, string | undefined>;
  #teamId: string | undefined;
  readonly #created: string[] = [];

  constructor(overrides: Record<string, string> = {}) {
    loadDotEnv();
    // Ops endpoints on free ports, so services started in one process do not collide. Capture stays opt-in (D5)
    // unless a test asks for the sweep (D50), so the other tests keep control over which channels @brain joins.
    this.env = { ...process.env, CATCH_UP_INTERVAL_SECONDS: '60', BRIDGE_OPS_PORT: '0', RUNTIME_OPS_PORT: '0', INGESTION_OPS_PORT: '0', BRAIN_CAPTURE_CHANNELS: 'opt-in', CAPTURE_SWEEP_SECONDS: '5', ...overrides };
    this.config = parseConfig(bridgeConfigSchema, this.env);
    this.pool = createPool(this.config.STATE_DATABASE_URL);
    this.relay = new BuzzRelayClient(this.config.RELAY_HTTP_URL, { perKeyPerSecond: this.config.RELAY_REQUESTS_PER_SECOND });
    this.reader = signerFromHex(this.config.READER_SECRET_KEY);
    this.bridgeSigner = signerFromHex(this.config.BRIDGE_SECRET_KEY);
    this.store = new BridgeStore(this.pool);
    this.identities = new IdentityRepository(this.pool);
    this.brain = new PostgresBrainClient(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async login(username: string): Promise<MmSession> {
    const password = username === this.env.MM_ADMIN_USERNAME ? this.env.MM_ADMIN_PASSWORD : this.env.MM_PERSON_PASSWORD;
    const api = await new MattermostApi(this.config.MM_URL).login(username, password ?? '');
    return { api, user: await api.get<MmUser>('/users/me') };
  }

  async botUserId(): Promise<string> {
    return (await new MattermostApi(this.config.MM_URL, this.config.MM_BRIDGE_TOKEN).get<MmUser>('/users/me')).id;
  }

  async teamId(): Promise<string> {
    this.#teamId ??= (await new MattermostApi(this.config.MM_URL, this.config.MM_BRIDGE_TOKEN).get<{ id: string }>(`/teams/name/${this.env.MM_TEAM_NAME}`)).id;
    return this.#teamId;
  }

  async createChannel(owner: MmSession, type: 'O' | 'P', label: string, members: string[] = []): Promise<{ id: string; name: string }> {
    const name = uniqueName(label);
    const channel = await owner.api.post<{ id: string; name: string }>('/channels', { team_id: await this.teamId(), name, display_name: name, type });
    this.#created.push(channel.id);
    for (const userId of members) await owner.api.post(`/channels/${channel.id}/members`, { user_id: userId });
    return channel;
  }

  /** Archive the channels this Stack created, so test runs do not pile up active channels. */
  async archiveCreatedChannels(): Promise<void> {
    const admin = await this.login(this.env.MM_ADMIN_USERNAME ?? '');
    for (const id of this.#created.splice(0)) await admin.api.delete(`/channels/${id}`).catch(() => undefined);
  }

  /** Upload a file to a channel as `session`; returns its file id. */
  async uploadFile(session: MmSession, channelId: string, name: string, content: string): Promise<string> {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([content]), name);
    const response = await fetch(`${this.config.MM_URL}/api/v4/files`, { method: 'POST', headers: { Authorization: `Bearer ${session.api.token ?? ''}` }, body: form });
    if (!response.ok) throw new Error(`File upload failed: ${response.status}`);
    return ((await response.json()) as { file_infos: { id: string }[] }).file_infos[0]!.id;
  }

  /** Pubkeys in a mirrored channel's relay member list (kind 39002), read as the channel owner. */
  async relayMembers(mmChannelId: string): Promise<Set<string>> {
    const [list] = await this.relay.query([{ kinds: [39002], '#d': [relayChannelIdFor(mmChannelId)], limit: 1 }], this.bridgeSigner);
    return new Set(list ? list.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]!) : []);
  }

  /** A mirrored channel's relay metadata (kind 39000), read as the channel owner. */
  async relayMetadata(mmChannelId: string): Promise<NostrEvent | undefined> {
    const [metadata] = await this.relay.query([{ kinds: [39000], '#d': [relayChannelIdFor(mmChannelId)], limit: 1 }], this.bridgeSigner);
    return metadata;
  }

  /** Add @brain to a channel and wait until the bridge has enabled it. */
  async enable(owner: MmSession, channelId: string): Promise<void> {
    await owner.api.post(`/channels/${channelId}/members`, { user_id: await this.botUserId() });
    await waitFor(async () => (await this.store.getChannel(channelId))?.state === 'active');
  }

  post(session: MmSession, channelId: string, message: string, rootId?: string): Promise<MmPost> {
    return session.api.post<MmPost>('/posts', { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) });
  }

  /** Relay events for a Mattermost post: the channel's events, filtered on the `mm` tag here (the relay ignores `#mm` filters). */
  async eventsForPost(mmChannelId: string, postId: string, kinds = [9], as: Signer = this.reader): Promise<NostrEvent[]> {
    const events = await this.relay.query([{ kinds, '#h': [relayChannelIdFor(mmChannelId)], limit: 1000 }], as);
    return events.filter((event) => tagValue(event, 'mm') === postId);
  }

  async waitForEventForPost(mmChannelId: string, postId: string, kinds = [9]): Promise<NostrEvent> {
    return waitFor(async () => (await this.eventsForPost(mmChannelId, postId, kinds))[0]);
  }

  /** A fresh key that is a relay member but belongs to no channel. */
  async outsider(): Promise<Signer> {
    const signer = new SecretKeySigner(generateSecretKeyBytes());
    await this.relay.publish(this.bridgeSigner.sign({ kind: 9030, tags: [['p', signer.pubkey]], content: '', created_at: nowSeconds() }), this.bridgeSigner);
    return signer;
  }

  readonly keyStore = (): KeyStore => new KeyStore(this.pool, this.config.KEY_ENCRYPTION_KEY);

  log(name: string): Logger {
    return createLogger(name, process.env.E2E_LOG_LEVEL ?? 'silent');
  }

  newBridge(): Bridge {
    return new Bridge({
      config: this.config,
      pool: this.pool,
      chat: new MattermostChatClient(this.config.MM_URL, this.config.MM_BRIDGE_TOKEN),
      relay: this.relay,
      keyStore: this.keyStore(),
      log: this.log('bridge-e2e'),
    });
  }

  /** Provision (or re-provision) an agent the way `pnpm agent:provision` does. */
  provision(input: ProvisionInput): Promise<AgentRecord> {
    return provisionAgent(
      {
        pool: this.pool,
        chat: new MattermostChatClient(this.config.MM_URL, this.env.MM_ADMIN_TOKEN ?? ''),
        relay: this.relay,
        keyStore: this.keyStore(),
        bridgeSigner: this.bridgeSigner,
        teamName: this.env.MM_TEAM_NAME ?? '',
        log: this.log('provision-e2e'),
      },
      input,
    );
  }

  /** Start ingestion in-process, filling `this.brain`; `overrides` replace settings from .env. */
  async startIngestion(overrides: Record<string, string> = {}): Promise<Ingestion> {
    await this.brain.init();
    const config = parseConfig(ingestionConfigSchema, { ...this.env, ...overrides });
    const ingestion = new Ingestion({ config, pool: this.pool, relay: this.relay, brain: this.brain, log: this.log('ingestion-e2e') });
    await ingestion.start();
    return ingestion;
  }

  /** Start the agent runtime in-process; `overrides` replace settings from .env. Without `brain` it finds nothing. */
  async startRuntime(overrides: Record<string, string> = {}, brain: BrainClient = new NullBrainClient()): Promise<AgentRuntime> {
    const config = parseConfig(runtimeConfigSchema, { ...this.env, ...overrides });
    const runtime = new AgentRuntime({
      config,
      pool: this.pool,
      relay: this.relay,
      keyStore: this.keyStore(),
      brain,
      providerFor: providersFromConfig(config),
      log: this.log('runtime-e2e'),
    });
    await runtime.start();
    return runtime;
  }

  async startEcho(agent: AgentRecord): Promise<EchoAgent> {
    const echo = new EchoAgent({
      relay: this.relay,
      keyStore: this.keyStore(),
      readerSigner: this.reader,
      agent,
      relayWsUrl: this.config.RELAY_WS_URL,
      log: this.log('echo-e2e'),
      maxEventAgeSeconds: 600,
      overlapSeconds: 600,
    });
    await echo.start();
    return echo;
  }

  /** Posts in a Mattermost thread (root included), oldest first. */
  async thread(session: MmSession, rootId: string): Promise<MmPost[]> {
    const thread = await session.api.get<{ posts: Record<string, MmPost> }>(`/posts/${rootId}/thread`);
    return Object.values(thread.posts).sort((a, b) => a.create_at - b.create_at);
  }

  /** Restart the Mattermost container and wait until it answers again. */
  async restartMattermost(): Promise<void> {
    execFileSync('docker', ['restart', 'enterprise-brain-mattermost-1'], { stdio: 'ignore' });
    await waitFor(async () => (await fetch(`${this.config.MM_URL}/api/v4/system/ping`).catch(() => undefined))?.ok, 180_000, 1000);
  }

  /** Restart the relay container and wait until it is ready again. */
  async restartRelay(): Promise<void> {
    execFileSync('docker', ['restart', 'enterprise-brain-relay-1'], { stdio: 'ignore' });
    await waitFor(async () => (await fetch(`${this.config.RELAY_HTTP_URL}/_readiness`).catch(() => undefined))?.ok, 120_000, 1000);
  }

  async startBridge(): Promise<Bridge> {
    const bridge = this.newBridge();
    await bridge.start();
    await bridge.ready;
    return bridge;
  }

  /**
   * Start the brain API in-process on a free port, with the mock embedding provider, reachable by browsers at
   * `url` and by Mattermost (in Docker) at `internalUrl`. Register it with Mattermost through
   * `POST /api/v1/brain/setup/mattermost` when a test needs the command or sign-in paths.
   */
  async startBrainApi(overrides: Record<string, string> = {}): Promise<BrainApiHandle> {
    const port = await freePort();
    const config = parseConfig(brainApiConfigSchema, {
      ...this.env,
      BRAIN_API_PORT: String(port),
      BRAIN_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BRAIN_INTERNAL_URL: `http://host.docker.internal:${port}`,
      BRAIN_WEB_DIR: '',
      EMBEDDING_PROVIDER: 'mock',
      ...overrides,
    });
    const store = new BrainStore(this.pool);
    await store.init();
    const chat = new MattermostChatClient(config.MM_URL, config.MM_BRIDGE_TOKEN);
    const adminChat = new MattermostChatClient(config.MM_URL, config.MM_ADMIN_TOKEN);
    const botUserId = (await chat.getMe()).id;
    const embeddings = embeddingProviderFromConfig(config);
    const log = this.log('brain-api-e2e');
    const people = new PeopleService({ store, chat, pool: this.pool, log });
    const access = new AccessService(chat, store, people);
    const tokens = new TokenSigner(config.BRAIN_SESSION_SECRET);
    const files = new DatabaseFileStore(this.pool);
    // Jobs run only when a test ticks them (`jobs.tick(now)`), never on a timer.
    const jobs = startJobRunner({ pool: this.pool, log, tickMs: 60_000, enabled: false });
    const app = await buildApp({ config, pool: this.pool, store, embeddings, chat, adminChat, relay: this.relay, keyStore: this.keyStore(), bridgeSigner: this.bridgeSigner, access, tokens, people, files, jobs, botUserId, teamName: this.env.MM_TEAM_NAME ?? '', log });
    registerPhase1Jobs({ config, store, people, chat, jobs, log, botUserId });
    const worker = embeddings ? startEmbeddingWorker({ store, embeddings, log, intervalMs: 500, batchSize: 64 }) : undefined;
    await app.listen({ host: '0.0.0.0', port });
    return {
      url: config.BRAIN_PUBLIC_URL,
      internalUrl: config.BRAIN_INTERNAL_URL,
      token: config.BRAIN_API_TOKEN,
      config,
      store,
      access,
      tokens,
      worker,
      people,
      jobs,
      stop: async () => {
        jobs.stop();
        await worker?.stop();
        await app.close();
      },
    };
  }
}

export interface BrainApiHandle {
  url: string;
  internalUrl: string;
  token: string;
  config: BrainApiConfig;
  store: BrainStore;
  access: AccessService;
  tokens: TokenSigner;
  worker: EmbeddingWorker | undefined;
  people: PeopleService;
  jobs: JobRunner;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
