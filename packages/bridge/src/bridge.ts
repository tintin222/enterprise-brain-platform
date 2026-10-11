// The bridge service (docs/bridge-spec.md). Mattermost -> relay: WebSocket events plus REST catch-up.
// Relay -> Mattermost: one live subscription per active channel plus relay catch-up. A periodic
// reconciliation repairs channel state, membership and metadata that events missed (section 8).
import {
  channelFromEvent,
  CoalescedTask,
  DistinctSigner,
  errorFields,
  IDENTITY_MIGRATIONS_DIR,
  IdentityRepository,
  KeyedQueue,
  migrate,
  nowSeconds,
  postFromEvent,
  reactionFromEvent,
  RelaySubscriber,
  retry,
  signerFromHex,
  tagValue,
  tagValues,
  type ChatClient,
  type ChatEvent,
  type ChatEventStream,
  type Filter,
  type KeyStore,
  type Logger,
  type MmChannel,
  type MmPost,
  type NostrEvent,
  type Pool,
  type RecentEvents,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import { backfillStream, ChannelService, cursorStream } from './channels.ts';
import type { BridgeConfig } from './config.ts';
import { IdentityService } from './identities.ts';
import { MmToRelay, type PostSource, type SyncOptions } from './mm-to-relay.ts';
import { OutboxPublisher } from './publisher.ts';
import { RelayToMm } from './relay-to-mm.ts';
import { BRIDGE_MIGRATIONS_DIR, BridgeStore, type ChannelRow } from './store.ts';

/** Mattermost catch-up re-reads this much before its cursor, to cover clock skew. */
const CURSOR_MARGIN_MS = 30_000;
/** Relay kinds the bridge mirrors back into Mattermost. */
export const RELAY_TO_MM_KINDS = [9, 40003, 5, 9005, 7, 20002];
/** Mattermost returns at most 200 posts per page. */
const BACKFILL_PAGE_SIZE = 200;

/** One cursor for relay catch-up across all channels (a Unix time in seconds). */
export const RELAY_CURSOR_STREAM = 'relay:all';

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

export interface ReconcileReport {
  channels: number;
  membersAdded: number;
  membersRemoved: number;
  metadataUpdated: number;
  /** Agent bots that are members of Mattermost channels where @brain is not (Q2): they cannot respond there. */
  agentsOutside: { agentMmUserId: string; mmChannelId: string }[];
}

export class Bridge {
  readonly store: BridgeStore;
  readonly bridgeSigner: Signer;
  readonly readerSigner: Signer;
  readonly ready: Promise<void>;
  readonly #deps: BridgeDeps;
  readonly #queue = new KeyedQueue();
  /** Shared by every signer the bridge uses, so a state toggled back never repeats an event exactly. */
  readonly #recentEvents: RecentEvents = new Map();
  #services: Services | undefined;
  #events: ChatEventStream | undefined;
  #subscriber: RelaySubscriber | undefined;
  #timers: NodeJS.Timeout[] = [];
  #resolveReady!: () => void;
  #stopped = false;
  readonly #relayCatchUp: CoalescedTask;
  readonly #reconcile: CoalescedTask;
  #lastReport: ReconcileReport | undefined;
  readonly #reportedOutside = new Set<string>();

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
    this.store = new BridgeStore(deps.pool);
    this.bridgeSigner = new DistinctSigner(signerFromHex(deps.config.BRIDGE_SECRET_KEY), this.#recentEvents);
    this.readerSigner = signerFromHex(deps.config.READER_SECRET_KEY);
    this.ready = new Promise((resolve) => (this.#resolveReady = resolve));
    this.#relayCatchUp = new CoalescedTask(
      () => this.#relayCatchUpRun(),
      (error) => deps.log.error(errorFields(error), 'Relay catch-up failed'),
    );
    this.#reconcile = new CoalescedTask(
      async () => {
        this.#lastReport = await this.#reconcileRun();
      },
      (error) => deps.log.error(errorFields(error), 'Reconciliation failed'),
    );
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
    const identities = new IdentityService({ identities: new IdentityRepository(pool), keyStore, relay, chat, bridgeSigner: this.bridgeSigner, recentEvents: this.#recentEvents, log });
    const channels = new ChannelService({ chat, relay, store: this.store, identities, bridgeSigner: this.bridgeSigner, readerPubkey: this.readerSigner.pubkey, botUserId: me.id, log });
    const signerFor = async (pubkey: string): Promise<Signer> =>
      pubkey === this.bridgeSigner.pubkey ? this.bridgeSigner : new DistinctSigner(await keyStore.signerFor(pubkey), this.#recentEvents);
    const store = this.store;
    const target = (event: NostrEvent): string | undefined => tagValue(event, 'e');
    const publisher = new OutboxPublisher({
      pool,
      store,
      relay,
      signerFor,
      log,
      completions: {
        post: async (row, tx) => {
          await store.insertMessage({ relayEventId: row.relayEventId, mmPostId: row.mmPostId, origin: 'mm', mmChannelId: row.mmChannelId, authorMmUserId: row.authorMmUserId, mmEditAt: Number(row.meta.editAt ?? 0) }, tx);
        },
        edit: async (row, tx) => {
          const id = target(row.signedEvent);
          if (id) await store.setMessageEditedInMm(id, Number(row.meta.editAt ?? 0), tx);
        },
        delete: async (row, tx) => {
          const id = target(row.signedEvent);
          if (id) await store.markMessageDeleted(id, tx);
        },
        reaction: async (row, tx) => {
          if (!row.mmPostId) return;
          await store.insertReaction(
            { mmPostId: row.mmPostId, mmUserId: row.authorMmUserId, emoji: String(row.meta.emoji), emojiName: String(row.meta.emojiName), relayEventId: row.relayEventId, origin: 'mm', mmChannelId: row.mmChannelId },
            tx,
          );
        },
        unreaction: async (row, tx) => {
          if (row.mmPostId) await store.deleteReaction({ mmPostId: row.mmPostId, mmUserId: row.authorMmUserId, emoji: String(row.meta.emoji) }, tx);
        },
      },
    });
    const mirror = new MmToRelay({ chat, relay, readerSigner: this.readerSigner, store, identities, channels, publisher, botUserId: me.id, bridgePubkey: this.bridgeSigner.pubkey, log });
    const relayToMm = new RelayToMm({ chat, store, identities, keyStore, relay, readerSigner: this.readerSigner, log });
    this.#services = { botUserId: me.id, identities, channels, mirror, relayToMm, publisher };

    await publisher.drain();
    this.#subscriber = new RelaySubscriber({
      url: config.RELAY_WS_URL,
      signer: this.readerSigner,
      log,
      onEvent: (key, event) => {
        this.#onRelayEvent(key, event).catch((error: unknown) => log.error({ relayEventId: event.id, ...errorFields(error) }, 'Relay event handling failed'));
      },
      // Catch up once the relay confirms a subscription, so no agent message falls in between. Many
      // subscriptions confirm at once on start; they share one (global) catch-up run.
      onActive: () => this.#relayCatchUp.schedule(1000),
    });
    await this.syncChannels();
    for (const channel of await this.store.listChannels('active')) {
      this.#subscribe(channel);
      // Resume a backfill a crash interrupted (a no-op once it has finished).
      void this.#queue.run(channel.mmChannelId, () => this.#backfill(channel)).catch((error: unknown) => log.error({ mmChannelId: channel.mmChannelId, ...errorFields(error) }, 'Backfill failed'));
    }

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
    this.#timers.push(
      setInterval(() => {
        Promise.all([this.catchUpAll(), this.relayCatchUp()]).catch((error: unknown) => log.error(errorFields(error), 'Periodic catch-up failed'));
      }, config.CATCH_UP_INTERVAL_SECONDS * 1000),
      setInterval(() => void this.#reconcile.run(), config.RECONCILE_INTERVAL_SECONDS * 1000),
    );
    void this.#reconcile.run();
    log.info({ botUserId: me.id }, 'Bridge started');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#relayCatchUp.cancel();
    this.#reconcile.cancel();
    this.#events?.close();
    this.#subscriber?.close();
    await Promise.all([this.#relayCatchUp.idle(), this.#reconcile.idle()]);
    await this.#queue.idle();
    this.#deps.log.info('Bridge stopped');
  }

  /** True once the relay confirmed the bridge's subscription for a mapped channel. */
  async relaySubscriptionActive(mmChannelId: string): Promise<boolean> {
    const channel = await this.store.getChannel(mmChannelId);
    return channel !== undefined && (this.#subscriber?.isActive(channel.relayChannelId) ?? false);
  }

  #subscribe(channel: ChannelRow): void {
    const filter: Filter = { kinds: RELAY_TO_MM_KINDS, '#h': [channel.relayChannelId], limit: 0 };
    this.#subscriber?.subscribe(channel.relayChannelId, filter);
  }

  async #enable(mmChannelId: string): Promise<void> {
    const row = await this.services.channels.enable(mmChannelId);
    if (!row) return;
    this.#subscribe(row);
    await this.#backfill(row);
  }

  async #pause(mmChannelId: string): Promise<void> {
    const row = await this.store.getChannel(mmChannelId);
    if (row) this.#subscriber?.unsubscribe(row.relayChannelId);
    await this.services.channels.pause(mmChannelId);
  }

  async #archive(mmChannelId: string): Promise<void> {
    const row = await this.store.getChannel(mmChannelId);
    if (row) this.#subscriber?.unsubscribe(row.relayChannelId);
    await this.services.channels.archive(mmChannelId);
  }

  /** A restored channel is enabled again if @brain is still a member. */
  async #restore(mmChannelId: string): Promise<void> {
    if (await this.#deps.chat.isChannelMember(mmChannelId, this.services.botUserId)) await this.#enable(mmChannelId);
  }

  async #syncMetadata(mmChannelId: string, channel?: MmChannel): Promise<void> {
    const row = await this.store.getChannel(mmChannelId);
    if (row?.state !== 'active') return;
    const current = channel ?? (await this.#deps.chat.getChannel(mmChannelId));
    if (current && current.delete_at === 0) await this.services.channels.syncMetadata(row, current);
  }

  /** Enable every channel @brain belongs to; pause (or archive) mapped channels it has left. */
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
      if (memberOf.has(row.mmChannelId)) continue;
      // Archived channels drop out of the bot's channel list too.
      const channel = await chat.getChannel(row.mmChannelId);
      if (!channel || channel.delete_at !== 0) await this.#queue.run(row.mmChannelId, () => this.#archive(row.mmChannelId));
      else await this.#queue.run(row.mmChannelId, () => this.#pause(row.mmChannelId));
    }
  }

  /** Handle one Mattermost WebSocket event. Resolves when its processing is done. */
  async handleEvent(event: ChatEvent): Promise<void> {
    if (this.#stopped) return;
    const { botUserId } = this.services;
    const channelId = event.broadcast.channel_id || (typeof event.data.channel_id === 'string' ? event.data.channel_id : '');
    switch (event.event) {
      case 'posted':
      case 'post_edited': {
        const post = postFromEvent(event);
        if (post) await this.#queue.run(post.channel_id, () => this.#processPost(post, event.event === 'posted' ? 'posted' : 'live'));
        return;
      }
      case 'post_deleted': {
        const post = postFromEvent(event);
        if (!post) return;
        await this.#queue.run(post.channel_id, () => this.#processPost(post, 'live', { deleted: true }));
        // Deleting a thread root deletes its replies, with no event for them; catch-up finds them.
        if (!post.root_id) void this.catchUpChannel(post.channel_id).catch((error: unknown) => this.#deps.log.error(errorFields(error), 'Catch-up failed'));
        return;
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const reaction = reactionFromEvent(event);
        if (reaction && channelId) await this.#queue.run(channelId, () => this.#processReactions(channelId, reaction.post_id));
        return;
      }
      case 'channel_updated': {
        const channel = channelFromEvent(event);
        if (channel) await this.#queue.run(channel.id, () => this.#syncMetadata(channel.id, channel));
        return;
      }
      case 'channel_converted':
        if (channelId) await this.#queue.run(channelId, () => this.#syncMetadata(channelId));
        return;
      case 'channel_deleted':
        if (channelId) await this.#queue.run(channelId, () => this.#archive(channelId));
        return;
      case 'channel_restored':
        if (channelId) await this.#queue.run(channelId, () => this.#restore(channelId));
        return;
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

  /** Retry a Mattermost -> relay step a few times, then dead-letter it so the channel keeps moving. */
  async #mirrorGuarded(payload: Record<string, unknown>, step: () => Promise<void>): Promise<void> {
    try {
      await retry(step, {
        attempts: 3,
        baseMs: 1000,
        maxMs: 10_000,
        onRetry: (error, attempt) => this.#deps.log.warn({ ...payload, attempt, ...errorFields(error) }, 'Mirroring to the relay failed; retrying'),
      });
    } catch (error) {
      this.#deps.log.error({ ...payload, ...errorFields(error) }, 'Mirroring to the relay failed; dead-lettering');
      await this.store.deadLetter('mm_to_relay', payload, error instanceof Error ? error.message : String(error), 3);
    }
  }

  #processPost(post: MmPost, source: PostSource, options: SyncOptions = {}): Promise<void> {
    return this.#mirrorGuarded({ mmPostId: post.id, mmChannelId: post.channel_id, source }, () => this.services.mirror.syncPost(post, source, options));
  }

  #processReactions(mmChannelId: string, mmPostId: string): Promise<void> {
    return this.#mirrorGuarded({ mmPostId, mmChannelId, step: 'reactions' }, () => this.services.mirror.syncReactions(mmPostId));
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

  /**
   * Re-read a Mattermost channel from its cursor and mirror anything missed (docs/bridge-spec.md section 8):
   * new posts, edits, deletions and reaction changes all bump a post's update time.
   */
  catchUpChannel(mmChannelId: string): Promise<void> {
    return this.#queue.run(mmChannelId, async () => {
      const channel = await this.store.getChannel(mmChannelId);
      if (channel?.state !== 'active') return;
      const enabledAt = channel.enabledAt.getTime();
      const cursor = (await this.store.getCursor(cursorStream(mmChannelId))) ?? enabledAt;
      const startedAt = Date.now();
      const posts = await this.#deps.chat.getPostsSince(mmChannelId, Math.max(0, cursor - CURSOR_MARGIN_MS));
      for (const post of posts) {
        // has_reactions is omitted when false; when true but the list is missing, syncReactions fetches it.
        await this.#processPost(post, 'catchup', { reactions: post.has_reactions ? post.metadata?.reactions : [] });
      }
      await this.store.setCursor(cursorStream(mmChannelId), Math.max(enabledAt, startedAt - CURSOR_MARGIN_MS));
    });
  }

  async catchUpAll(): Promise<void> {
    const channels = await this.store.listChannels('active');
    await Promise.all(channels.map((channel) => this.catchUpChannel(channel.mmChannelId)));
  }

  /**
   * Mirror the last BACKFILL_DAYS before enablement as history (tagged `backfill`, so agents never answer
   * it). Runs in the channel's queue, before live events. A marker records the finished enablement.
   */
  async #backfill(row: ChannelRow): Promise<void> {
    const days = this.#deps.config.BACKFILL_DAYS;
    if (days === 0 || this.#stopped) return;
    const enabledAt = row.enabledAt.getTime();
    if (((await this.store.getCursor(backfillStream(row.mmChannelId))) ?? 0) >= enabledAt) return;
    const cutoff = enabledAt - days * 86_400_000;
    const history = new Map<string, MmPost>();
    for (let page = 0; ; page++) {
      const list = await this.#deps.chat.getChannelPostsPage(row.mmChannelId, page, BACKFILL_PAGE_SIZE);
      const posts = list.order.map((id) => list.posts[id]).filter((post): post is MmPost => post !== undefined);
      for (const post of posts) if (post.create_at >= cutoff && post.create_at < enabledAt) history.set(post.id, post);
      const oldest = posts.at(-1);
      if (posts.length < BACKFILL_PAGE_SIZE || !oldest || oldest.create_at < cutoff) break;
    }
    const ordered = [...history.values()].sort((a, b) => a.create_at - b.create_at);
    for (const post of ordered) await this.#processPost(post, 'backfill');
    await this.store.setCursor(backfillStream(row.mmChannelId), enabledAt);
    this.#deps.log.info({ mmChannelId: row.mmChannelId, posts: ordered.length, days }, 'Backfill finished');
  }

  /** Re-read agents' relay events since the cursor minus the overlap window, across all channels at once. */
  relayCatchUp(): Promise<void> {
    return this.#relayCatchUp.run();
  }

  async #relayCatchUpRun(): Promise<void> {
    if (this.#stopped) return;
    const agents = (await new IdentityRepository(this.#deps.pool).listByKind('agent')).map((identity) => identity.pubkey);
    const channels = await this.store.listChannels('active');
    if (agents.length === 0 || channels.length === 0) return;
    const oldestEnabled = Math.min(...channels.map((channel) => Math.floor(channel.enabledAt.getTime() / 1000)));
    const cursor = (await this.store.getCursor(RELAY_CURSOR_STREAM)) ?? oldestEnabled;
    const startedAt = nowSeconds();
    // A filter without #h returns stored events from every channel the reader can read (spike A7), so one
    // paged query covers all channels. Typing (20002) is ephemeral and never stored.
    const kinds = RELAY_TO_MM_KINDS.filter((kind) => kind !== 20002);
    const filter: Filter = { kinds, authors: agents, since: Math.max(0, cursor - this.#deps.config.RELAY_OVERLAP_SECONDS) };
    const events: NostrEvent[] = [];
    for await (const event of this.#deps.relay.queryAll(filter, this.readerSigner)) events.push(event);
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    const byRelayId = new Map(channels.map((channel) => [channel.relayChannelId, channel]));
    for (const event of events) {
      const channel = byRelayId.get(tagValue(event, 'h') ?? '') ?? (await this.#channelOfTarget(event, channels));
      if (channel) await this.#queue.run(channel.mmChannelId, () => this.#processRelayEvent(channel, event));
    }
    await this.store.setCursor(RELAY_CURSOR_STREAM, startedAt);
  }

  /** Deletions and reactions may omit the h tag; their channel is their target's (a message or a reaction). */
  async #channelOfTarget(event: NostrEvent, channels: ChannelRow[]): Promise<ChannelRow | undefined> {
    const target = tagValues(event, 'e').at(-1);
    if (!target) return undefined;
    const mapped = (await this.store.getMessageByEvent(target)) ?? (await this.store.getReactionByEvent(target));
    return mapped ? channels.find((channel) => channel.mmChannelId === mapped.mmChannelId) : undefined;
  }

  /** Run reconciliation now (it also runs every RECONCILE_INTERVAL_SECONDS); resolves with its report. */
  async reconcile(): Promise<ReconcileReport | undefined> {
    await this.#reconcile.run();
    return this.#lastReport;
  }

  /**
   * Repair what events missed (docs/bridge-spec.md section 8): channels @brain joined or left, each active
   * channel's name, about text and visibility, and its relay members against current Mattermost members.
   */
  async #reconcileRun(): Promise<ReconcileReport> {
    const report: ReconcileReport = { channels: 0, membersAdded: 0, membersRemoved: 0, metadataUpdated: 0, agentsOutside: [] };
    if (this.#stopped) return report;
    const { chat, log } = this.#deps;
    const { botUserId, identities, channels: channelService } = this.services;
    await this.syncChannels();
    const active = await this.store.listChannels('active');
    const relayMembers = await this.#relayMemberLists();
    for (const row of active) {
      if (this.#stopped) return report;
      await this.#queue.run(row.mmChannelId, async () => {
        const current = await this.store.getChannel(row.mmChannelId);
        const channel = await chat.getChannel(row.mmChannelId);
        if (current?.state !== 'active' || !channel || channel.delete_at !== 0) return;
        report.channels++;
        if (await channelService.syncMetadata(current, channel)) report.metadataUpdated++;
        const desired = new Set<string>();
        let complete = true;
        const memberIds = (await chat.getChannelMemberIds(row.mmChannelId)).filter((id) => id !== botUserId);
        for (const user of await chat.getUsersByIds(memberIds)) {
          if (user.delete_at !== 0) continue;
          try {
            desired.add((await identities.forUser(user)).pubkey);
          } catch (error) {
            complete = false;
            log.warn({ mmChannelId: row.mmChannelId, mmUserId: user.id, ...errorFields(error) }, 'Could not resolve a channel member; skipping removals this time');
          }
        }
        const actual = relayMembers.get(row.relayChannelId) ?? (await this.#relayMembersOf(row.relayChannelId));
        // Without every member's key, a removal could hit someone who still belongs.
        const diff = await channelService.reconcileMembers(current, desired, actual, complete);
        report.membersAdded += diff.added.length;
        report.membersRemoved += diff.removed.length;
      });
    }
    report.agentsOutside = await this.#agentsOutsideEnabledChannels(new Set(active.map((row) => row.mmChannelId)));
    log.debug(report, 'Reconciliation finished');
    return report;
  }

  /** Member lists (kind 39002) of every relay channel the reader belongs to, in one paged query. */
  async #relayMemberLists(): Promise<Map<string, Set<string>>> {
    const lists = new Map<string, Set<string>>();
    for await (const list of this.#deps.relay.queryAll({ kinds: [39002], '#p': [this.readerSigner.pubkey] }, this.readerSigner)) {
      const id = tagValue(list, 'd');
      if (id && !lists.has(id)) lists.set(id, new Set(tagValues(list, 'p')));
    }
    return lists;
  }

  /** One channel's member list, read as the owner (for channels the reader is missing from). */
  async #relayMembersOf(relayChannelId: string): Promise<Set<string>> {
    const [list] = await this.#deps.relay.query([{ kinds: [39002], '#d': [relayChannelId], limit: 1 }], this.bridgeSigner);
    return new Set(list ? tagValues(list, 'p') : []);
  }

  /** Agents whose bots sit in channels @brain is not in: logged once per process, returned for callers. */
  async #agentsOutsideEnabledChannels(enabled: Set<string>): Promise<ReconcileReport['agentsOutside']> {
    const { chat, pool, log } = this.#deps;
    const found: ReconcileReport['agentsOutside'] = [];
    const agents = await new IdentityRepository(pool).listByKind('agent');
    if (agents.length === 0) return found;
    const teams = await chat.getMyTeams();
    for (const agent of agents) {
      for (const team of teams) {
        let channels: MmChannel[];
        try {
          channels = await chat.getUserChannels(agent.mmUserId, team.id);
        } catch (error) {
          log.debug({ agentMmUserId: agent.mmUserId, ...errorFields(error) }, 'Could not list an agent bot channels');
          continue;
        }
        for (const channel of channels) {
          if ((channel.type !== 'O' && channel.type !== 'P') || enabled.has(channel.id) || channel.delete_at !== 0) continue;
          found.push({ agentMmUserId: agent.mmUserId, mmChannelId: channel.id });
          const key = `${agent.mmUserId}:${channel.id}`;
          if (this.#reportedOutside.has(key)) continue;
          this.#reportedOutside.add(key);
          log.warn({ agentMmUserId: agent.mmUserId, mmChannelId: channel.id, channel: channel.display_name }, 'Agent bot is in a channel without @brain, so it cannot respond there; add @brain to enable the channel');
        }
      }
    }
    return found;
  }
}
