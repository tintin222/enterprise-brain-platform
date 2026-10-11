// Relay -> Mattermost mirroring of agent-authored events (docs/bridge-spec.md section 6): messages, edits,
// deletions, reactions and typing. Only agents' events flow back; people's events originate in Mattermost.
import {
  ChatApiError,
  errorFields,
  replyTarget,
  secretRefs,
  tagValue,
  tagValues,
  type ChatClient,
  type Identity,
  type KeyStore,
  type Logger,
  type MmPost,
  type NostrEvent,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import { emojiForName, nameForEmoji } from './emoji.ts';
import { displayNameOf, type IdentityService } from './identities.ts';
import type { BridgeStore, ChannelRow } from './store.ts';

/** Mattermost's post limit is about 16,000 characters; longer agent messages become consecutive posts. */
export const MAX_POST_CHARS = 16_000;

export function splitMessage(text: string, max = MAX_POST_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The event a reaction is about: the last `e` tag (NIP-25). */
function reactionTarget(event: Pick<NostrEvent, 'tags'>): string | undefined {
  return event.tags.findLast((tag) => tag[0] === 'e')?.[1];
}

export interface RelayToMmDeps {
  chat: ChatClient;
  store: BridgeStore;
  identities: IdentityService;
  keyStore: KeyStore;
  relay: RelayClient;
  readerSigner: Signer;
  log: Logger;
}

/** Mattermost shows "is typing" for about 5 s; agents re-send every 4 s, so forward at most every 2 s. */
const TYPING_THROTTLE_MS = 2000;

const ignoreNotFound = (error: unknown): void => {
  if (!(error instanceof ChatApiError && error.status === 404)) throw error;
};

export class RelayToMm {
  readonly #deps: RelayToMmDeps;
  readonly #botClients = new Map<string, ChatClient>();
  readonly #lastTyping = new Map<string, number>();

  constructor(deps: RelayToMmDeps) {
    this.#deps = deps;
  }

  /** Mirror one relay event into Mattermost if it is an agent's event in an active channel. Idempotent. */
  async handle(channel: ChannelRow, event: NostrEvent): Promise<void> {
    if (channel.state !== 'active') return;
    switch (event.kind) {
      case 9:
        return this.#mirrorMessage(channel, event);
      case 40003:
        return this.#mirrorEdit(event);
      case 5:
        return this.#mirrorDeletion(event);
      case 7:
        return this.#mirrorReaction(channel, event);
      case 20002:
        return this.#mirrorTyping(channel, event);
      default:
        // Kind 9005 is a channel admin's delete; agents are never channel admins.
        return;
    }
  }

  async #agent(event: NostrEvent): Promise<Identity | undefined> {
    const author = await this.#deps.identities.byPubkey(event.pubkey);
    return author?.kind === 'agent' ? author : undefined;
  }

  /** Agents signal typing with ephemeral kind 20002 (sent over WebSocket); show it in Mattermost as the bot. */
  async #mirrorTyping(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const key = `${event.pubkey}:${channel.mmChannelId}`;
    const now = Date.now();
    if (now - (this.#lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
    this.#lastTyping.set(key, now);
    try {
      const author = await this.#agent(event);
      if (!author) return;
      const rootEventId = tagValue(event, 'e');
      const root = rootEventId ? await this.#deps.store.getMessageByEvent(rootEventId) : undefined;
      const bot = await this.#botClient(author.mmUserId);
      await bot.sendTyping(author.mmUserId, channel.mmChannelId, root?.mmPostId ?? undefined);
    } catch (error) {
      this.#deps.log.debug({ relayEventId: event.id, ...errorFields(error) }, 'Could not show typing in Mattermost');
    }
  }

  async #mirrorMessage(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const { store, log } = this.#deps;
    const author = await this.#agent(event);
    if (!author) return;
    const existing = await store.getMessageByEvent(event.id);
    if (existing?.mmPostId || existing?.deletedAt) return;
    if (existing) {
      // An earlier attempt may have created the post and stopped before recording it.
      const copy = await this.#findPostedCopy(channel, event, author.mmUserId);
      if (copy) {
        await store.setMessagePost(event.id, copy.id);
        return;
      }
    } else {
      const inserted = await store.insertMessage({ relayEventId: event.id, mmPostId: null, origin: 'relay', mmChannelId: channel.mmChannelId, authorMmUserId: author.mmUserId });
      if (!inserted && (await store.getMessageByEvent(event.id))?.mmPostId) return;
    }

    const bot = await this.#botClient(author.mmUserId);
    const rootId = await this.#threadRootPostId(channel, event);
    const parts = splitMessage(await this.#rewriteMentions(event));
    const first = await bot.createPost({ channel_id: channel.mmChannelId, message: parts[0] ?? '', ...(rootId ? { root_id: rootId } : {}), props: { relay_event_id: event.id } });
    await store.setMessagePost(event.id, first.id);
    for (const [index, part] of parts.slice(1).entries()) {
      await bot.createPost({ channel_id: channel.mmChannelId, message: part, root_id: rootId ?? first.id, props: { relay_event_id: event.id, relay_event_part: index + 2 } });
    }
    log.info({ relayEventId: event.id, mmPostId: first.id, mmChannelId: channel.mmChannelId }, 'Mirrored agent message to Mattermost');
  }

  /** Kind 40003: apply the newest edit (by created_at, then id) to the agent's post. */
  async #mirrorEdit(event: NostrEvent): Promise<void> {
    const { store, log } = this.#deps;
    const author = await this.#agent(event);
    const target = tagValue(event, 'e');
    if (!author || !target) return;
    const mapped = await store.getMessageByEvent(target);
    if (!mapped?.mmPostId || mapped.origin !== 'relay' || mapped.deletedAt || mapped.authorMmUserId !== author.mmUserId) return;
    if (event.created_at < mapped.relayEditAt || (event.created_at === mapped.relayEditAt && event.id <= (mapped.relayEditId ?? ''))) return;
    const bot = await this.#botClient(author.mmUserId);
    // Mattermost edits one post; a message long enough to have been split keeps its later parts.
    const [first] = splitMessage(await this.#rewriteMentions(event));
    await bot.patchPost(mapped.mmPostId, { message: first ?? '' });
    await store.setMessageEditedOnRelay(target, event.created_at, event.id);
    log.info({ relayEventId: target, editEventId: event.id, mmPostId: mapped.mmPostId }, 'Mirrored agent edit to Mattermost');
  }

  /** Kind 5 by an agent: delete its post (and the post's split parts), or remove its reaction. */
  async #mirrorDeletion(event: NostrEvent): Promise<void> {
    const { store, chat, log } = this.#deps;
    const author = await this.#agent(event);
    const target = tagValue(event, 'e');
    if (!author || !target) return;
    const reaction = await store.getReactionByEvent(target);
    if (reaction) {
      if (reaction.origin !== 'relay' || reaction.mmUserId !== author.mmUserId) return;
      const bot = await this.#botClient(author.mmUserId);
      await bot.removeReaction(author.mmUserId, reaction.mmPostId, reaction.emojiName).catch(ignoreNotFound);
      await store.deleteReaction(reaction);
      log.info({ relayEventId: target, mmPostId: reaction.mmPostId, emoji: reaction.emojiName }, 'Mirrored agent reaction removal to Mattermost');
      return;
    }
    const mapped = await store.getMessageByEvent(target);
    if (!mapped || mapped.origin !== 'relay' || mapped.deletedAt || mapped.authorMmUserId !== author.mmUserId) return;
    // Mark first: the post_deleted event this causes must not be mirrored back as a deletion.
    await store.markMessageDeleted(target);
    if (!mapped.mmPostId) return;
    const bot = await this.#botClient(author.mmUserId);
    const post = await chat.getPost(mapped.mmPostId);
    const thread = post ? await chat.getThread(post.root_id || post.id).catch(() => []) : [];
    await bot.deletePost(mapped.mmPostId).catch(ignoreNotFound);
    for (const part of thread.filter((p) => p.id !== mapped.mmPostId && p.props?.relay_event_id === target && p.delete_at === 0)) {
      await bot.deletePost(part.id).catch(ignoreNotFound);
    }
    log.info({ relayEventId: target, mmPostId: mapped.mmPostId }, 'Mirrored agent deletion to Mattermost');
  }

  /** Kind 7 by an agent: add the reaction as its bot. */
  async #mirrorReaction(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const { store, log } = this.#deps;
    const author = await this.#agent(event);
    const target = reactionTarget(event);
    if (!author || !target) return;
    if (await store.getReactionByEvent(event.id)) return;
    const mapped = await store.getMessageByEvent(target);
    if (!mapped?.mmPostId || mapped.deletedAt) return;
    const emojiName = nameForEmoji(event.content);
    if (!emojiName) {
      log.info({ relayEventId: event.id }, 'Agent reaction has no Mattermost emoji; not mirrored');
      return;
    }
    const bot = await this.#botClient(author.mmUserId);
    // Adding an existing reaction is harmless, so record it only once Mattermost has it.
    await bot.addReaction(author.mmUserId, mapped.mmPostId, emojiName);
    await store.insertReaction({ mmPostId: mapped.mmPostId, mmUserId: author.mmUserId, emoji: emojiForName(emojiName), emojiName, relayEventId: event.id, origin: 'relay', mmChannelId: channel.mmChannelId });
    log.info({ relayEventId: event.id, mmPostId: mapped.mmPostId, emoji: emojiName }, 'Mirrored agent reaction to Mattermost');
  }

  async #findPostedCopy(channel: ChannelRow, event: NostrEvent, botUserId: string): Promise<MmPost | undefined> {
    const posts = await this.#deps.chat.getPostsSince(channel.mmChannelId, event.created_at * 1000 - 15 * 60 * 1000);
    return posts.find((post) => post.user_id === botUserId && post.props?.relay_event_id === event.id && post.props.relay_event_part === undefined);
  }

  /** Mattermost threads are flat: reply to the root of the parent's thread. */
  async #threadRootPostId(channel: ChannelRow, event: NostrEvent): Promise<string | undefined> {
    const { store, relay, readerSigner, chat, log } = this.#deps;
    const parentId = replyTarget(event);
    if (!parentId) return undefined;
    let parent = await store.getMessageByEvent(parentId);
    if (!parent?.mmPostId) {
      // The parent may be another agent message that has not been mirrored yet.
      const [parentEvent] = await relay.query([{ ids: [parentId] }], readerSigner);
      if (parentEvent) await this.handle(channel, parentEvent);
      parent = await store.getMessageByEvent(parentId);
    }
    if (!parent?.mmPostId) {
      log.warn({ relayEventId: event.id, parentId }, 'Reply parent is not in Mattermost; posting at the top level');
      return undefined;
    }
    const post = await chat.getPost(parent.mmPostId);
    if (!post || post.delete_at !== 0) return undefined;
    return post.root_id || post.id;
  }

  /** Agents mention people as "@Display Name" plus a p tag (spike A3); Mattermost needs @username. */
  async #rewriteMentions(event: NostrEvent): Promise<string> {
    let content = event.content;
    for (const pubkey of new Set(tagValues(event, 'p'))) {
      const identity = await this.#deps.identities.byPubkey(pubkey);
      if (identity?.kind !== 'person') continue;
      const user = await this.#deps.chat.getUser(identity.mmUserId);
      if (!user) continue;
      const name = displayNameOf(user);
      if (name !== user.username) content = content.replaceAll(`@${name}`, `@${user.username}`);
    }
    return content;
  }

  async #botClient(mmUserId: string): Promise<ChatClient> {
    const cached = this.#botClients.get(mmUserId);
    if (cached) return cached;
    const token = await this.#deps.keyStore.getSecretText(secretRefs.agentToken(mmUserId));
    if (!token) throw new Error(`No Mattermost token stored for agent bot ${mmUserId}`);
    const client = this.#deps.chat.withToken(token);
    this.#botClients.set(mmUserId, client);
    return client;
  }
}
