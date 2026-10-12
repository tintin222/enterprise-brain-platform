// Projects and Topics as workspaces (FR-1; plan section 3): creation with the channel group, Topics from a
// channel, spawning a Project from a Topic and moving its items, the home page's panels, the timeline and the
// stale flag. Containers themselves are Phase 0's; this module fills them.
import { GENERAL_CONTAINER_ID, slugify, type BrainStore, type Container, type Entity, type Link, type WriteContext } from '@brain/brain';
import { errorFields, type ChatClient, type Logger, type MmChannel } from '@brain/shared';
import { AccessError, type AccessService, type Principal } from './access.ts';
import type { ChannelLinker } from './channels.ts';
import type { PeopleService } from './people.ts';
import { containerUrl } from './present.ts';

export interface ProjectInput {
  title: string;
  client?: string;
  goal?: string;
  scope?: string;
  stage?: string;
  startsOn?: string;
  endsOn?: string;
  budget?: string;
  stakeholderIds?: string[];
  parentTopicId?: string;
  /** Create the channel group (FR-1.2); false links nothing. */
  channels?: boolean;
  private?: boolean;
  /** Existing channels to link as well. */
  linkChannelIds?: string[];
}

export interface TopicInput {
  title: string;
  kind: 'internal' | 'external';
  organisation?: string;
  description?: string;
  ownerId?: string;
  contactIds?: string[];
  systemIds?: string[];
  /** Promote an existing channel (FR-1.7, `/topic here`) or create one (`/topic new`). */
  channel: { mmChannelId: string } | { create: true; name?: string; private?: boolean };
}

export interface Milestone {
  title: string;
  date: string;
  kind: 'milestone' | 'phase';
  done?: boolean;
}

export interface HomePanels {
  container: Container;
  owner: Entity | undefined;
  channels: { mmChannelId: string; role: string }[];
  people: { person: Entity; role: string }[];
  systems: Entity[];
  requirements: { open: number; recent: Entity[] };
  tasks: { open: number; recent: Entity[] };
  decisions: Entity[];
  documents: Entity[];
  conversations: Entity[];
  milestones: Milestone[];
  package: { status: 'not_available'; note: string };
  stale: boolean;
  spawnedFrom: Container | undefined;
}

export interface WorkspaceDeps {
  store: BrainStore;
  chat: ChatClient;
  adminChat: ChatClient;
  access: AccessService;
  people: PeopleService;
  linker: ChannelLinker;
  botUserId: string;
  teamName: string;
  publicUrl: string;
  staleDays: number;
  log: Logger;
}

const OPEN_TASK_STATES = ['open', 'in_progress'];
const OPEN_REQUIREMENT_STATUSES = ['draft', 'clarifying', 'confirmed', 'in_development'];

export class WorkspaceService {
  readonly #deps: WorkspaceDeps;

  constructor(deps: WorkspaceDeps) {
    this.#deps = deps;
  }

  // --- projects (FR-1.1, 1.2, 1.9) ---

  async createProject(input: ProjectInput, principal: Principal, ctx: WriteContext): Promise<{ container: Container; channels: MmChannel[] }> {
    const { store, people } = this.#deps;
    const parent = input.parentTopicId ? await store.getContainer(input.parentTopicId) : undefined;
    if (input.parentTopicId && (!parent || parent.kind !== 'topic')) throw new AccessError(404, 'No such Topic to spawn from');
    const data: Record<string, unknown> = {
      client: input.client ?? '',
      goal: input.goal ?? '',
      scope: input.scope ?? '',
      stage: input.stage ?? 'discovery',
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      budget: input.budget ?? '',
      stakeholderIds: input.stakeholderIds ?? [],
      milestones: [],
      stale: false,
      ...(parent ? { spawnedFrom: parent.id } : {}),
    };
    const container = await store.createContainer({ kind: 'project', title: input.title, ownerId: principal.kind === 'person' ? principal.personId : undefined, data }, ctx);
    if (principal.kind === 'person') this.#deps.access.invalidate(principal.userId);
    for (const personId of input.stakeholderIds ?? []) await people.setRole(container.id, personId, 'sponsor', ctx);
    if (parent) {
      await store.createLink({ fromId: container.id, toId: parent.id, kind: 'spawned_from' }, ctx);
      // The Topic's people and systems come along as links (FR-1.9).
      for (const member of await people.members(parent.id)) await people.setRole(container.id, member.person.id, member.role as 'member', ctx);
      for (const system of await this.systemsOf(parent.id)) await store.createLink({ fromId: system.id, toId: container.id, kind: 'belongs_to' }, ctx).catch(() => undefined);
    }
    const channels: MmChannel[] = [];
    if (input.channels !== false) channels.push(...(await this.#createChannelGroup(container, principal, input.private ?? false, ctx)));
    for (const mmChannelId of input.linkChannelIds ?? []) await this.#deps.linker.attach(container, mmChannelId, 'linked', principal, ctx);
    return { container: (await store.getContainer(container.id)) ?? container, channels };
  }

  /** `#proj-<slug>`, `#proj-<slug>-requirements`, `#proj-<slug>-agent` in the creator's team, with @brain and the creator in each. */
  async #createChannelGroup(container: Container, principal: Principal, isPrivate: boolean, ctx: WriteContext): Promise<MmChannel[]> {
    const { adminChat, botUserId, linker, teamName, log } = this.#deps;
    const team = await adminChat.getTeamByName(teamName);
    if (!team) throw new AccessError(500, `The team ${teamName} does not exist`);
    const base = `proj-${container.slug}`.slice(0, 50);
    const wanted: { name: string; display: string; role: 'home' | 'requirements' | 'agent'; purpose: string }[] = [
      { name: base, display: container.title, role: 'home', purpose: `Project ${container.title}: the home channel. ${containerUrl({ publicUrl: this.#deps.publicUrl }, container.id)}` },
      { name: `${base}-requirements`, display: `${container.title} · requirements`, role: 'requirements', purpose: `Requirements for ${container.title}; the Analyst agent works here.` },
      { name: `${base}-agent`, display: `${container.title} · agent`, role: 'agent', purpose: `Agents' notes and proposals for ${container.title}.` },
    ];
    const created: MmChannel[] = [];
    for (const spec of wanted) {
      let channel = await adminChat.getChannelByName(team.id, spec.name);
      if (!channel || channel.delete_at !== 0) {
        channel = await adminChat.createChannel({ team_id: team.id, name: spec.name, display_name: spec.display.slice(0, 64), type: isPrivate ? 'P' : 'O', purpose: spec.purpose.slice(0, 250) });
      }
      for (const userId of [botUserId, ...(principal.kind === 'person' ? [principal.userId] : [])]) {
        await adminChat.addChannelMember(channel.id, userId).catch((error: unknown) => log.warn({ channel: spec.name, userId, ...errorFields(error) }, 'Could not add a member to a project channel'));
      }
      await linker.attach(container, channel.id, spec.role, principal, ctx);
      created.push(channel);
    }
    return created;
  }

  // --- topics (FR-1.7) ---

  async createTopic(input: TopicInput, principal: Principal, ctx: WriteContext): Promise<{ container: Container; channel: MmChannel }> {
    const { store, adminChat, people, linker, teamName, botUserId, log } = this.#deps;
    const data: Record<string, unknown> = { topicKind: input.kind, organisation: input.organisation ?? '', description: input.description ?? '', contactIds: input.contactIds ?? [] };
    const container = await store.createContainer({ kind: 'topic', title: input.title, ownerId: input.ownerId ?? (principal.kind === 'person' ? principal.personId : undefined), data }, ctx);
    if (principal.kind === 'person') this.#deps.access.invalidate(principal.userId);
    let channel: MmChannel | undefined;
    if ('mmChannelId' in input.channel) {
      channel = await adminChat.getChannel(input.channel.mmChannelId);
      if (!channel) throw new AccessError(404, 'No such channel');
    } else {
      const team = await adminChat.getTeamByName(teamName);
      if (!team) throw new AccessError(500, `The team ${teamName} does not exist`);
      const name = slugify(input.channel.name ?? `topic-${container.slug}`).slice(0, 60);
      channel = (await adminChat.getChannelByName(team.id, name)) ?? (await adminChat.createChannel({ team_id: team.id, name, display_name: input.title.slice(0, 64), type: input.channel.private ? 'P' : 'O', purpose: (input.description ?? '').slice(0, 250) }));
      for (const userId of [botUserId, ...(principal.kind === 'person' ? [principal.userId] : [])]) {
        await adminChat.addChannelMember(channel.id, userId).catch((error: unknown) => log.warn({ channel: name, userId, ...errorFields(error) }, 'Could not add a member to the topic channel'));
      }
    }
    await linker.attach(container, channel.id, 'home', principal, ctx);
    for (const personId of input.contactIds ?? []) await people.setRole(container.id, personId, 'contact', ctx);
    for (const systemId of input.systemIds ?? []) await store.createLink({ fromId: systemId, toId: container.id, kind: 'belongs_to' }, ctx).catch(() => undefined);
    return { container: (await store.getContainer(container.id)) ?? container, channel };
  }

  /** Requirements, tasks and documents raised in a Topic go to a Project, moved or linked (FR-1.9). */
  async moveItems(topic: Container, project: Container, entityIds: string[], mode: 'move' | 'link', ctx: WriteContext): Promise<{ moved: string[]; linked: string[]; skipped: string[] }> {
    const { store } = this.#deps;
    const result = { moved: [] as string[], linked: [] as string[], skipped: [] as string[] };
    for (const id of entityIds) {
      const entity = await store.getEntity(id);
      if (!entity || entity.containerId !== topic.id || !['requirement', 'task', 'document', 'decision'].includes(entity.type)) {
        result.skipped.push(id);
        continue;
      }
      if (mode === 'move') {
        await store.updateEntity(id, { containerId: project.id }, ctx);
        result.moved.push(id);
      } else {
        await store.createLink({ fromId: id, toId: project.id, kind: 'belongs_to' }, ctx).catch(() => undefined);
        result.linked.push(id);
      }
    }
    await store.audit({ action: 'topic.move_items', containerId: project.id, details: { from: topic.id, mode, ...result } }, ctx);
    return result;
  }

  // --- home (FR-1.3, FR-1.8) ---

  async systemsOf(containerId: string): Promise<Entity[]> {
    const { store } = this.#deps;
    const own = await store.listEntities({ containerId, type: 'system', limit: 100 });
    const { incoming } = await store.linksOf(containerId, 'belongs_to');
    const linked: Entity[] = [];
    for (const link of incoming) {
      const entity = await store.getEntity(link.fromId);
      if (entity && entity.type === 'system' && !own.some((candidate) => candidate.id === entity.id)) linked.push(entity);
    }
    return [...own, ...linked].sort((a, b) => a.title.localeCompare(b.title));
  }

  async home(container: Container, principal: Principal): Promise<HomePanels> {
    const { store, access, people } = this.#deps;
    const visible = async (entities: Entity[]): Promise<Entity[]> => {
      const out: Entity[] = [];
      for (const entity of entities) if (await access.canSeeEntity(principal, entity)) out.push(entity);
      return out;
    };
    const byType = (type: Entity['type'], limit = 200) => store.listEntities({ containerId: container.id, type, limit });
    const requirements = await visible(await byType('requirement'));
    const tasks = await visible(await byType('task'));
    const openTasks = tasks.filter((task) => OPEN_TASK_STATES.includes(typeof task.data.state === 'string' ? task.data.state : 'open'));
    const openRequirements = requirements.filter((requirement) => OPEN_REQUIREMENT_STATUSES.includes(requirement.status));
    const owner = container.ownerId ? await store.getEntity(container.ownerId) : undefined;
    const spawnedFrom = typeof container.data.spawnedFrom === 'string' ? await store.getContainer(container.data.spawnedFrom) : undefined;
    const members = await people.members(container.id);
    return {
      container,
      owner: owner?.type === 'person' ? owner : undefined,
      channels: (await store.channelLinks(container.id)).map((link) => ({ mmChannelId: link.mmChannelId, role: link.role })),
      people: members.map((member) => ({ person: member.person, role: member.role })),
      systems: await visible(await this.systemsOf(container.id)),
      requirements: { open: openRequirements.length, recent: openRequirements.slice(0, 5) },
      tasks: { open: openTasks.length, recent: openTasks.slice(0, 5) },
      decisions: (await visible(await byType('decision', 5))).slice(0, 5),
      documents: (await visible(await byType('document', 5))).slice(0, 5),
      conversations: (await visible(await byType('conversation', 5))).slice(0, 5),
      milestones: Array.isArray(container.data.milestones) ? (container.data.milestones as Milestone[]) : [],
      package: { status: 'not_available', note: 'Packages arrive with Phase 3.' },
      stale: Boolean(container.data.stale),
      spawnedFrom,
    };
  }

  async setTimeline(container: Container, milestones: Milestone[], ctx: WriteContext): Promise<Container> {
    const sorted = [...milestones].sort((a, b) => a.date.localeCompare(b.date));
    return this.#deps.store.updateContainer(container.id, { data: { milestones: sorted } }, ctx);
  }

  // --- stale projects (FR-1.5; a daily job) ---

  /** The newest change in a container and the database's clock, so the comparison does not depend on this host's clock. */
  async lastActivity(containerId: string): Promise<{ last: Date; now: Date }> {
    const r = await this.#deps.store.pool.query<{ last: Date | null; now: Date }>(
      `SELECT GREATEST((SELECT max(updated_at) FROM brain.entities WHERE container_id = $1), (SELECT updated_at FROM brain.containers WHERE id = $1)) AS last, now() AS now`,
      [containerId],
    );
    return { last: r.rows[0]?.last ?? new Date(0), now: r.rows[0]?.now ?? new Date() };
  }

  async markStaleProjects(): Promise<{ checked: number; stale: number; notified: number }> {
    const { store, chat, botUserId, people, staleDays, publicUrl, log } = this.#deps;
    const projects = (await store.listContainers({ kind: 'project', status: 'active', limit: 500 })).filter((project) => project.id !== GENERAL_CONTAINER_ID);
    let stale = 0;
    let notified = 0;
    const ctx: WriteContext = { actor: { kind: 'system', id: 'stale-projects' }, source: { kind: 'system' } };
    for (const project of projects) {
      const { last, now } = await this.lastActivity(project.id);
      const isStale = now.getTime() - last.getTime() >= staleDays * 86_400_000;
      if (isStale) stale++;
      if (isStale === Boolean(project.data.stale)) continue;
      // Flagging must not count as activity: the stamp is kept and compared, not the container's updated_at.
      await store.updateContainer(project.id, { data: { stale: isStale, staleSince: isStale ? last.toISOString() : null } }, ctx);
      if (!isStale) continue;
      const owner = project.ownerId ? await store.getEntity(project.ownerId) : undefined;
      const ownerUserId = owner && typeof owner.data.mmUserId === 'string' ? owner.data.mmUserId : undefined;
      if (!ownerUserId) continue;
      try {
        const direct = await chat.createDirectChannel(botUserId, ownerUserId);
        await chat.createPost({ channel_id: direct.id, message: `**${project.title}** has had no activity since ${last.toISOString().slice(0, 10)} and is flagged stale. Archive it or post an update. ${containerUrl({ publicUrl }, project.id)}`, props: { brain: { kind: 'stale', containerId: project.id } } });
        notified++;
      } catch (error) {
        log.warn({ projectId: project.id, ...errorFields(error) }, 'Could not message the owner about a stale project');
      }
    }
    void people;
    return { checked: projects.length, stale, notified };
  }
}

export type { Link };
