// Mattermost -> relay mirroring of posts and thread replies (docs/bridge-spec.md section 5).
import type { ChatClient, Logger, MmPost } from '@brain/shared';
import type { ChannelService } from './channels.ts';
import { buildPostEvent } from './events.ts';
import type { IdentityService } from './identities.ts';
import { extractMentionUsernames } from './mentions.ts';
import type { OutboxPublisher } from './publisher.ts';
import type { BridgeStore } from './store.ts';

const USERNAME_TTL_MS = 10 * 60 * 1000;

export interface MmToRelayDeps {
  chat: ChatClient;
  store: BridgeStore;
  identities: IdentityService;
  channels: ChannelService;
  publisher: OutboxPublisher;
  botUserId: string;
  log: Logger;
}

export class MmToRelay {
  readonly #deps: MmToRelayDeps;
  readonly #usernames = new Map<string, { userId: string | undefined; expires: number }>();

  constructor(deps: MmToRelayDeps) {
    this.#deps = deps;
  }

  /**
   * Mirror one post. Safe to call any number of times for the same post: message_map and the outbox
   * make it a no-op once the post is on the relay.
   */
  async mirrorPost(post: MmPost, options: { backfill?: boolean } = {}): Promise<void> {
    const { store, identities, channels, publisher, chat } = this.#deps;
    if (post.type !== '' || post.user_id === this.#deps.botUserId || post.delete_at !== 0) return;
    const channel = await store.getChannel(post.channel_id);
    if (channel?.state !== 'active') return;
    if (await store.getMessageByPost(post.id)) return;
    const pending = await store.getOutboxForPost(post.id, 'post');
    if (pending) {
      await publisher.publishRow(pending);
      return;
    }

    const author = await identities.forUserId(post.user_id);
    if (!author) return;
    // An agent's post that carries a relay event id is the bridge's own copy of a relay message.
    if (author.kind === 'agent' && post.props?.relay_event_id) return;
    await channels.ensureMember(channel, author.pubkey);

    let rootEventId: string | undefined;
    if (post.root_id) {
      rootEventId = (await store.getMessageByPost(post.root_id))?.relayEventId;
      if (!rootEventId) {
        // The relay rejects replies to unknown parents, so mirror the root first (as history if it predates enablement).
        const root = await chat.getPost(post.root_id);
        if (root && root.delete_at === 0) await this.mirrorPost(root, { backfill: root.create_at < channel.enabledAt.getTime() });
        rootEventId = (await store.getMessageByPost(post.root_id))?.relayEventId;
        if (!rootEventId) throw new Error(`Thread root ${post.root_id} could not be mirrored`);
      }
    }

    const unsigned = buildPostEvent({
      relayChannelId: channel.relayChannelId,
      post,
      rootEventId,
      mentionPubkeys: await this.#mentionPubkeys(post.message),
      backfill: options.backfill,
      nowMs: Date.now(),
    });
    const signed = (await identities.signerFor(author)).sign(unsigned);
    await publisher.publish({ relayEventId: signed.id, purpose: 'post', mmPostId: post.id, mmChannelId: post.channel_id, authorMmUserId: post.user_id, signedEvent: signed });
  }

  async #mentionPubkeys(message: string): Promise<string[]> {
    const usernames = extractMentionUsernames(message);
    if (usernames.length === 0) return [];
    const now = Date.now();
    const unknown = usernames.filter((name) => (this.#usernames.get(name)?.expires ?? 0) < now);
    if (unknown.length > 0) {
      const users = await this.#deps.chat.getUsersByUsernames(unknown);
      for (const name of unknown) this.#usernames.set(name, { userId: users.find((u) => u.username === name)?.id, expires: now + USERNAME_TTL_MS });
    }
    const userIds = usernames.map((name) => this.#usernames.get(name)?.userId).filter((id): id is string => id !== undefined);
    const mapped = await this.#deps.identities.mapped(userIds);
    return userIds.map((id) => mapped.get(id)?.pubkey).filter((pubkey): pubkey is string => pubkey !== undefined);
  }
}
