// People (FR-2; plan section 4): a person entity for every Mattermost account, created on first sight and kept
// in step by a daily job; external contacts without an account; roles in a container as member_of links; and
// "who knows about X", which ranks people by the evidence that links them to what matched.
import { GENERAL_CONTAINER_ID, type BrainStore, type Entity, type Link, type Scope, type SearchResult, type WriteContext } from '@brain/brain';
import { IdentityRepository, type ChatClient, type Logger, type MmUser, type Pool } from '@brain/shared';
import { AccessError } from './access.ts';

export const personKey = (mmUserId: string): string => `mm:${mmUserId}`;

export const CONTAINER_ROLES = ['sponsor', 'product_owner', 'end_user', 'developer', 'fde', 'reviewer', 'member', 'contact'] as const;
export type ContainerRole = (typeof CONTAINER_ROLES)[number];

/** Profile fields people and administrators edit (FR-2.1); Mattermost's own fields are refreshed by the sync. */
export interface ProfilePatch {
  role?: string;
  organisation?: string;
  expertise?: string[];
  responsibilities?: string[];
  workingHours?: string;
  preferredChannel?: string;
  managerId?: string | null;
}

export interface ExternalContactInput {
  name: string;
  emails?: string[];
  organisation?: string;
  role?: string;
  notes?: string;
}

export interface Suggestion {
  kind: 'expertise' | 'responsibility';
  value: string;
  by: string;
  at: string;
  reason?: string;
}

export interface WhoKnowsHit {
  person: Entity;
  score: number;
  evidence: { entityId: string; title: string; type: string; why: string }[];
}

const roleOf = (data: Record<string, unknown>): string => (typeof data.role === 'string' && data.role ? data.role : 'member');

export function displayNameOf(user: MmUser): string {
  const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
  return full || user.nickname || user.username;
}

/** The free text that makes a person findable by what they know. */
export function profileText(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const text = (label: string, value: unknown): void => {
    if (Array.isArray(value) && value.length > 0) lines.push(`${label}: ${value.map(String).join(', ')}`);
    else if (typeof value === 'string' && value.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  text('Role', data.role);
  text('Organisation', data.organisation);
  text('Expertise', data.expertise);
  text('Responsibilities', data.responsibilities);
  text('Notes', data.notes);
  return lines.join('\n');
}

export class PeopleService {
  readonly #store: BrainStore;
  readonly #chat: ChatClient;
  readonly #identities: IdentityRepository;
  readonly #log: Logger;

  constructor(deps: { store: BrainStore; chat: ChatClient; pool: Pool; log: Logger }) {
    this.#store = deps.store;
    this.#chat = deps.chat;
    this.#identities = new IdentityRepository(deps.pool);
    this.#log = deps.log;
  }

  byUserId(mmUserId: string): Promise<Entity | undefined> {
    return this.#store.getEntityByExternalKey(personKey(mmUserId));
  }

  /** The person entity for a Mattermost account; created from the account the first time it is seen. */
  async ensurePerson(mmUserId: string, known?: MmUser): Promise<Entity> {
    const existing = await this.byUserId(mmUserId);
    if (existing) return existing;
    const user = known ?? (await this.#chat.getUser(mmUserId));
    if (!user) throw new AccessError(404, 'No such user');
    return this.#upsertFromUser(user);
  }

  async #upsertFromUser(user: MmUser): Promise<Entity> {
    const data: Record<string, unknown> = { mmUserId: user.id, username: user.username, ...(user.email ? { email: user.email } : {}), ...(user.position ? { position: user.position } : {}), external: false, deactivated: user.delete_at !== 0 };
    const { entity } = await this.#store.upsertEntityByExternalKey(
      { type: 'person', title: displayNameOf(user), status: user.delete_at !== 0 ? 'inactive' : 'active', containerId: GENERAL_CONTAINER_ID, externalKey: personKey(user.id), visibility: 'public', data },
      { actor: { kind: 'system', id: 'people-sync' }, source: { kind: 'system', ref: `mm:user:${user.id}` } },
    );
    // The profile text comes from the fields people edit; a sync must not drop it.
    if (entity.text !== profileText(entity.data)) return this.#store.updateEntity(entity.id, { text: profileText(entity.data) }, { actor: { kind: 'system', id: 'people-sync' }, source: { kind: 'system' } });
    return entity;
  }

  /** Every Mattermost account becomes or stays a person (daily job; FR-2.1). Bots are agents, not people. */
  async syncAll(): Promise<{ seen: number; people: number }> {
    const users = (await this.#chat.listUsers()).filter((user) => !user.is_bot);
    let people = 0;
    for (const user of users) {
      await this.#upsertFromUser(user);
      people++;
    }
    this.#log.info({ users: users.length, people }, 'People synced from the chat');
    return { seen: users.length, people };
  }

  async updateProfile(person: Entity, patch: ProfilePatch, ctx: WriteContext): Promise<Entity> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) data[key] = value;
    const merged = { ...person.data, ...data };
    return this.#store.updateEntity(person.id, { data, text: profileText(merged) }, ctx);
  }

  async createExternal(input: ExternalContactInput, ctx: WriteContext): Promise<Entity> {
    const data = { external: true, emails: (input.emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean), organisation: input.organisation ?? '', role: input.role ?? '', notes: input.notes ?? '' };
    return this.#store.createEntity({ type: 'person', title: input.name.trim(), containerId: GENERAL_CONTAINER_ID, visibility: 'public', data, text: profileText(data) }, ctx);
  }

  // --- roles in a container (FR-2.3) ---

  async setRole(containerId: string, personId: string, role: ContainerRole, ctx: WriteContext): Promise<Link> {
    const { outgoing } = await this.#store.linksOf(personId, 'member_of');
    const existing = outgoing.find((link) => link.toId === containerId);
    if (existing) {
      if (existing.data.role === role) return existing;
      await this.#store.deleteLink(existing.id, ctx);
    }
    return this.#store.createLink({ fromId: personId, toId: containerId, kind: 'member_of', data: { role } }, ctx);
  }

  async removeRole(containerId: string, personId: string, ctx: WriteContext): Promise<boolean> {
    const { outgoing } = await this.#store.linksOf(personId, 'member_of');
    const existing = outgoing.find((link) => link.toId === containerId);
    return existing ? this.#store.deleteLink(existing.id, ctx) : false;
  }

  async members(containerId: string): Promise<{ person: Entity; role: string; linkId: number }[]> {
    const { incoming } = await this.#store.linksOf(containerId, 'member_of');
    const out: { person: Entity; role: string; linkId: number }[] = [];
    for (const link of incoming) {
      const person = await this.#store.getEntity(link.fromId);
      if (person && person.type === 'person') out.push({ person, role: roleOf(link.data), linkId: link.id });
    }
    return out.sort((a, b) => a.person.title.localeCompare(b.person.title));
  }

  /** Containers a person holds a role in (the access policy adds them to the person's scope). */
  async containersOf(personId: string): Promise<string[]> {
    const { outgoing } = await this.#store.linksOf(personId, 'member_of');
    return outgoing.map((link) => link.toId);
  }

  async memberships(personId: string): Promise<{ containerId: string; role: string }[]> {
    const { outgoing } = await this.#store.linksOf(personId, 'member_of');
    return outgoing.map((link) => ({ containerId: link.toId, role: roleOf(link.data) }));
  }

  // --- suggestions (FR-2.5; agents fill them in Phase 4) ---

  async decideSuggestion(person: Entity, index: number, accept: boolean, ctx: WriteContext): Promise<Entity> {
    const suggested = Array.isArray(person.data.suggested) ? ([...(person.data.suggested as Suggestion[])] as Suggestion[]) : [];
    const [item] = suggested.splice(index, 1);
    if (!item) throw new AccessError(404, 'No such suggestion');
    const data: Record<string, unknown> = { suggested };
    if (accept) {
      const field = item.kind === 'expertise' ? 'expertise' : 'responsibilities';
      const current = Array.isArray(person.data[field]) ? (person.data[field] as string[]) : [];
      if (!current.includes(item.value)) data[field] = [...current, item.value];
    }
    return this.#store.updateEntity(person.id, { data, text: profileText({ ...person.data, ...data }) }, ctx);
  }

  // --- who knows about X (FR-2.4) ---

  /**
   * People ranked by what links them to the search's hits: authors of matching conversations, owners and
   * creators of matching entities, assignees of matching tasks, people whose own profile matches.
   */
  async whoKnows(results: SearchResult[], scope: Scope): Promise<WhoKnowsHit[]> {
    void scope;
    const scores = new Map<string, WhoKnowsHit>();
    const pubkeyCache = new Map<string, Entity | undefined>();
    const personCache = new Map<string, Entity | undefined>();
    const person = async (id: string): Promise<Entity | undefined> => {
      if (!personCache.has(id)) {
        const entity = await this.#store.getEntity(id);
        personCache.set(id, entity?.type === 'person' ? entity : undefined);
      }
      return personCache.get(id);
    };
    const personByUser = async (mmUserId: string): Promise<Entity | undefined> => {
      const key = `mm:${mmUserId}`;
      if (!personCache.has(key)) personCache.set(key, await this.byUserId(mmUserId));
      return personCache.get(key);
    };
    const personByPubkey = async (pubkey: string): Promise<Entity | undefined> => {
      if (!pubkeyCache.has(pubkey)) {
        const identity = await this.#identities.getByPubkey(pubkey);
        pubkeyCache.set(pubkey, identity && identity.kind === 'person' ? await this.byUserId(identity.mmUserId) : undefined);
      }
      return pubkeyCache.get(pubkey);
    };
    const add = (who: Entity | undefined, weight: number, result: SearchResult, why: string): void => {
      if (!who || who.status === 'inactive') return;
      const hit = scores.get(who.id) ?? { person: who, score: 0, evidence: [] };
      hit.score += weight;
      if (hit.evidence.length < 3 && !hit.evidence.some((item) => item.entityId === result.entityId)) hit.evidence.push({ entityId: result.entityId, title: result.title, type: result.entityType, why });
      scores.set(who.id, hit);
    };
    for (const [rank, result] of results.entries()) {
      const weight = 1 / (rank + 3);
      if (result.entityType === 'person') {
        add(await person(result.entityId), weight * 3, result, 'profile');
        continue;
      }
      if (result.entityType === 'conversation') {
        const authors = Array.isArray(result.metadata.authors) ? (result.metadata.authors as { id: string }[]) : [];
        for (const author of authors) add(await personByPubkey(author.id), weight, result, 'took part in the conversation');
        continue;
      }
      const entity = await this.#store.getEntity(result.entityId);
      if (!entity) continue;
      if (entity.ownerId) add(await person(entity.ownerId), weight * 2, result, `owns the ${entity.type}`);
      if (entity.type === 'task' && typeof entity.data.assigneeId === 'string') add(await person(entity.data.assigneeId), weight * 2, result, 'is assigned the task');
      add(await personByUser(entity.createdBy), weight * 1.5, result, `created the ${entity.type}`);
      const { incoming } = await this.#store.linksOf(entity.id, 'raised_by');
      for (const link of incoming) add(await person(link.fromId), weight * 2, result, `raised the ${entity.type}`);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score);
  }
}
