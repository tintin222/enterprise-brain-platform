// Relay -> Mattermost mirroring of agent-authored messages (docs/bridge-spec.md section 6).
import { errorFields, replyTarget, secretRefs, tagValue, tagValues, type ChatClient, type KeyStore, type Logger, type MmPost, type NostrEvent, type RelayClient, type Signer } from '@brain/shared';
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

export class RelayToMm {
  readonly #deps: RelayToMmDeps;
  readonly #botClients = new Map<string, ChatClient>();
  readonly #lastTyping = new Map<string, number>();

  constructor(deps: RelayToMmDeps) {
    this.#deps = deps;
  }

  /** Mirror one relay event into Mattermost if it is an agent's message in an active channel. Idempotent. */
  async handle(channel: ChannelRow, event: NostrEvent): Promise<void> {
    if (channel.state !== 'active') return;
    if (event.kind === 9) await this.#mirrorMessage(channel, event);
    else if (event.kind === 20002) await this.#mirrorTyping(channel, event);
  }

  /** Agents signal typing with ephemeral kind 20002 (sent over WebSocket); show it in Mattermost as the bot. */
  async #mirrorTyping(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const key = `${event.pubkey}:${channel.mmChannelId}`;
    const now = Date.now();
    if (now - (this.#lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
    this.#lastTyping.set(key, now);
    try {
      const author = await this.#deps.identities.byPubkey(event.pubkey);
      if (author?.kind !== 'agent') return;
      const rootEventId = tagValue(event, 'e');
      const root = rootEventId ? await this.#deps.store.getMessageByEvent(rootEventId) : undefined;
      const bot = await this.#botClient(author.mmUserId);
      await bot.sendTyping(author.mmUserId, channel.mmChannelId, root?.mmPostId ?? undefined);
    } catch (error) {
      this.#deps.log.debug({ relayEventId: event.id, ...errorFields(error) }, 'Could not show typing in Mattermost');
    }
  }

  async #mirrorMessage(channel: ChannelRow, event: NostrEvent): Promise<void> {
    const { store, identities, log } = this.#deps;
    const author = await identities.byPubkey(event.pubkey);
    // Only agents' messages flow back; people's messages originate in Mattermost.
    if (author?.kind !== 'agent') return;
    const existing = await store.getMessageByEvent(event.id);
    if (existing?.mmPostId) return;
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
