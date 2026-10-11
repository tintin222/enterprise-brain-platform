// Shared setup for end-to-end tests against the local stack (`pnpm dev:up && pnpm dev:seed`).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EchoAgent, provisionAgent, type AgentRecord, type ProvisionInput } from '@brain/agent-runtime';
import { Bridge, BridgeStore, bridgeConfigSchema, type BridgeConfig } from '@brain/bridge';
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
  parseConfig,
  relayChannelIdFor,
  SecretKeySigner,
  signerFromHex,
  tagValue,
  type Logger,
  type NostrEvent,
  type Pool,
  type Signer,
} from '@brain/shared';

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
  readonly env: Record<string, string | undefined>;
  #teamId: string | undefined;

  constructor(overrides: Record<string, string> = {}) {
    loadDotEnv();
    this.env = { ...process.env, CATCH_UP_INTERVAL_SECONDS: '5', ...overrides };
    this.config = parseConfig(bridgeConfigSchema, this.env);
    this.pool = createPool(this.config.STATE_DATABASE_URL);
    this.relay = new BuzzRelayClient(this.config.RELAY_HTTP_URL);
    this.reader = signerFromHex(this.config.READER_SECRET_KEY);
    this.bridgeSigner = signerFromHex(this.config.BRIDGE_SECRET_KEY);
    this.store = new BridgeStore(this.pool);
    this.identities = new IdentityRepository(this.pool);
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
    for (const userId of members) await owner.api.post(`/channels/${channel.id}/members`, { user_id: userId });
    return channel;
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
}
