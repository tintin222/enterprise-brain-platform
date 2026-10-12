// Ingestion (docs/agents-and-ingestion.md part B). Reads the relay with the shared reader key, one
// subscription per mirrored channel plus catch-up with its own cursor, and keeps the brain's thread
// documents in step. A new message, edit or deletion marks its thread pending; once the debounce has passed,
// the thread is read again from the relay (edits applied, deleted messages already hidden), rendered and
// upserted, or deleted when nothing is left. Pending threads are stored, so a restart loses nothing.
import {
  applyEdits,
  ChannelWatcher,
  CoalescedTask,
  errorFields,
  gaugeFrom,
  KeyedQueue,
  metrics,
  migrate,
  nowSeconds,
  ProfileNames,
  RelaySubscriber,
  signerFromHex,
  startOpsServer,
  tagValue,
  threadRoot,
  type BrainClient,
  type BrainDocument,
  type Logger,
  type NostrEvent,
  type OpsServer,
  type Pool,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import type { IngestionConfig } from './config.ts';
import { buildThreadDocuments } from './render.ts';
import { INGESTION_MIGRATIONS_DIR, IngestionStore, type PendingThread, type ThreadKey } from './store.ts';

/** Kinds that change thread documents, plus channel metadata (39000, delivered live on #h subscriptions). */
export const INGEST_KINDS = [9, 40003, 5, 9005, 39000];
const CATCH_UP_KINDS = [9, 40003, 5, 9005];
export const INGEST_CURSOR_STREAM = 'relay:all';
/** A thread whose indexing failed is tried again this much later. */
const RETRY_DELAY_MS = 30_000;

export interface IngestionDeps {
  config: IngestionConfig;
  pool: Pool;
  relay: RelayClient;
  brain: BrainClient;
  log: Logger;
}

interface ChannelFacts {
  name: string;
  visibility: 'open' | 'private';
}

/** Name and visibility from a relay-signed kind 39000; a channel not marked public is treated as private. */
function factsOf(metadata: NostrEvent): ChannelFacts {
  return { name: tagValue(metadata, 'name') ?? '', visibility: metadata.tags.some((tag) => tag[0] === 'public') ? 'open' : 'private' };
}

/** A Mattermost permalink that needs no team name (the web app finds the team). */
export function permalinkFor(mmUrl: string, postId: string): string {
  return `${mmUrl.replace(/\/$/, '')}/_redirect/pl/${postId}`;
}

export class Ingestion {
  readonly store: IngestionStore;
  readonly #deps: IngestionDeps;
  readonly #reader: Signer;
  readonly #names: ProfileNames;
  readonly #queue = new KeyedQueue();
  readonly #channels = new Map<string, ChannelFacts>();
  readonly #catchUp: CoalescedTask;
  readonly #flush: CoalescedTask;
  #subscriber: RelaySubscriber | undefined;
  #watcher: ChannelWatcher | undefined;
  readonly #timers: NodeJS.Timeout[] = [];
  #stopped = false;
  #ops: OpsServer | undefined;

  constructor(deps: IngestionDeps) {
    this.#deps = deps;
    this.store = new IngestionStore(deps.pool);
    this.#reader = signerFromHex(deps.config.READER_SECRET_KEY);
    this.#names = new ProfileNames(deps.relay, this.#reader);
    this.#catchUp = new CoalescedTask(
      () => this.#catchUpRun(),
      (error) => deps.log.error(errorFields(error), 'Catch-up failed'),
    );
    this.#flush = new CoalescedTask(
      () => this.#flushRun(),
      (error) => deps.log.error(errorFields(error), 'Indexing failed'),
    );
  }

  /** The port of /healthz, /readyz and /metrics once started. */
  get opsPort(): number | undefined {
    return this.#ops?.port;
  }

  async start(): Promise<void> {
    const { pool, relay, config, log } = this.#deps;
    this.#ops = await startOpsServer({
      host: config.OPS_HOST,
      port: config.INGESTION_OPS_PORT,
      log,
      checks: [
        { name: 'database', check: async () => (await pool.query('SELECT 1')).rowCount === 1 },
        { name: 'relay', check: () => this.#subscriber?.connected ?? false },
      ],
    });
    await migrate(pool, 'ingestion', INGESTION_MIGRATIONS_DIR);
    gaugeFrom('brain_ingestion_pending_threads', 'Threads waiting to be indexed', () => this.store.pendingCount());
    gaugeFrom('brain_ingestion_relay_subscriptions', 'Relay subscriptions the relay confirmed', () => this.#subscriber?.activeCount ?? 0);
    const subscriber = new RelaySubscriber({
      url: config.RELAY_WS_URL,
      signer: this.#reader,
      name: 'ingestion',
      log,
      onEvent: (key, event) => {
        if (key === this.#watcher?.key) this.#watcher.handle(event);
        else void this.#queue.run(key, () => this.#onEvent(key, event)).catch((error: unknown) => log.error({ key, ...errorFields(error) }, 'Event handling failed'));
      },
      onActive: (key) => {
        if (key === this.#watcher?.key) this.#watcher.activated();
        else this.#catchUp.schedule(1000);
      },
    });
    this.#subscriber = subscriber;
    this.#watcher = new ChannelWatcher({
      relay,
      subscriber,
      signer: this.#reader,
      log,
      onAdded: (channelId) => {
        subscriber.subscribe(channelId, { kinds: INGEST_KINDS, '#h': [channelId], limit: 0 });
        void this.#queue.run(channelId, () => this.#publishChannel(channelId, true)).catch((error: unknown) => log.error({ channelId, ...errorFields(error) }, 'Channel update failed'));
      },
      // Paused and archived channels keep their documents but leave retrieval (Q4, D28).
      onRemoved: (channelId) => {
        subscriber.unsubscribe(channelId);
        void this.#queue.run(channelId, () => this.#publishChannel(channelId, false)).catch((error: unknown) => log.error({ channelId, ...errorFields(error) }, 'Channel update failed'));
      },
    });
    await this.#watcher.start();
    this.#catchUp.schedule(0);
    const tickMs = Math.max(200, Math.min(1000, config.INGEST_DEBOUNCE_SECONDS * 500));
    this.#timers.push(
      setInterval(() => void this.#flush.run(), tickMs),
      setInterval(() => void this.#catchUp.run(), config.CATCH_UP_INTERVAL_SECONDS * 1000),
    );
    log.info({ channels: this.#watcher.channels.size, pending: await this.store.pendingCount() }, 'Ingestion started');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#catchUp.cancel();
    this.#flush.cancel();
    this.#subscriber?.close();
    await Promise.all([this.#catchUp.idle(), this.#flush.idle()]);
    await this.#queue.idle();
    await this.#ops?.close();
    this.#deps.log.info('Ingestion stopped');
  }

  /** Run catch-up now (it also runs on start, on new subscriptions and every CATCH_UP_INTERVAL_SECONDS). */
  catchUp(): Promise<void> {
    return this.#catchUp.run();
  }

  /** Index every thread that is due now (it also runs on a timer). */
  flush(): Promise<void> {
    return this.#flush.run();
  }

  /** Tell the brain a channel's name, visibility and whether it is active. */
  async #publishChannel(channelId: string, active: boolean): Promise<void> {
    const facts = (active ? await this.#readFacts(channelId) : undefined) ?? this.#channels.get(channelId) ?? { name: '', visibility: 'private' };
    this.#channels.set(channelId, facts);
    await this.#deps.brain.upsertChannels([{ channelId, ...facts, active }]);
  }

  async #readFacts(channelId: string): Promise<ChannelFacts | undefined> {
    const [metadata] = await this.#deps.relay.query([{ kinds: [39000], '#d': [channelId], limit: 1 }], this.#reader);
    return metadata ? factsOf(metadata) : undefined;
  }

  async #channelName(channelId: string): Promise<string> {
    let facts = this.#channels.get(channelId);
    if (!facts) {
      facts = await this.#readFacts(channelId);
      if (facts) this.#channels.set(channelId, facts);
    }
    return facts?.name || 'channel';
  }

  /** Handle one event from a channel, as live delivery would (public for tests). */
  handleEvent(channelId: string, event: NostrEvent): Promise<void> {
    return this.#queue.run(channelId, () => this.#onEvent(channelId, event));
  }

  async #onEvent(channelId: string, event: NostrEvent): Promise<void> {
    if (this.#stopped) return;
    switch (event.kind) {
      case 9: {
        // Catch-up re-reads an overlap window: a message seen before changes nothing. Pending first, then the
        // record, so a crash in between can only cause one extra indexing, never a missed one.
        if (await this.store.threadOf(event.id)) return;
        const thread = { channelId, rootId: threadRoot(event) ?? event.id };
        await this.#markPending(thread);
        await this.store.recordMessage(event.id, thread, event.pubkey);
        return;
      }
      case 40003:
      case 5:
      case 9005: {
        const target = tagValue(event, 'e');
        if (!target || (await this.store.changeSeen(event.id))) return;
        // Deletions of anything else (reactions) find no thread and are ignored.
        const thread = (await this.store.threadOf(target)) ?? (event.kind === 40003 ? await this.#learnMessage(channelId, target) : undefined);
        if (thread) await this.#markPending(thread);
        await this.store.markChangeSeen(event.id);
        return;
      }
      case 39000: {
        const facts = factsOf(event);
        this.#channels.set(channelId, facts);
        await this.#deps.brain.upsertChannels([{ channelId, ...facts, active: this.#watcher?.channels.has(channelId) ?? true }]);
        return;
      }
      default:
        return;
    }
  }

  /** An edit of a message ingestion has not seen (it predates ingestion): record the message first. */
  async #learnMessage(channelId: string, eventId: string): Promise<ThreadKey | undefined> {
    const [message] = await this.#deps.relay.query([{ ids: [eventId] }], this.#reader);
    if (message?.kind !== 9) return undefined;
    const thread = { channelId, rootId: threadRoot(message) ?? message.id };
    await this.store.recordMessage(message.id, thread, message.pubkey);
    return thread;
  }

  #markPending(thread: ThreadKey): Promise<void> {
    return this.store.markPending(thread, new Date(Date.now() + this.#deps.config.INGEST_DEBOUNCE_SECONDS * 1000));
  }

  /** Events published while subscriptions were not yet confirmed, across all channels in one paged query. */
  async #catchUpRun(): Promise<void> {
    const watcher = this.#watcher;
    if (this.#stopped || !watcher) return;
    const { relay, brain, config } = this.#deps;
    // Every channel's name and visibility at once (a filter without #d covers all readable channels).
    for await (const metadata of relay.queryAll({ kinds: [39000] }, this.#reader)) {
      const channelId = tagValue(metadata, 'd');
      if (!channelId || !watcher.channels.has(channelId)) continue;
      const facts = factsOf(metadata);
      const known = this.#channels.get(channelId);
      if (known?.name === facts.name && known.visibility === facts.visibility) continue;
      this.#channels.set(channelId, facts);
      await brain.upsertChannels([{ channelId, ...facts, active: true }]);
    }
    const cursor = await this.store.getCursor(INGEST_CURSOR_STREAM);
    const startedAt = nowSeconds();
    // The first run reads all history, so threads from before ingestion started are indexed too.
    const since = cursor === undefined ? 0 : Math.max(0, cursor - config.RELAY_OVERLAP_SECONDS);
    const events: NostrEvent[] = [];
    for await (const event of relay.queryAll({ kinds: CATCH_UP_KINDS, since }, this.#reader)) events.push(event);
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const event of events) {
      const channelId = tagValue(event, 'h') ?? (await this.store.threadOf(tagValue(event, 'e') ?? ''))?.channelId;
      if (channelId && watcher.channels.has(channelId)) await this.#queue.run(channelId, () => this.#onEvent(channelId, event));
    }
    await this.store.setCursor(INGEST_CURSOR_STREAM, startedAt);
  }

  async #flushRun(): Promise<void> {
    const { config, log } = this.#deps;
    for (;;) {
      if (this.#stopped) return;
      const due = await this.store.duePending(new Date(), 20);
      if (due.length === 0) return;
      for (const item of due) {
        await this.#queue.run(item.channelId, async () => {
          try {
            await this.#reindex(item);
            await this.store.finishPending(item, new Date(Date.now() + config.INGEST_DEBOUNCE_SECONDS * 1000));
          } catch (error) {
            log.warn({ ...item, ...errorFields(error) }, 'Indexing a thread failed; retrying later');
            await this.store.postponePending(item, new Date(Date.now() + RETRY_DELAY_MS));
          }
        });
      }
    }
  }

  /** Render a thread from the relay and replace its documents in the brain. */
  async #reindex(thread: PendingThread): Promise<void> {
    const { brain, config, log } = this.#deps;
    const exclusions = await this.store.exclusions();
    const previous = await this.store.getThreadDocs(thread);
    let docs: BrainDocument[] = [];
    if (!exclusions.channels.has(thread.channelId)) {
      const messages = (await this.#threadMessages(thread)).filter((message) => !exclusions.authors.has(message.pubkey));
      if (messages.length > 0) {
        const root = messages.find((message) => message.id === thread.rootId);
        const postId = root ? tagValue(root, 'mm') : undefined;
        docs = buildThreadDocuments({
          channelId: thread.channelId,
          channelName: await this.#channelName(thread.channelId),
          rootId: thread.rootId,
          messages,
          names: await this.#names.names(messages.map((message) => message.pubkey)),
          sourceUrl: postId ? permalinkFor(config.MM_URL, postId) : undefined,
          chunkChars: config.INGEST_CHUNK_CHARS,
        });
      }
    }
    const ids = docs.map((doc) => doc.id);
    const stale = previous.filter((id) => !ids.includes(id));
    await brain.upsertDocuments(docs);
    await brain.deleteDocuments(stale);
    await this.store.setThreadDocs(thread, ids);
    metrics.threadsIndexed.inc();
    metrics.documents.inc({ op: 'upsert' }, docs.length);
    metrics.documents.inc({ op: 'delete' }, stale.length);
    metrics.indexLag.observe(Math.max(0, Date.now() - thread.firstAt.getTime()) / 1000);
    log.debug({ channelId: thread.channelId, rootId: thread.rootId, documents: ids.length }, 'Indexed thread');
  }

  /**
   * The thread's chat messages with their newest edits; the relay already hides deleted ones. One request:
   * the edits are looked up by the message ids ingestion has recorded for the thread.
   */
  async #threadMessages(thread: ThreadKey): Promise<NostrEvent[]> {
    const { relay } = this.#deps;
    const known = new Set([thread.rootId, ...(await this.store.messageIds(thread))]);
    const found = await relay.query(
      [
        { ids: [thread.rootId] },
        { kinds: [9], '#h': [thread.channelId], '#e': [thread.rootId], limit: 1000 },
        { kinds: [40003], '#h': [thread.channelId], '#e': [...known], limit: 1000 },
      ],
      this.#reader,
    );
    const messages = [...new Map(found.filter((event) => event.kind === 9 && (event.id === thread.rootId || threadRoot(event) === thread.rootId)).map((event) => [event.id, event])).values()];
    if (messages.length === 0) return [];
    const edits = found.filter((event) => event.kind === 40003);
    // A message ingestion had not recorded yet (it arrived during this read) may have edits too.
    const unknown = messages.filter((message) => !known.has(message.id)).map((message) => message.id);
    if (unknown.length > 0) edits.push(...(await relay.query([{ kinds: [40003], '#h': [thread.channelId], '#e': unknown, limit: 1000 }], this.#reader)));
    return applyEdits(messages, edits);
  }
}

export interface PurgeDeps {
  pool: Pool;
  brain: BrainClient;
}

/** Remove a channel's documents and never index it again (B.4). Returns the number of threads removed. */
export async function purgeChannel(deps: PurgeDeps, channelId: string): Promise<number> {
  const store = new IngestionStore(deps.pool);
  await store.addExclusion('channel', channelId);
  const threads = await store.threadsOfChannel(channelId);
  await deps.brain.deleteDocuments(threads.flatMap((thread) => thread.docIds));
  for (const thread of threads) await store.setThreadDocs(thread, []);
  return threads.length;
}

/**
 * Remove an author's messages from the brain and never index them again (B.4): their threads' documents
 * are deleted now and re-indexed without them by the running ingestion. Returns the number of threads.
 */
export async function purgeAuthor(deps: PurgeDeps, authorPubkey: string): Promise<number> {
  const store = new IngestionStore(deps.pool);
  await store.addExclusion('author', authorPubkey);
  const threads = await store.threadsOfAuthor(authorPubkey);
  for (const thread of threads) {
    await deps.brain.deleteDocuments(await store.getThreadDocs(thread));
    await store.setThreadDocs(thread, []);
    await store.markPending(thread, new Date());
  }
  return threads.length;
}

/**
 * Forget everything ingestion indexed, after the relay was wiped and rebuilt with new event ids (docs/
 * operations.md): its documents leave the brain and its state starts over, so the next start indexes the
 * rebuilt relay from the beginning. Purge exclusions stay.
 */
export async function resetForRelayRebuild(deps: PurgeDeps): Promise<{ documents: number }> {
  const result = await deps.pool.query<{ id: string }>('SELECT unnest(doc_ids) AS id FROM ingestion.threads');
  const ids = result.rows.map((row) => row.id);
  for (let i = 0; i < ids.length; i += 1000) await deps.brain.deleteDocuments(ids.slice(i, i + 1000));
  await deps.pool.query('TRUNCATE ingestion.messages, ingestion.threads, ingestion.pending, ingestion.cursors, ingestion.seen_changes');
  return { documents: ids.length };
}
