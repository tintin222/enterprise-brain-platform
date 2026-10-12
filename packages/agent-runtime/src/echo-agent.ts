// Echo agent (build plan, Phase 2): replies "echo: <text>" on the relay when mentioned, to exercise the
// whole loop without a model. Reads with the shared reader key, one subscription per mirrored channel.
import {
  ChannelWatcher,
  CoalescedTask,
  errorFields,
  isBackfill,
  KeyedQueue,
  messageTimeSeconds,
  nowSeconds,
  RelaySubscriber,
  tagValue,
  tagValues,
  threadRoot,
  type KeyStore,
  type Logger,
  type NostrEvent,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import type { AgentRecord } from './registry.ts';

export interface EchoAgentDeps {
  relay: RelayClient;
  keyStore: KeyStore;
  readerSigner: Signer;
  agent: AgentRecord;
  relayWsUrl: string;
  log: Logger;
  maxEventAgeSeconds: number;
  overlapSeconds: number;
}

export class EchoAgent {
  readonly #deps: EchoAgentDeps;
  readonly #queue = new KeyedQueue();
  readonly #answered = new Set<string>();
  #signer: Signer | undefined;
  #subscriber: RelaySubscriber | undefined;
  #watcher: ChannelWatcher | undefined;
  readonly #catchUp: CoalescedTask;

  constructor(deps: EchoAgentDeps) {
    this.#deps = deps;
    this.#catchUp = new CoalescedTask(
      () => this.#catchUpRun(),
      (error) => deps.log.error(errorFields(error), 'Echo catch-up failed'),
    );
  }

  async start(): Promise<void> {
    const { relay, keyStore, readerSigner, agent, relayWsUrl, log } = this.#deps;
    this.#signer = await keyStore.signerFor(agent.nostrPubkey);
    const subscriber = new RelaySubscriber({
      name: 'echo-agent',
      url: relayWsUrl,
      signer: readerSigner,
      log,
      onEvent: (key, event) => {
        if (key === this.#watcher?.key) this.#watcher.handle(event);
        else void this.#queue.run(key, () => this.consider(key, event));
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
      signer: readerSigner,
      log,
      onAdded: (channelId) => {
        log.debug({ channelId }, 'Watching channel');
        // Catch-up runs when the subscription is confirmed (onActive), so nothing falls in between.
        subscriber.subscribe(channelId, { kinds: [9], '#h': [channelId], limit: 0 });
      },
      onRemoved: (channelId) => subscriber.unsubscribe(channelId),
    });
    await this.#watcher.start();
    this.#catchUp.schedule(0);
    log.info({ agent: agent.handle, channels: this.#watcher.channels.size }, 'Echo agent started');
  }

  async stop(): Promise<void> {
    this.#catchUp.cancel();
    this.#subscriber?.close();
    await this.#queue.idle();
  }

  /** Recent mentions across all watched channels, in one paged query (spike A7). */
  async #catchUpRun(): Promise<void> {
    const { relay, readerSigner, agent, overlapSeconds } = this.#deps;
    const events: NostrEvent[] = [];
    for await (const event of relay.queryAll({ kinds: [9], '#p': [agent.nostrPubkey], since: nowSeconds() - overlapSeconds }, readerSigner)) events.push(event);
    for (const event of events.reverse()) {
      const channelId = tagValue(event, 'h');
      if (channelId && this.#watcher?.channels.has(channelId)) await this.#queue.run(channelId, () => this.consider(channelId, event));
    }
  }

  /** Reply once to a fresh mention of this agent. */
  async consider(channelId: string, event: NostrEvent): Promise<void> {
    const { relay, readerSigner, agent, maxEventAgeSeconds, log } = this.#deps;
    log.debug({ channelId, eventId: event.id, kind: event.kind }, 'Considering event');
    if (event.kind !== 9 || event.pubkey === agent.nostrPubkey || this.#answered.has(event.id)) return;
    if (!tagValues(event, 'p').includes(agent.nostrPubkey) || isBackfill(event)) return;
    if (nowSeconds() - messageTimeSeconds(event) > maxEventAgeSeconds) {
      log.debug({ eventId: event.id }, 'Ignoring an old mention');
      return;
    }
    // A reply carries ["e", <mention id>, "", "mention"], so a restart can see it already answered.
    const previous = await relay.query([{ kinds: [9], authors: [agent.nostrPubkey], '#e': [event.id], limit: 1 }], readerSigner);
    if (previous.length === 0) {
      const signer = this.#signer;
      if (!signer) throw new Error('Echo agent not started');
      const root = threadRoot(event) ?? event.id;
      const reply = signer.sign({
        kind: 9,
        tags: [['h', channelId], ['e', root, '', 'reply'], ['e', event.id, '', 'mention'], ['p', event.pubkey]],
        content: `echo: ${event.content}`,
        created_at: nowSeconds(),
      });
      await relay.publish(reply, signer);
      log.info({ mention: event.id, reply: reply.id }, 'Echoed');
    }
    this.#answered.add(event.id);
  }
}
