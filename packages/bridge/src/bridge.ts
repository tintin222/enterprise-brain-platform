// The bridge service: Mattermost WebSocket + REST catch-up in, relay events out (docs/bridge-spec.md).
import {
  errorFields,
  IDENTITY_MIGRATIONS_DIR,
  IdentityRepository,
  KeyedQueue,
  migrate,
  postFromEvent,
  retry,
  signerFromHex,
  type ChatClient,
  type ChatEvent,
  type ChatEventStream,
  type KeyStore,
  type Logger,
  type MmPost,
  type Pool,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import { ChannelService, cursorStream } from './channels.ts';
import type { BridgeConfig } from './config.ts';
import { IdentityService } from './identities.ts';
import { MmToRelay } from './mm-to-relay.ts';
import { OutboxPublisher } from './publisher.ts';
import { BRIDGE_MIGRATIONS_DIR, BridgeStore } from './store.ts';

/** Catch-up re-reads this much before the cursor, to cover clock skew between host and Mattermost. */
const CURSOR_MARGIN_MS = 30_000;

export interface BridgeDeps {
  config: BridgeConfig;
  pool: Pool;
  chat: ChatClient;
  relay: RelayClient;
  keyStore: KeyStore;
  log: Logger;
}

interface Services {
  botUserId: string;
  identities: IdentityService;
  channels: ChannelService;
  mirror: MmToRelay;
  publisher: OutboxPublisher;
}

export class Bridge {
  readonly store: BridgeStore;
  readonly bridgeSigner: Signer;
  readonly readerSigner: Signer;
  readonly ready: Promise<void>;
  readonly #deps: BridgeDeps;
  readonly #queue = new KeyedQueue();
  #services: Services | undefined;
  #events: ChatEventStream | undefined;
  #timer: NodeJS.Timeout | undefined;
  #resolveReady!: () => void;
  #stopped = false;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
    this.store = new BridgeStore(deps.pool);
    this.bridgeSigner = signerFromHex(deps.config.BRIDGE_SECRET_KEY);
    this.readerSigner = signerFromHex(deps.config.READER_SECRET_KEY);
    this.ready = new Promise((resolve) => (this.#resolveReady = resolve));
  }

  get services(): Services {
    if (!this.#services) throw new Error('Bridge not started');
    return this.#services;
  }

  async start(): Promise<void> {
    const { pool, chat, relay, keyStore, log, config } = this.#deps;
    await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
    await migrate(pool, 'bridge', BRIDGE_MIGRATIONS_DIR);
    const me = await chat.getMe();
    const identities = new IdentityService({ identities: new IdentityRepository(pool), keyStore, relay, chat, bridgeSigner: this.bridgeSigner, log });
    const channels = new ChannelService({ chat, relay, store: this.store, identities, bridgeSigner: this.bridgeSigner, readerPubkey: this.readerSigner.pubkey, botUserId: me.id, log });
    const signerFor = async (pubkey: string): Promise<Signer> => (pubkey === this.bridgeSigner.pubkey ? this.bridgeSigner : keyStore.signerFor(pubkey));
    const publisher = new OutboxPublisher({
      pool,
      store: this.store,
      relay,
      signerFor,
      log,
      completions: {
        post: async (row, tx) => {
          await this.store.insertMessage({ relayEventId: row.relayEventId, mmPostId: row.mmPostId, origin: 'mm', mmChannelId: row.mmChannelId, authorMmUserId: row.authorMmUserId }, tx);
        },
      },
    });
    const mirror = new MmToRelay({ chat, store: this.store, identities, channels, publisher, botUserId: me.id, log });
    this.#services = { botUserId: me.id, identities, channels, mirror, publisher };

    await publisher.drain();
    await this.syncChannels();
    this.#events = chat.connectEvents(
      {
        onEvent: (event) => {
          this.handleEvent(event).catch((error: unknown) => log.error({ event: event.event, ...errorFields(error) }, 'Event handling failed'));
        },
        onConnected: () => {
          this.catchUpAll()
            .catch((error: unknown) => log.error(errorFields(error), 'Catch-up failed'))
            .finally(() => this.#resolveReady());
        },
      },
      log,
    );
    this.#timer = setInterval(() => {
      this.catchUpAll().catch((error: unknown) => log.error(errorFields(error), 'Periodic catch-up failed'));
    }, config.CATCH_UP_INTERVAL_SECONDS * 1000);
    log.info({ botUserId: me.id }, 'Bridge started');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#events?.close();
    await this.#queue.idle();
    this.#deps.log.info('Bridge stopped');
  }

  /** Enable every channel @brain belongs to; pause mapped channels it has left. */
  async syncChannels(): Promise<void> {
    const { chat } = this.#deps;
    const { channels } = this.services;
    const memberOf = new Set<string>();
    for (const team of await chat.getMyTeams()) {
      for (const channel of await chat.getMyChannels(team.id)) {
        if (channel.type !== 'O' && channel.type !== 'P') continue;
        memberOf.add(channel.id);
        const row = await this.store.getChannel(channel.id);
        if (row?.state !== 'active') await this.#queue.run(channel.id, () => channels.enable(channel.id));
      }
    }
    for (const row of await this.store.listChannels('active')) {
      if (!memberOf.has(row.mmChannelId)) await this.#queue.run(row.mmChannelId, () => channels.pause(row.mmChannelId));
    }
  }

  /** Handle one Mattermost WebSocket event. Resolves when its processing is done. */
  async handleEvent(event: ChatEvent): Promise<void> {
    if (this.#stopped) return;
    const { botUserId, channels } = this.services;
    const channelId = event.broadcast.channel_id;
    switch (event.event) {
      case 'posted': {
        const post = postFromEvent(event);
        if (post) await this.#queue.run(post.channel_id, () => this.#processPost(post));
        return;
      }
      case 'user_added':
        if (channelId && event.data.user_id === botUserId) await this.#queue.run(channelId, async () => void (await channels.enable(channelId)));
        return;
      case 'user_removed':
        if (channelId && (event.data.user_id ?? event.broadcast.user_id) === botUserId) await this.#queue.run(channelId, () => channels.pause(channelId));
        return;
      default:
        return;
    }
  }

  async #processPost(post: MmPost): Promise<void> {
    const { mirror } = this.services;
    try {
      await retry(() => mirror.mirrorPost(post), {
        attempts: 3,
        baseMs: 1000,
        maxMs: 10_000,
        onRetry: (error, attempt) => this.#deps.log.warn({ mmPostId: post.id, attempt, ...errorFields(error) }, 'Mirroring a post failed; retrying'),
      });
    } catch (error) {
      this.#deps.log.error({ mmPostId: post.id, ...errorFields(error) }, 'Mirroring a post failed; dead-lettering');
      await this.store.deadLetter('mm_to_relay', { mmPostId: post.id, mmChannelId: post.channel_id }, error instanceof Error ? error.message : String(error), 3);
    }
  }

  /** Re-read a channel from its cursor and mirror anything missed (docs/bridge-spec.md section 8). */
  catchUpChannel(mmChannelId: string): Promise<void> {
    return this.#queue.run(mmChannelId, async () => {
      const channel = await this.store.getChannel(mmChannelId);
      if (channel?.state !== 'active') return;
      const enabledAt = channel.enabledAt.getTime();
      const cursor = (await this.store.getCursor(cursorStream(mmChannelId))) ?? enabledAt;
      const startedAt = Date.now();
      const posts = await this.#deps.chat.getPostsSince(mmChannelId, Math.max(0, cursor - CURSOR_MARGIN_MS));
      for (const post of posts) {
        if (post.create_at < enabledAt) continue;
        await this.#processPost(post);
      }
      await this.store.setCursor(cursorStream(mmChannelId), Math.max(enabledAt, startedAt - CURSOR_MARGIN_MS));
    });
  }

  async catchUpAll(): Promise<void> {
    const channels = await this.store.listChannels('active');
    await Promise.all(channels.map((channel) => this.catchUpChannel(channel.mmChannelId)));
  }
}
