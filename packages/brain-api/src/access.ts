// Who the caller is and what they may see (FR-9.5; plan section 5). A person's channels come from Mattermost
// through ChatClient with the @brain token, cached briefly, never snapshotted into our tables.
import { GENERAL_CONTAINER_ID, type BrainStore, type Entity, type Scope } from '@brain/brain';
import { relayChannelIdFor, type ChatClient } from '@brain/shared';

export type Principal =
  | { kind: 'person'; userId: string; username: string; isAdmin: boolean }
  | { kind: 'service'; userId: 'service' }
  | { kind: 'agent'; userId: string; handle: string };

export interface Membership {
  /** Mattermost ids of the person's open and private channels. */
  mmChannelIds: string[];
  /** The same channels as relay ids (D18), which conversations carry. */
  relayChannelIds: string[];
  containerIds: string[];
  isAdmin: boolean;
  username: string;
}

/** How long a person's channel list is reused; a membership change shows in search within this time. */
const CACHE_MS = 20_000;

export class AccessService {
  readonly #chat: ChatClient;
  readonly #store: BrainStore;
  readonly #cache = new Map<string, { at: number; value: Membership }>();

  constructor(chat: ChatClient, store: BrainStore) {
    this.#chat = chat;
    this.#store = store;
  }

  /** Forget a person's cached memberships (after a change we made ourselves). */
  invalidate(userId: string): void {
    this.#cache.delete(userId);
  }

  async membership(userId: string): Promise<Membership> {
    const cached = this.#cache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const user = await this.#chat.getUser(userId);
    if (!user || user.delete_at !== 0) throw new AccessError(401, 'Unknown or deactivated user');
    const isAdmin = user.roles.split(' ').includes('system_admin');
    const mmChannelIds: string[] = [];
    for (const team of await this.#chat.getMyTeams()) {
      for (const channel of await this.#chat.getUserChannels(userId, team.id)) {
        if ((channel.type === 'O' || channel.type === 'P') && channel.delete_at === 0) mmChannelIds.push(channel.id);
      }
    }
    const containerIds = [GENERAL_CONTAINER_ID, ...(await this.#store.containersOfChannels(mmChannelIds))];
    const value: Membership = { mmChannelIds, relayChannelIds: mmChannelIds.map(relayChannelIdFor), containerIds, isAdmin, username: user.username };
    this.#cache.set(userId, { at: Date.now(), value });
    return value;
  }

  async scope(principal: Principal): Promise<Scope> {
    if (principal.kind === 'service') return { kind: 'all' };
    if (principal.kind === 'agent') throw new AccessError(403, 'Agents search through their channel scope');
    if (principal.isAdmin) return { kind: 'all' };
    const membership = await this.membership(principal.userId);
    return { kind: 'person', channelIds: membership.relayChannelIds, containerIds: membership.containerIds };
  }

  async canSeeEntity(principal: Principal, entity: Entity): Promise<boolean> {
    const scope = await this.scope(principal);
    if (scope.kind === 'all') return true;
    if (scope.kind === 'channel') return entity.channelId === scope.channelId || entity.visibility === 'public';
    switch (entity.visibility) {
      case 'public':
        return true;
      case 'members':
        return entity.channelId !== null && scope.channelIds.includes(entity.channelId);
      case 'container':
        return scope.containerIds.includes(entity.containerId);
    }
  }

  /** May the caller write? Phase 0: any signed-in person or the service; agents propose in Phase 2. Containers are listed for everyone signed in (names are like channel names); entities are scoped. */
  canWrite(principal: Principal): boolean {
    return principal.kind !== 'agent';
  }
}

export class AccessError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
