// Systems (FR-3; plan section 5): installation-wide `system` entities in General, linked to the Projects and
// Topics that use them (FR-3.7); their artifacts are documents attached to them (FR-3.2, FR-3.3, read into
// structure at extraction); integrations are typed links between systems (FR-3.4); the inventory lives in data
// (FR-3.5); versions and diffs come from the entity's history (FR-3.6).
import { GENERAL_CONTAINER_ID, type BrainStore, type Entity, type Link, type WriteContext } from '@brain/brain';
import { AccessError } from './access.ts';

export interface Environment {
  name: string;
  url?: string;
  notes?: string;
}

export interface SystemInput {
  title: string;
  description?: string;
  businessOwnerId?: string;
  technicalOwnerId?: string;
  stack?: string[];
  environments?: Environment[];
  repositories?: string[];
  deployment?: string;
  containerIds?: string[];
}

export interface SystemPatch extends Partial<Omit<SystemInput, 'title' | 'containerIds'>> {
  title?: string;
  inventory?: { screens?: string[]; modules?: string[]; knownIssues?: string[]; painPoints?: string[] };
}

export interface IntegrationInput {
  toSystemId: string;
  protocol?: string;
  payload?: string;
  direction?: 'calls' | 'is_called_by' | 'both';
  notes?: string;
}

/** The free text that makes a system findable: description, stack, environments, repositories, inventory. */
export function systemText(title: string, data: Record<string, unknown>): string {
  const lines = [title];
  const add = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) lines.push(`${label}: ${value.trim()}`);
    else if (Array.isArray(value) && value.length > 0) lines.push(`${label}: ${value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')}`);
  };
  add('Description', data.description);
  add('Stack', data.stack);
  add('Deployment', data.deployment);
  add('Environments', Array.isArray(data.environments) ? (data.environments as Environment[]).map((env) => `${env.name}${env.url ? ` ${env.url}` : ''}`) : undefined);
  add('Repositories', data.repositories);
  const inventory = (data.inventory ?? {}) as Record<string, unknown>;
  add('Screens', inventory.screens);
  add('Modules', inventory.modules);
  add('Known issues', inventory.knownIssues);
  add('Pain points', inventory.painPoints);
  return lines.join('\n');
}

export class SystemService {
  readonly #store: BrainStore;

  constructor(store: BrainStore) {
    this.#store = store;
  }

  async create(input: SystemInput, ctx: WriteContext): Promise<Entity> {
    const { containerIds = [], title, ...fields } = input;
    const data: Record<string, unknown> = { description: '', stack: [], environments: [], repositories: [], deployment: '', inventory: { screens: [], modules: [], knownIssues: [], painPoints: [] }, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    const system = await this.#store.createEntity({ type: 'system', title, containerId: GENERAL_CONTAINER_ID, visibility: 'public', data, text: systemText(title, data) }, ctx);
    for (const containerId of containerIds) await this.linkContainer(system, containerId, ctx);
    return system;
  }

  async update(system: Entity, patch: SystemPatch, ctx: WriteContext): Promise<Entity> {
    const { title, ...fields } = patch;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) data[key] = key === 'inventory' ? { ...(system.data.inventory as Record<string, unknown> | undefined), ...(value as Record<string, unknown>) } : value;
    const merged = { ...system.data, ...data };
    return this.#store.updateEntity(system.id, { ...(title ? { title } : {}), data, text: systemText(title ?? system.title, merged) }, ctx);
  }

  async linkContainer(system: Entity, containerId: string, ctx: WriteContext): Promise<Link> {
    const container = await this.#store.getContainer(containerId);
    if (!container || container.kind === 'general') throw new AccessError(404, 'No such Project or Topic');
    const { outgoing } = await this.#store.linksOf(system.id, 'belongs_to');
    return outgoing.find((link) => link.toId === container.id) ?? this.#store.createLink({ fromId: system.id, toId: container.id, kind: 'belongs_to' }, ctx);
  }

  async unlinkContainer(system: Entity, containerId: string, ctx: WriteContext): Promise<boolean> {
    const { outgoing } = await this.#store.linksOf(system.id, 'belongs_to');
    const link = outgoing.find((candidate) => candidate.toId === containerId);
    return link ? this.#store.deleteLink(link.id, ctx) : false;
  }

  async containersOf(system: Entity): Promise<string[]> {
    const { outgoing } = await this.#store.linksOf(system.id, 'belongs_to');
    return outgoing.map((link) => link.toId);
  }

  /** `depends_on` from this system to another, with protocol and payload (FR-3.4). */
  async addIntegration(system: Entity, input: IntegrationInput, ctx: WriteContext): Promise<Link> {
    const other = await this.#store.getEntity(input.toSystemId);
    if (!other || other.type !== 'system') throw new AccessError(404, 'No such system');
    if (other.id === system.id) throw new AccessError(400, 'A system cannot integrate with itself');
    const data = { protocol: input.protocol ?? '', payload: input.payload ?? '', direction: input.direction ?? 'calls', notes: input.notes ?? '' };
    const { outgoing } = await this.#store.linksOf(system.id, 'depends_on');
    const existing = outgoing.find((link) => link.toId === other.id);
    if (existing) await this.#store.deleteLink(existing.id, ctx);
    return this.#store.createLink({ fromId: system.id, toId: other.id, kind: 'depends_on', data }, ctx);
  }

  async integrations(system: Entity): Promise<{ link: Link; other: Entity; direction: 'outgoing' | 'incoming' }[]> {
    const { outgoing, incoming } = await this.#store.linksOf(system.id, 'depends_on');
    const out: { link: Link; other: Entity; direction: 'outgoing' | 'incoming' }[] = [];
    for (const link of outgoing) {
      const other = await this.#store.getEntity(link.toId);
      if (other?.type === 'system') out.push({ link, other, direction: 'outgoing' });
    }
    for (const link of incoming) {
      const other = await this.#store.getEntity(link.fromId);
      if (other?.type === 'system') out.push({ link, other, direction: 'incoming' });
    }
    return out;
  }

  /** The documents attached to the system (its artifacts among them). */
  async artifacts(system: Entity): Promise<Entity[]> {
    const { incoming } = await this.#store.linksOf(system.id, 'attached_to');
    const out: Entity[] = [];
    for (const link of incoming) {
      const document = await this.#store.getEntity(link.fromId);
      if (document?.type === 'document' && !document.archivedAt) out.push(document);
    }
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}
