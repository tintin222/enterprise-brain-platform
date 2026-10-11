// Discover the relay channels the reader key belongs to (the bridge adds the reader to every mirrored
// channel) and follow changes through the reader's own membership notifications (kinds 44100/44101,
// which the relay only delivers to the key they are about, spike A6).
import { errorFields, type Logger } from '../logger.ts';
import { tagValue, type NostrEvent, type Signer } from '../nostr.ts';
import type { RelayClient } from './client.ts';
import type { RelaySubscriber } from './subscriber.ts';

export interface ChannelWatcherOptions {
  relay: RelayClient;
  subscriber: RelaySubscriber;
  signer: Signer;
  onAdded(relayChannelId: string): void;
  onRemoved(relayChannelId: string): void;
  log: Logger;
}

export class ChannelWatcher {
  readonly key: string;
  readonly #opts: ChannelWatcherOptions;
  readonly #channels = new Set<string>();

  constructor(opts: ChannelWatcherOptions) {
    this.#opts = opts;
    this.key = `membership-${opts.signer.pubkey.slice(0, 16)}`;
  }

  get channels(): ReadonlySet<string> {
    return this.#channels;
  }

  /**
   * Subscribe to membership notifications, then take a snapshot. Call `activated()` when the subscription
   * becomes active (the subscriber's onActive for `key`) to re-take it, so no notification falls between.
   */
  async start(): Promise<void> {
    this.#opts.subscriber.subscribe(this.key, { kinds: [44100, 44101], '#p': [this.#opts.signer.pubkey], limit: 0 });
    await this.refresh();
  }

  activated(): void {
    void this.refresh();
  }

  /** Re-read the current membership from the relay-signed member lists (kind 39002). */
  async refresh(): Promise<void> {
    const { relay, signer, log } = this.#opts;
    try {
      const lists = await relay.query([{ kinds: [39002], '#p': [signer.pubkey], limit: 1000 }], signer);
      const current = new Set(
        lists
          .filter((list) => list.tags.some((tag) => tag[0] === 'p' && tag[1] === signer.pubkey))
          .map((list) => tagValue(list, 'd'))
          .filter((id): id is string => id !== undefined),
      );
      for (const id of current) this.#add(id);
      for (const id of [...this.#channels]) if (!current.has(id)) this.#remove(id);
    } catch (error) {
      log.error(errorFields(error), 'Could not read channel membership from the relay');
    }
  }

  /** Feed events received on this watcher's subscription key. */
  handle(event: NostrEvent): void {
    const channelId = tagValue(event, 'h');
    if (!channelId || tagValue(event, 'p') !== this.#opts.signer.pubkey) return;
    if (event.kind === 44100) this.#add(channelId);
    else if (event.kind === 44101) this.#remove(channelId);
  }

  #add(channelId: string): void {
    if (this.#channels.has(channelId)) return;
    this.#channels.add(channelId);
    this.#opts.onAdded(channelId);
  }

  #remove(channelId: string): void {
    if (!this.#channels.delete(channelId)) return;
    this.#opts.onRemoved(channelId);
  }
}
