// Project and Topic routes (FR-1; plan sections 3 and 15): creation with channels, spawning from a Topic, moving
// items, the home page's panels, the timeline, and the caller's channels for the forms.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { requirePrincipal, writeContext } from './auth.ts';
import { presentContainer, presentEntitySummary } from './present.ts';
import * as s from './schemas.ts';
import type { WorkspaceService } from './workspaces.ts';

export function registerWorkspaceRoutes(app: FastifyInstance, deps: BrainApiDeps, workspaces: WorkspaceService): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, config, chat } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const off = (): void => {
    if (!config.BRAIN_FEATURE_PROJECTS) throw new AccessError(404, 'Projects and Topics are switched off on this installation');
  };
  const member = async (request: Parameters<typeof requirePrincipal>[0], containerId: string) => {
    const principal = requirePrincipal(request);
    const container = await store.getContainer(containerId);
    if (!container) throw new AccessError(404, 'No such container');
    if (principal.kind === 'person' && !principal.isAdmin && !(await access.membership(principal.userId)).containerIds.includes(container.id)) throw new AccessError(403, 'Only members of the container may do this');
    return { principal, container };
  };

  api.post('/projects', { schema: { tags: ['Projects'], summary: 'Create a Project with its channel group (FR-1.1, FR-1.2)', body: s.projectIn, response: { 201: z.object({ container: s.containerOut, channels: z.array(z.object({ id: z.string(), name: z.string(), display_name: z.string(), type: z.string() })) }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot create projects');
    const { container, channels } = await workspaces.createProject(request.body, principal, writeContext(request, principal));
    return reply.code(201).send({ container: presentContainer(container, urls), channels: channels.map((channel) => ({ id: channel.id, name: channel.name, display_name: channel.display_name, type: channel.type })) });
  });

  api.post('/projects/from-topic/:topicId', { schema: { tags: ['Projects'], summary: 'Spawn a Project from a Topic: its people and systems come along (FR-1.9)', params: z.object({ topicId: s.id }), body: s.projectIn.omit({ parentTopicId: true }), response: { 201: z.object({ container: s.containerOut, channels: z.array(z.object({ id: z.string(), name: z.string(), display_name: z.string(), type: z.string() })) }) } } }, async (request, reply) => {
    const { principal } = await member(request, request.params.topicId);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot create projects');
    const { container, channels } = await workspaces.createProject({ ...request.body, parentTopicId: request.params.topicId }, principal, writeContext(request, principal));
    return reply.code(201).send({ container: presentContainer(container, urls), channels: channels.map((channel) => ({ id: channel.id, name: channel.name, display_name: channel.display_name, type: channel.type })) });
  });

  api.post('/topics', { schema: { tags: ['Topics'], summary: 'Create a Topic from an existing channel or with a new one (FR-1.7)', body: s.topicIn, response: { 201: z.object({ container: s.containerOut, channel: z.object({ id: z.string(), name: z.string(), display_name: z.string(), type: z.string() }) }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot create topics');
    const { container, channel } = await workspaces.createTopic(request.body, principal, writeContext(request, principal));
    return reply.code(201).send({ container: presentContainer(container, urls), channel: { id: channel.id, name: channel.name, display_name: channel.display_name, type: channel.type } });
  });

  api.post('/topics/:id/move-items', { schema: { tags: ['Topics'], summary: "Move or link a Topic's requirements, tasks, documents and decisions into a Project (FR-1.9)", params: z.object({ id: s.id }), body: z.object({ projectId: s.id, entityIds: z.array(s.id).min(1).max(200), mode: z.enum(['move', 'link']).default('move') }), response: { 200: z.object({ moved: z.array(z.string()), linked: z.array(z.string()), skipped: z.array(z.string()) }) } } }, async (request) => {
    const { principal, container: topic } = await member(request, request.params.id);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot move items');
    if (topic.kind !== 'topic') throw new AccessError(400, 'Items move from a Topic');
    const project = await store.getContainer(request.body.projectId);
    if (!project || project.kind !== 'project') throw new AccessError(404, 'No such Project');
    return workspaces.moveItems(topic, project, request.body.entityIds, request.body.mode, writeContext(request, principal));
  });

  api.get('/containers/:id/home', { schema: { tags: ['Containers'], summary: "A Project's or Topic's home: summary, people, systems, requirements, tasks, decisions, documents, conversations, timeline (FR-1.3, FR-1.8)", params: z.object({ id: s.id }), response: { 200: s.homeOut, 404: s.errorResponse } } }, async (request) => {
    const principal = requirePrincipal(request);
    const container = await store.getContainer(request.params.id);
    if (!container) throw new AccessError(404, 'No such container');
    const home = await workspaces.home(container, principal);
    const summary = (entity: Parameters<typeof presentEntitySummary>[0]) => presentEntitySummary(entity, urls);
    return {
      container: presentContainer(home.container, urls),
      owner: home.owner ? summary(home.owner) : null,
      channels: home.channels,
      people: home.people.map((item) => ({ person: summary(item.person), role: item.role })),
      systems: home.systems.map(summary),
      requirements: { open: home.requirements.open, recent: home.requirements.recent.map(summary) },
      tasks: { open: home.tasks.open, recent: home.tasks.recent.map(summary) },
      decisions: home.decisions.map(summary),
      documents: home.documents.map(summary),
      conversations: home.conversations.map(summary),
      milestones: home.milestones,
      package: home.package,
      stale: home.stale,
      spawnedFrom: home.spawnedFrom ? presentContainer(home.spawnedFrom, urls) : null,
    };
  });

  api.patch('/containers/:id/timeline', { schema: { tags: ['Containers'], summary: "Replace a Project's milestones and phases (FR-1.4; members)", params: z.object({ id: s.id }), body: z.object({ milestones: z.array(s.milestoneIn).max(200) }), response: { 200: z.object({ container: s.containerOut }) } } }, async (request) => {
    const { principal, container } = await member(request, request.params.id);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot edit the timeline');
    if (container.kind !== 'project') throw new AccessError(400, 'Only Projects have a timeline');
    return { container: presentContainer(await workspaces.setTimeline(container, request.body.milestones, writeContext(request, principal)), urls) };
  });

  api.get('/me/channels', { schema: { tags: ['Session'], summary: "The caller's open and private channels (for the forms that link or promote a channel)", response: { 200: z.object({ channels: z.array(z.object({ id: z.string(), name: z.string(), display_name: z.string(), type: z.string(), containerId: z.string().nullable() })) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'person') return { channels: [] };
    const out: { id: string; name: string; display_name: string; type: string; containerId: string | null }[] = [];
    for (const team of await chat.getMyTeams()) {
      for (const channel of await chat.getUserChannels(principal.userId, team.id)) {
        if ((channel.type !== 'O' && channel.type !== 'P') || channel.delete_at !== 0) continue;
        const link = await store.channelLinkByMm(channel.id);
        out.push({ id: channel.id, name: channel.name, display_name: channel.display_name, type: channel.type, containerId: link?.containerId ?? null });
      }
    }
    return { channels: out.sort((a, b) => a.display_name.localeCompare(b.display_name)) };
  });
}
