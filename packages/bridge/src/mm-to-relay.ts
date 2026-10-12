// Mattermost -> relay mirroring (docs/bridge-spec.md section 5): posts and thread replies, edits, deletions
// and reactions. Every entry point is idempotent: message_map, reaction_map and the outbox turn repeats into
// no-ops, so live events, catch-up and backfill can overlap freely.
import type { ChatClient, Logger, MmPost, MmReaction, RelayClient, Signer } from '@brain/shared';
import type { ChannelService } from './channels.ts';
import { emojiForName } from './emoji.ts';
import { buildDeletionEvent, buildEditEvent, buildPostEvent, buildReactionEvent, postContent } from './events.ts';
import type { IdentityService } from './identities.ts';
import { extractMentionUsernames } from './mentions.ts';
import type { OutboxPublisher } from './publisher.ts';
import type { BridgeStore, ChannelRow, MessageState, ReactionRow } from './store.ts';

const USERNAME_TTL_MS = 10 * 60 * 1000;

/**
 * Where a post came from. `posted` is a live new post; `live` an edit or deletion event; `catchup` a REST
 * re-read; `backfill` history from before the channel was enabled.
 */
export type PostSource = 'posted' | 'live' | 'catchup' | 'backfill';

export interface SyncOptions {
  /** The post was deleted (the `post_deleted` event still carries delete_at 0). */
  deleted?: boolean;
  /** The post's current reactions, when the caller already has them (REST responses include them). */
  reactions?: MmReaction[] | undefined;
  /** Replaying history into a rebuilt relay: agents' messages are published again too. */
  rebuild?: boolean;
}

export interface MmToRelayDeps {
  chat: ChatClient;
  relay: RelayClient;
  readerSigner: Signer;
  store: BridgeStore;
  identities: IdentityService;
  channels: ChannelService;
  publisher: OutboxPublisher;
  botUserId: string;
  bridgePubkey: string;
  log: Logger;
}

export class MmToRelay {
  readonly #deps: MmToRelayDeps;
  readonly #usernames = new Map<string, { userId: string | undefined; expires: number }>();
  readonly #teamNames = new Map<string, string>();

  constructor(deps: MmToRelayDeps) {
    this.#deps = deps;
  }

  /** Bring the relay in line with a post's current state: its first mirroring, newest edit or deletion. */
  async syncPost(post: MmPost, source: PostSource, options: SyncOptions = {}): Promise<void> {
    if (post.type !== '') return;
    const channel = await this.#deps.store.getChannel(post.channel_id);
    if (channel?.state !== 'active') return;
    const mapped = await this.#deps.store.getMessageByPost(post.id);
    if (options.deleted || post.delete_at !== 0) {
      if (mapped && !mapped.deletedAt) await this.#mirrorDeletion(channel, mapped);
      return;
    }
    if (!mapped) {
      // History from before enablement is mirrored only by backfill (or as the root of a newer reply).
      if (source === 'backfill') await this.mirrorPost(post, { backfill: true, rebuild: options.rebuild ?? false });
      else if (source === 'posted' || post.create_at >= channel.enabledAt.getTime()) await this.mirrorPost(post);
    } else if (mapped.origin === 'mm' && post.edit_at > mapped.mmEditAt) {
      await this.#mirrorEdit(channel, post, mapped);
    }
    if (options.reactions) await this.syncReactions(post.id, options.reactions);
  }

  /**
   * Mirror one post. Safe to call any number of times for the same post: message_map and the outbox
   * make it a no-op once the post is on the relay.
   */
  async mirrorPost(post: MmPost, options: { backfill?: boolean; rebuild?: boolean } = {}): Promise<void> {
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
    // An agent's post that carries a relay event id is the bridge's own copy of a relay message. Only a relay
    // rebuild publishes it again, as the agent (D19 gives the bridge the agent's key); split parts stay out.
    const agentCopy = author.kind === 'agent' && post.props?.relay_event_id !== undefined;
    if (agentCopy && (!options.rebuild || post.props?.relay_event_part !== undefined)) return;
    await channels.ensureMember(channel, author.pubkey);

    let rootEventId: string | undefined;
    if (post.root_id) {
      rootEventId = (await store.getMessageByPost(post.root_id))?.relayEventId;
      if (!rootEventId) {
        // The relay rejects replies to unknown parents, so mirror the root first (as history if it predates enablement).
        const root = await chat.getPost(post.root_id);
        if (root && root.delete_at === 0) await this.mirrorPost(root, { backfill: root.create_at < channel.enabledAt.getTime(), rebuild: options.rebuild ?? false });
        rootEventId = (await store.getMessageByPost(post.root_id))?.relayEventId;
        if (!rootEventId) throw new Error(`Thread root ${post.root_id} could not be mirrored`);
      }
    }

    const unsigned = buildPostEvent({
      relayChannelId: channel.relayChannelId,
      post,
      content: await this.#content(channel, post),
      rootEventId,
      mentionPubkeys: await this.#mentionPubkeys(post.message),
      backfill: options.backfill,
      nowMs: Date.now(),
    });
    const signed = (await identities.signerFor(author)).sign(unsigned);
    await publisher.publish({
      relayEventId: signed.id,
      purpose: 'post',
      mmPostId: post.id,
      mmChannelId: post.channel_id,
      authorMmUserId: post.user_id,
      signedEvent: signed,
      meta: { editAt: post.edit_at, origin: agentCopy ? 'relay' : 'mm' },
    });
  }

  /** Kind 40003 with the full new text, signed by the original author (spike A4). */
  async #mirrorEdit(channel: ChannelRow, post: MmPost, mapped: MessageState): Promise<void> {
    const { identities, publisher } = this.#deps;
    const author = await identities.existing(mapped.authorMmUserId);
    if (!author) return;
    const unsigned = buildEditEvent({
      relayChannelId: channel.relayChannelId,
      targetEventId: mapped.relayEventId,
      postId: post.id,
      content: await this.#content(channel, post),
      editAtMs: post.edit_at,
      mentionPubkeys: await this.#mentionPubkeys(post.message),
      nowMs: Date.now(),
    });
    const signed = (await identities.signerFor(author)).sign(unsigned);
    await publisher.publish({ relayEventId: signed.id, purpose: 'edit', mmPostId: post.id, mmChannelId: post.channel_id, authorMmUserId: mapped.authorMmUserId, signedEvent: signed, meta: { editAt: post.edit_at } });
  }

  /**
   * A person's message is deleted by its author's key (kind 5). An agent's message deleted in Mattermost
   * (by a person or an admin) is removed by the bridge as channel owner (kind 9005).
   */
  async #mirrorDeletion(channel: ChannelRow, mapped: MessageState): Promise<void> {
    const { identities, publisher } = this.#deps;
    const nowMs = Date.now();
    let signed;
    if (mapped.origin === 'mm') {
      const author = await identities.existing(mapped.authorMmUserId);
      if (!author) return;
      signed = (await identities.signerFor(author)).sign(buildDeletionEvent(5, channel.relayChannelId, mapped.relayEventId, nowMs));
    } else {
      signed = (await this.#deps.publisher.signerFor(this.#deps.bridgePubkey)).sign(buildDeletionEvent(9005, channel.relayChannelId, mapped.relayEventId, nowMs));
    }
    await publisher.publish({ relayEventId: signed.id, purpose: 'delete', mmPostId: mapped.mmPostId, mmChannelId: channel.mmChannelId, authorMmUserId: mapped.authorMmUserId, signedEvent: signed });
  }

  /**
   * Make the relay's reactions on a mirrored post match Mattermost's: one kind 7 per person and emoji,
   * removed with kind 5 when the last Mattermost reaction for it goes. Agents' reactions start on the relay.
   */
  async syncReactions(mmPostId: string, reactions?: MmReaction[]): Promise<void> {
    const { store, chat, identities, botUserId } = this.#deps;
    const mapped = await store.getMessageByPost(mmPostId);
    if (!mapped || mapped.deletedAt) return;
    const channel = await store.getChannel(mapped.mmChannelId);
    if (channel?.state !== 'active') return;
    const current = (reactions ?? (await chat.getReactions(mmPostId))).filter((reaction) => !reaction.delete_at && reaction.user_id !== botUserId);
    const known = await identities.mapped([...new Set(current.map((reaction) => reaction.user_id))]);
    const desired = new Map<string, { userId: string; emoji: string; emojiName: string }>();
    for (const reaction of current) {
      if (known.get(reaction.user_id)?.kind === 'agent') continue;
      const emoji = emojiForName(reaction.emoji_name);
      desired.set(`${reaction.user_id}\n${emoji}`, { userId: reaction.user_id, emoji, emojiName: reaction.emoji_name });
    }
    const mirrored = await store.listReactions(mmPostId, 'mm');
    const mirroredKeys = new Set(mirrored.map((row) => `${row.mmUserId}\n${row.emoji}`));
    for (const [key, want] of desired) if (!mirroredKeys.has(key)) await this.#addReaction(channel, mapped, want);
    for (const row of mirrored) if (!desired.has(`${row.mmUserId}\n${row.emoji}`)) await this.#removeReaction(channel, mapped, row);
  }

  async #addReaction(channel: ChannelRow, mapped: MessageState, want: { userId: string; emoji: string; emojiName: string }): Promise<void> {
    const { identities, publisher } = this.#deps;
    // Relay membership follows Mattermost membership only (reconciliation); reacting does not change it.
    const reactor = await identities.forUserId(want.userId);
    if (!reactor || reactor.kind === 'agent') return;
    const targetAuthor = await identities.existing(mapped.authorMmUserId);
    if (!targetAuthor) return;
    const signed = (await identities.signerFor(reactor)).sign(
      buildReactionEvent({ relayChannelId: channel.relayChannelId, targetEventId: mapped.relayEventId, targetAuthorPubkey: targetAuthor.pubkey, emoji: want.emoji, nowMs: Date.now() }),
    );
    await publisher.publish({ relayEventId: signed.id, purpose: 'reaction', mmPostId: mapped.mmPostId, mmChannelId: channel.mmChannelId, authorMmUserId: want.userId, signedEvent: signed, meta: { emoji: want.emoji, emojiName: want.emojiName } });
  }

  /**
   * Delete the reactor's relay reactions with this emoji on the target. They are looked up on the relay,
   * because a reaction it already had (answered `duplicate: reaction already exists`) has another id.
   */
  async #removeReaction(channel: ChannelRow, mapped: MessageState, row: ReactionRow): Promise<void> {
    const { identities, publisher, relay, readerSigner, store } = this.#deps;
    const reactor = await identities.existing(row.mmUserId);
    const active = reactor ? (await relay.query([{ kinds: [7], authors: [reactor.pubkey], '#e': [mapped.relayEventId] }], readerSigner)).filter((event) => event.content === row.emoji) : [];
    if (!reactor || active.length === 0) {
      await store.deleteReaction(row);
      return;
    }
    const signer = await identities.signerFor(reactor);
    for (const reaction of active) {
      const signed = signer.sign(buildDeletionEvent(5, channel.relayChannelId, reaction.id, Date.now()));
      await publisher.publish({ relayEventId: signed.id, purpose: 'unreaction', mmPostId: row.mmPostId, mmChannelId: channel.mmChannelId, authorMmUserId: row.mmUserId, signedEvent: signed, meta: { emoji: row.emoji } });
    }
  }

  /** The post's text plus attachment names and its permalink (files stay in Mattermost, spike A12). */
  async #content(channel: ChannelRow, post: MmPost): Promise<string> {
    if (!post.file_ids?.length) return post.message;
    const files = post.metadata?.files?.length ? post.metadata.files : await this.#deps.chat.getFileInfos(post.id);
    return postContent(
      post.message,
      files.map((file) => file.name),
      this.#deps.chat.permalink(await this.#teamName(channel.mmTeamId), post.id),
    );
  }

  async #teamName(teamId: string): Promise<string> {
    let name = this.#teamNames.get(teamId);
    if (!name) {
      name = (await this.#deps.chat.getTeam(teamId)).name;
      this.#teamNames.set(teamId, name);
    }
    return name;
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
