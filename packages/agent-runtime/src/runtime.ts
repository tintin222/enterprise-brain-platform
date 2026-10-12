// Agent runtime (docs/agents-and-ingestion.md, part A; D9). One dispatcher reads the relay with the shared
// reader key, one subscription per mirrored channel; decides which agents answer; queues one job per
// (agent, triggering event); runs at most one job per (agent, thread) at a time; publishes replies signed
// by the agent. It never talks to Mattermost: the bridge mirrors replies (and typing) back.
import {
  ChannelWatcher,
  CoalescedTask,
  errorFields,
  gaugeFrom,
  IDENTITY_MIGRATIONS_DIR,
  KeyedQueue,
  messageTimeMs,
  metrics,
  migrate,
  isThreadDoc,
  nowSeconds,
  ProfileNames,
  RelaySession,
  RelaySubscriber,
  signerFromHex,
  startOpsServer,
  tagValue,
  tagValues,
  threadRoot,
  type BrainClient,
  type KeyStore,
  type Logger,
  type NostrEvent,
  type OpsServer,
  type Pool,
  type RelayClient,
  type Signer,
  type UnsignedEvent,
} from '@brain/shared';
import type { RuntimeConfig } from './config.ts';
import { channelInfo, threadEvents, toConversation } from './context.ts';
import { systemPrompt, type LlmProvider } from '@brain/models';
import { JobStore, type Job } from './jobs.ts';
import { AgentRepository, RUNTIME_MIGRATIONS_DIR, type AgentRecord } from './registry.ts';
import { evaluateTriggers, membersOf, mentionsExplicitly } from './triggers.ts';

export const APOLOGY = "Sorry, I couldn't answer that just now.";
export const DECLINED = "Sorry, I can't help with that.";
const MAX_ATTEMPTS = 3;
const TYPING_INTERVAL_MS = 4000;
/** A message naming an unknown key refreshes the agent list, at most this often (an agent created moments ago). */
const AGENT_REFRESH_ON_DEMAND_MS = 2000;
/** Knowledge passages per answer. */
const KNOWLEDGE_LIMIT = 5;

/** The search query for a message: its text without @mentions, which name agents rather than topics. */
export function knowledgeQuery(text: string): string {
  return text
    .replace(/(^|\s)@[\w.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AgentRuntimeDeps {
  config: RuntimeConfig;
  pool: Pool;
  relay: RelayClient;
  keyStore: KeyStore;
  brain: BrainClient;
  providerFor(agent: AgentRecord): LlmProvider;
  log: Logger;
}

export class AgentRuntime {
  readonly #deps: AgentRuntimeDeps;
  readonly #agents: AgentRepository;
  readonly #jobs: JobStore;
  readonly #reader: Signer;
  readonly #names: ProfileNames;
  readonly #members = new Map<string, Set<string>>();
  readonly #channelQueue = new KeyedQueue();
  readonly #threadQueue = new KeyedQueue();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #waiting: (() => void)[] = [];
  #active: AgentRecord[] = [];
  #byId = new Map<string, AgentRecord>();
  #agentPubkeys = new Set<string>();
  #running = 0;
  #subscriber: RelaySubscriber | undefined;
  #watcher: ChannelWatcher | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #agentsRefreshedAt = 0;
  #stopped = false;
  #ops: OpsServer | undefined;
  readonly #catchUp: CoalescedTask;

  constructor(deps: AgentRuntimeDeps) {
    this.#deps = deps;
    this.#agents = new AgentRepository(deps.pool);
    this.#jobs = new JobStore(deps.pool);
    this.#reader = signerFromHex(deps.config.READER_SECRET_KEY);
    this.#names = new ProfileNames(deps.relay, this.#reader);
    this.#catchUp = new CoalescedTask(
      () => this.#catchUpRun(),
      (error) => deps.log.error(errorFields(error), 'Catch-up failed'),
    );
  }

  get jobs(): JobStore {
    return this.#jobs;
  }

  /** The port of /healthz, /readyz and /metrics once started. */
  get opsPort(): number | undefined {
    return this.#ops?.port;
  }

  async start(): Promise<void> {
    const { pool, relay, config, log } = this.#deps;
    this.#ops = await startOpsServer({
      host: config.OPS_HOST,
      port: config.RUNTIME_OPS_PORT,
      log,
      checks: [
        { name: 'database', check: async () => (await pool.query('SELECT 1')).rowCount === 1 },
        { name: 'relay', check: () => this.#subscriber?.connected ?? false },
      ],
    });
    gaugeFrom('brain_runtime_open_jobs', 'Agent jobs pending or running', () => this.#jobs.countOpen());
    gaugeFrom('brain_runtime_relay_subscriptions', 'Relay subscriptions the relay confirmed', () => this.#subscriber?.activeCount ?? 0);
    await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
    await migrate(pool, 'runtime', RUNTIME_MIGRATIONS_DIR);
    await this.refreshAgents();
    this.#refreshTimer = setInterval(
      () => void this.refreshAgents().catch((error: unknown) => log.error(errorFields(error), 'Agent refresh failed')),
      config.AGENT_REFRESH_SECONDS * 1000,
    );

    const subscriber = new RelaySubscriber({
      url: config.RELAY_WS_URL,
      signer: this.#reader,
      name: 'agent-runtime',
      log,
      onEvent: (key, event) => {
        if (key === this.#watcher?.key) this.#watcher.handle(event);
        else void this.#channelQueue.run(key, () => this.#onChannelEvent(key, event)).catch((error: unknown) => log.error({ key, ...errorFields(error) }, 'Event handling failed'));
      },
      // Subscriptions confirm in bursts; they share one global catch-up run.
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
      onAdded: (channelId) => subscriber.subscribe(channelId, { kinds: [9, 39002], '#h': [channelId], limit: 0 }),
      onRemoved: (channelId) => {
        subscriber.unsubscribe(channelId);
        this.#members.delete(channelId);
      },
    });
    await this.#watcher.start();
    this.#catchUp.schedule(0);
    for (const job of await this.#jobs.open()) this.#schedule(job);
    log.info({ agents: this.#active.length, channels: this.#watcher.channels.size }, 'Agent runtime started');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#refreshTimer);
    this.#catchUp.cancel();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#subscriber?.close();
    await this.#channelQueue.idle();
    await this.#threadQueue.idle();
    await this.#ops?.close();
  }

  async refreshAgents(): Promise<void> {
    this.#agentsRefreshedAt = Date.now();
    const all = await this.#agents.listAll();
    this.#active = all.filter((agent) => agent.status === 'active');
    this.#byId = new Map(all.map((agent) => [agent.agentId, agent]));
    this.#agentPubkeys = new Set(all.map((agent) => agent.nostrPubkey));
  }

  /** Evaluate one event from a channel, as live delivery would (public for tests). */
  handleChannelEvent(channelId: string, event: NostrEvent): Promise<void> {
    return this.#channelQueue.run(channelId, () => this.#onChannelEvent(channelId, event));
  }

  async #loadMembers(channelId: string): Promise<void> {
    const [list] = await this.#deps.relay.query([{ kinds: [39002], '#d': [channelId], limit: 1 }], this.#reader);
    if (list) this.#members.set(channelId, membersOf(list));
  }

  /**
   * Mentions published before the subscriptions were confirmed. One query reads every channel's member list
   * and one paged query reads every recent mention of an active agent: a filter without #h covers all
   * channels the reader can read (spike A7), so the cost does not grow with the number of channels.
   */
  async #catchUpRun(): Promise<void> {
    if (this.#stopped) return;
    const { relay, config } = this.#deps;
    const lists = await relay.query([{ kinds: [39002], '#p': [this.#reader.pubkey], limit: 1000 }], this.#reader);
    for (const list of lists) {
      const channelId = tagValue(list, 'd');
      if (channelId) this.#members.set(channelId, membersOf(list));
    }
    const agentKeys = this.#active.map((agent) => agent.nostrPubkey);
    if (agentKeys.length === 0) return;
    const events: NostrEvent[] = [];
    for await (const event of relay.queryAll({ kinds: [9], '#p': agentKeys, since: nowSeconds() - config.RELAY_OVERLAP_SECONDS }, this.#reader)) events.push(event);
    events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const event of events) {
      const channelId = tagValue(event, 'h');
      if (channelId && this.#watcher?.channels.has(channelId)) await this.#channelQueue.run(channelId, () => this.#onChannelEvent(channelId, event));
    }
  }

  async #onChannelEvent(channelId: string, event: NostrEvent): Promise<void> {
    if (this.#stopped) return;
    if (event.kind === 39002) {
      this.#members.set(channelId, membersOf(event));
      return;
    }
    if (event.kind !== 9) return;
    if (!this.#members.has(channelId)) await this.#loadMembers(channelId);
    // An agent created moments ago (admin API, D43) can be mentioned before the periodic refresh sees it.
    if (tagValues(event, 'p').some((pubkey) => !this.#agentPubkeys.has(pubkey)) && Date.now() - this.#agentsRefreshedAt > AGENT_REFRESH_ON_DEMAND_MS) {
      await this.refreshAgents();
    }
    const { config, log } = this.#deps;
    const result = evaluateTriggers({
      event,
      activeAgents: this.#active,
      agentPubkeys: this.#agentPubkeys,
      members: this.#members.get(channelId),
      nowSeconds: nowSeconds(),
      maxEventAgeSeconds: config.MAX_EVENT_AGE_SECONDS,
    });
    for (const { agent, reason } of result.skipped) {
      metrics.triggerSkips.inc({ reason });
      log.info({ agent: agent.handle, eventId: event.id, reason }, 'Not answering');
    }
    for (const agent of result.triggered) await this.#enqueue(agent, channelId, event);
  }

  async #enqueue(agent: AgentRecord, channelId: string, event: NostrEvent): Promise<void> {
    const { config, log } = this.#deps;
    const threadRootId = threadRoot(event) ?? event.id;
    const since = new Date(Date.now() - config.REPLY_WINDOW_SECONDS * 1000);
    const job = { agentId: agent.agentId, relayChannelId: channelId, threadRootId, triggerEvent: event };
    if ((await this.#jobs.repliesSince(agent.agentId, threadRootId, since)) >= config.MAX_REPLIES_PER_THREAD) {
      if (await this.#jobs.enqueue(job, 'skipped', 'reply cap reached')) log.warn({ agent: agent.handle, threadRootId }, 'Reply cap reached for this thread');
      return;
    }
    const queued = await this.#jobs.enqueue(job);
    if (queued) this.#schedule(queued);
  }

  #schedule(job: Job): void {
    void this.#threadQueue
      .run(`${job.agentId}:${job.threadRootId}`, () => this.#withSlot(() => this.#runJob(job.id)))
      .catch((error: unknown) => this.#deps.log.error({ jobId: job.id, ...errorFields(error) }, 'Job crashed'));
  }

  async #withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#running >= this.#deps.config.JOB_CONCURRENCY) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#running++;
    try {
      return await fn();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }

  async #runJob(jobId: number): Promise<void> {
    const { relay, keyStore, log } = this.#deps;
    const job = await this.#jobs.get(jobId);
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'skipped' || this.#stopped) return;
    const agent = this.#byId.get(job.agentId);
    if (agent?.status !== 'active') {
      await this.#jobs.finish(job.id, 'skipped', { error: 'agent disabled' });
      return;
    }
    const attempts = await this.#jobs.markRunning(job.id);
    // Replies carry ["e", <trigger>, "", "mention"]: a reply published before a crash is found here.
    const [previous] = await relay.query([{ kinds: [9], authors: [agent.nostrPubkey], '#e': [job.triggerEventId], limit: 1 }], this.#reader);
    if (previous) {
      await this.#jobs.finish(job.id, 'done', { replyEventId: previous.id });
      return;
    }
    const signer = await keyStore.signerFor(agent.nostrPubkey);
    const stopTyping = await this.#startTyping(signer, job);
    try {
      const text = await this.#answer(agent, job);
      const reply = signer.sign(this.#reply(agent, job, text));
      await relay.publish(reply, signer);
      await this.#jobs.finish(job.id, 'done', { replyEventId: reply.id });
      metrics.jobLatency.observe(Math.max(0, Date.now() - messageTimeMs(job.triggerEvent)) / 1000);
      log.info({ agent: agent.handle, trigger: job.triggerEventId, reply: reply.id }, 'Replied');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempts < MAX_ATTEMPTS) {
        log.warn({ agent: agent.handle, jobId: job.id, attempts, ...errorFields(error) }, 'Job failed; retrying');
        await this.#jobs.finish(job.id, 'pending', { error: message });
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          this.#schedule(job);
        }, 5000 * attempts);
        this.#timers.add(timer);
      } else {
        log.error({ agent: agent.handle, jobId: job.id, ...errorFields(error) }, 'Job failed; sending an apology');
        let apologyId: string | undefined;
        try {
          const apology = signer.sign(this.#reply(agent, job, APOLOGY));
          await relay.publish(apology, signer);
          apologyId = apology.id;
        } catch (apologyError) {
          log.error(errorFields(apologyError), 'Could not send the apology');
        }
        await this.#jobs.finish(job.id, 'failed', { error: message, ...(apologyId ? { replyEventId: apologyId } : {}) });
      }
    } finally {
      stopTyping();
    }
  }

  async #answer(agent: AgentRecord, job: Job): Promise<string> {
    const { relay, config, brain } = this.#deps;
    const trigger = job.triggerEvent;
    const events = await threadEvents(relay, this.#reader, job.relayChannelId, job.threadRootId, trigger);
    const names = await this.#names.names(events.map((event) => event.pubkey));
    for (const known of this.#byId.values()) if (names.has(known.nostrPubkey)) names.set(known.nostrPubkey, known.displayName);
    const conversation = toConversation(events, names, this.#agentPubkeys, agent.nostrPubkey, config.CONTEXT_CHAR_BUDGET);
    const channel = await channelInfo(relay, this.#reader, job.relayChannelId);
    // The thread itself is already in the conversation, so its own document is left out.
    const query = knowledgeQuery(trigger.content);
    const found = query
      ? await brain.search({ query, channelId: job.relayChannelId, requesterId: trigger.pubkey, scope: agent.knowledgeScope, limit: KNOWLEDGE_LIMIT + 2 }).catch((error: unknown) => {
          this.#deps.log.warn(errorFields(error), 'Knowledge search failed; answering without it');
          return [];
        })
      : [];
    const knowledge = found.filter((passage) => !isThreadDoc(passage.id, job.relayChannelId, job.threadRootId)).slice(0, KNOWLEDGE_LIMIT);
    const provider = this.#deps.providerFor(agent);
    const result = await provider.generate({
      model: agent.model || provider.defaultModel,
      instructions: systemPrompt({ agentName: agent.displayName, instructions: agent.instructions }),
      channel,
      conversation,
      knowledge,
      tools: [],
    });
    metrics.llmTokens.inc({ direction: 'input' }, result.usage.inputTokens);
    metrics.llmTokens.inc({ direction: 'output' }, result.usage.outputTokens);
    if (result.refused) return DECLINED;
    if (!result.text) throw new Error('The model returned no text');
    return result.text;
  }

  #reply(agent: AgentRecord, job: Job, text: string): UnsignedEvent {
    const trigger = job.triggerEvent;
    const tags = [
      ['h', job.relayChannelId],
      ['e', job.threadRootId, '', 'reply'],
      ['e', trigger.id, '', 'mention'],
      ['p', trigger.pubkey],
    ];
    // Agents named in the reply get a p tag, so they can be asked; their own rules and the reply cap stop loops.
    for (const other of this.#active) {
      if (other.agentId !== agent.agentId && other.nostrPubkey !== trigger.pubkey && mentionsExplicitly(text, other)) tags.push(['p', other.nostrPubkey]);
    }
    return { kind: 9, tags, content: text, created_at: nowSeconds() };
  }

  /** Typing (kind 20002) over a short-lived socket as the agent; the bridge shows it in Mattermost. */
  async #startTyping(signer: Signer, job: Job): Promise<() => void> {
    let session: RelaySession;
    try {
      session = await RelaySession.open(this.#deps.config.RELAY_WS_URL, signer);
    } catch (error) {
      this.#deps.log.debug(errorFields(error), 'Typing indicator unavailable');
      return () => undefined;
    }
    const send = (): void => void session.send({ kind: 20002, tags: [['h', job.relayChannelId], ['e', job.threadRootId]], content: '' });
    send();
    const timer = setInterval(send, TYPING_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      session.close();
    };
  }
}
