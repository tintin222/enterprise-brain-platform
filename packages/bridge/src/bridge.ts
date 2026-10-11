// The bridge service (docs/bridge-spec.md). Mattermost -> relay: WebSocket events plus REST catch-up.
// Relay -> Mattermost: one live subscription per active channel plus relay catch-up.
import {
  errorFields,
  IDENTITY_MIGRATIONS_DIR,
  IdentityRepository,
  KeyedQueue,
  migrate,
  nowSeconds,
  postFromEvent,
  RelaySubscriber,
  retry,
  signerFromHex,
  type ChatClient,
  type ChatEvent,
  type ChatEventStream,
  type Filter,
  type KeyStore,
  type Logger,
  type MmPost,
  type NostrEvent,
  type Pool,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import { ChannelService, cursorStream } from './channels.ts';
import type { BridgeConfig } from './config.ts';
import { IdentityService } from './identities.ts';
import { MmToRelay } from './mm-to-relay.ts';
import { OutboxPublisher } from './publisher.ts';
import { RelayToMm } from './relay-to-mm.ts';
import { BRIDGE_MIGRATIONS_DIR, BridgeStore, type ChannelRow } from './store.ts';

/** Mattermost catch-up re-reads this much before its cursor, to cover clock skew. */
const CURSOR_MARGIN_MS = 30_000;
/** Relay kinds the bridge mirrors back into Mattermost. */
export const RELAY_TO_MM_KINDS = [9, 40003, 5, 9005, 7];

export function relayCursorStream(relayChannelId: string): string {
  return `relay:${relayChannelId}`;
}

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
  relayToMm: RelayToMm;
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
  #subscriber: RelaySubscriber | undefined;
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
    const relayToMm = new RelayToMm({ chat, store: this.store, identities, keyStore, relay, readerSigner: this.readerSigner, log });
    this.#services = { botUserId: me.id, identities, channels, mirror, relayToMm, publisher };

    await publisher.drain();
    this.#subscriber = new RelaySubscriber({
      url: config.RELAY_WS_URL,
      signer: this.readerSigner,
      log,
      onEvent: (key, event) => {
        this.#onRelayEvent(key, event).catch((error: unknown) => log.error({ relayEventId: event.id, ...errorFields(error) }, 'Relay event handling failed'));
      },
      onActive: (relayChannelId) => {
        // Catch up once the relay confirms the subscription, so no agent message falls in between.
        void this.store
          .getChannelByRelayId(relayChannelId)
          .then((channel) => (channel ? this.relayCatchUpChannel(channel) : undefined))
          .catch((error: unknown) => log.error({ relayChannelId, ...errorFields(error) }, 'Relay catch-up failed'));
      },
    });
    await this.syncChannels();
    for (const channel of await this.store.listChannels('active')) this.#subscribe(channel);

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
      Promise.all([this.catchUpAll(), this.relayCatchUpAll()]).catch((error: unknown) => log.error(errorFields(error), 'Periodic catch-up failed'));
    }, config.CATCH_UP_INTERVAL_SECONDS * 1000);
    log.info({ botUserId: me.id }, 'Bridge started');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#events?.close();
    this.#subscriber?.close();
    await this.#queue.idle();
    this.#deps.log.info('Bridge stopped');
  }

  #subscribe(channel: ChannelRow): void {
    const filter: Filter = { kinds: RELAY_TO_MM_KINDS, '#h': [channel.relayChannelId], limit: 0 };
    this.#subscriber?.subscribe(channel.relayChannelId, filter);
  }

  async #enable(mmChannelId: string): Promise<void> {
    const row = await this.services.channels.enable(mmChannelId);
    if (row) this.#subscribe(row);
  }

  async #pause(mmChannelId: string): Promise<void> {
    const row = await this.store.getChannel(mmChannelId);
    await this.services.channels.pause(mmChannelId);
    if (row) this.#subscriber?.unsubscribe(row.relayChannelId);
  }

  /** Enable every channel @brain belongs to; pause mapped channels it has left. */
  async syncChannels(): Promise<void> {
    const { chat } = this.#deps;
    const memberOf = new Set<string>();
    for (const team of await chat.getMyTeams()) {
      for (const channel of await chat.getMyChannels(team.id)) {
        if (channel.type !== 'O' && channel.type !== 'P') continue;
        memberOf.add(channel.id);
        const row = await this.store.getChannel(channel.id);
        if (row?.state !== 'active') await this.#queue.run(channel.id, () => this.#enable(channel.id));
      }
    }
    for (const row of await this.store.listChannels('active')) {
      if (!memberOf.has(row.mmChannelId)) await this.#queue.run(row.mmChannelId, () => this.#pause(row.mmChannelId));
    }
  }

  /** Handle one Mattermost WebSocket event. Resolves when its processing is done. */
  async handleEvent(event: ChatEvent): Promise<void> {
    if (this.#stopped) return;
    const { botUserId } = this.services;
    const channelId = event.broadcast.channel_id;
    switch (event.event) {
      case 'posted': {
        const post = postFromEvent(event);
        if (post) await this.#queue.run(post.channel_id, () => this.#processPost(post));
        return;
      }
      case 'user_added': {
        const userId = typeof event.data.user_id === 'string' ? event.data.user_id : '';
        if (!channelId || !userId) return;
        if (userId === botUserId) await this.#queue.run(channelId, () => this.#enable(channelId));
        else await this.#queue.run(channelId, () => this.#memberJoined(channelId, userId));
        return;
      }
      case 'user_removed': {
        const userId = typeof event.data.user_id === 'string' ? event.data.user_id : (event.broadcast.user_id ?? '');
        if (!channelId || !userId) return;
        if (userId === botUserId) await this.#queue.run(channelId, () => this.#pause(channelId));
        else await this.#queue.run(channelId, () => this.#memberLeft(channelId, userId));
        return;
      }
      default:
        return;
    }
  }

  async #memberJoined(mmChannelId: string, mmUserId: string): Promise<void> {
    const channel = await this.store.getChannel(mmChannelId);
    if (channel?.state !== 'active') return;
    const identity = await this.services.identities.forUserId(mmUserId);
    if (identity) await this.services.channels.ensureMember(channel, identity.pubkey);
  }

  async #memberLeft(mmChannelId: string, mmUserId: string): Promise<void> {
    const channel = await this.store.getChannel(mmChannelId);
    if (channel?.state !== 'active') return;
    const identity = await this.services.identities.existing(mmUserId);
    if (identity) await this.services.channels.removeMember(channel, identity.pubkey);
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

  async #onRelayEvent(relayChannelId: string, event: NostrEvent): Promise<void> {
    const channel = await this.store.getChannelByRelayId(relayChannelId);
    if (!channel) return;
    await this.#queue.run(channel.mmChannelId, () => this.#processRelayEvent(channel, event));
  }

  /** Handle one relay event for a channel (public for tests). */
  async handleRelayEvent(relayChannelId: string, event: NostrEvent): Promise<void> {
    await this.#onRelayEvent(relayChannelId, event);
  }

  async #processRelayEvent(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const current = (await this.store.getChannel(channel.mmChannelId)) ?? channel;
    try {
      await retry(() => this.services.relayToMm.handle(current, event), {
        attempts: 3,
        baseMs: 1000,
        maxMs: 10_000,
        onRetry: (error, attempt) => this.#deps.log.warn({ relayEventId: event.id, attempt, ...errorFields(error) }, 'Mirroring a relay event failed; retrying'),
      });
    } catch (error) {
      this.#deps.log.error({ relayEventId: event.id, ...errorFields(error) }, 'Mirroring a relay event failed; dead-lettering');
      await this.store.deadLetter('relay_to_mm', { relayChannelId: channel.relayChannelId, event }, error instanceof Error ? error.message : String(error), 3);
    }
  }

  /** Re-read a Mattermost channel from its cursor and mirror anything missed (docs/bridge-spec.md section 8). */
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

  /** Re-read agents' relay events for a channel from its cursor minus the overlap window. */
  relayCatchUpChannel(channel: ChannelRow): Promise<void> {
    return this.#queue.run(channel.mmChannelId, async () => {
      const agents = (await new IdentityRepository(this.#deps.pool).listByKind('agent')).map((identity) => identity.pubkey);
      if (agents.length === 0) return;
      const stream = relayCursorStream(channel.relayChannelId);
      const cursor = (await this.store.getCursor(stream)) ?? Math.floor(channel.enabledAt.getTime() / 1000);
      const startedAt = nowSeconds();
      const events: NostrEvent[] = [];
      const filter: Filter = { kinds: RELAY_TO_MM_KINDS, '#h': [channel.relayChannelId], authors: agents, since: Math.max(0, cursor - this.#deps.config.RELAY_OVERLAP_SECONDS) };
      for await (const event of this.#deps.relay.queryAll(filter, this.readerSigner)) events.push(event);
      events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      for (const event of events) await this.#processRelayEvent(channel, event);
      await this.store.setCursor(stream, startedAt);
    });
  }

  async relayCatchUpAll(): Promise<void> {
    const channels = await this.store.listChannels('active');
    await Promise.all(channels.map((channel) => this.relayCatchUpChannel(channel)));
  }
}
