// The REST routes under /api/v1/brain (plan section 8). Every read goes through the caller's scope (FR-9.5);
// every write carries the actor and source into versions and the audit log.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { provisionAgent, AgentRepository, type AgentRecord } from '@brain/agent-runtime';
import { ENTITY_TYPES, EXPORT_TABLES, GENERAL_CONTAINER_ID, type EntityType, type ExportTable } from '@brain/brain';
import { ChatApiError } from '@brain/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { requireAdmin, requirePrincipal, writeContext } from './auth.ts';
import type { ChannelLinker } from './channels.ts';
import { ensureMattermostIntegration } from './mattermost-setup.ts';
import { presentAudit, presentChannelLink, presentContainer, presentEntity, presentEntitySummary, presentLink, presentSearchResult, presentVersion } from './present.ts';
import * as s from './schemas.ts';

const isEntityType = (value: string): value is EntityType => (ENTITY_TYPES as readonly string[]).includes(value);

/** What the API shows of an agent: never keys or tokens. */
function publicAgent(agent: AgentRecord) {
  return { handle: agent.handle, displayName: agent.displayName, provider: agent.provider, model: agent.model, status: agent.status, mmBotUserId: agent.mmBotUserId, nostrPubkey: agent.nostrPubkey };
}

export function registerBrainRoutes(app: FastifyInstance, deps: BrainApiDeps, linker: ChannelLinker): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, config, log } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const semanticOn = deps.embeddings !== undefined;

  // --- session ---

  const features = () => ({
    api: config.BRAIN_FEATURE_API,
    chatCommands: config.BRAIN_FEATURE_CHAT_COMMANDS,
    semanticSearch: semanticOn,
    projects: config.BRAIN_FEATURE_PROJECTS,
    people: config.BRAIN_FEATURE_PEOPLE,
    systems: config.BRAIN_FEATURE_SYSTEMS,
    documents: config.BRAIN_FEATURE_DOCUMENTS,
    tasks: config.BRAIN_FEATURE_TASKS,
    reminders: config.BRAIN_FEATURE_REMINDERS,
    ocrModel: config.BRAIN_FEATURE_OCR_MODEL,
  });

  api.get('/me', { schema: { tags: ['Session'], summary: 'The caller and the features on this installation', response: { 200: z.object({ principal: z.object({ kind: z.string(), userId: z.string(), username: z.string().optional(), isAdmin: z.boolean().optional(), personId: z.string().optional() }), features: z.record(z.string(), z.boolean()), publicUrl: z.string(), chatUrl: z.string(), timezone: z.string() }), 401: s.errorResponse } } }, (request) => {
    const principal = requirePrincipal(request);
    return {
      principal: principal.kind === 'person' ? { kind: 'person', userId: principal.userId, username: principal.username, isAdmin: principal.isAdmin, ...(principal.personId ? { personId: principal.personId } : {}) } : { kind: principal.kind, userId: principal.userId },
      features: features(),
      publicUrl: urls.publicUrl,
      chatUrl: config.MM_URL,
      timezone: config.BRAIN_TIMEZONE,
    };
  });

  api.get('/features', { schema: { tags: ['Session'], summary: 'Feature flags (no sign-in needed)', response: { 200: z.record(z.string(), z.boolean()) } } }, () => features());

  // --- containers ---

  api.get('/containers', { schema: { tags: ['Containers'], summary: 'List Projects and Topics', querystring: z.object({ kind: z.enum(['project', 'topic', 'general']).optional(), status: z.enum(['active', 'archived']).optional(), q: z.string().optional(), ...s.paging }), response: { 200: z.object({ containers: z.array(s.containerOut) }) } } }, async (request) => {
    requirePrincipal(request);
    const containers = await store.listContainers(request.query);
    return { containers: containers.map((container) => presentContainer(container, urls)) };
  });

  api.post('/containers', { schema: { tags: ['Containers'], summary: 'Create a Project or a Topic, optionally linking a channel', body: s.newContainerIn, response: { 201: z.object({ container: s.containerOut, channel: s.channelLinkOut.optional() }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot create containers');
    const ctx = writeContext(request, principal);
    const { channel, ...input } = request.body;
    const container = await store.createContainer(input, ctx);
    const link = channel ? await linker.attach(container, channel.mmChannelId, channel.role, principal, ctx) : undefined;
    return reply.code(201).send({ container: presentContainer((await store.getContainer(container.id)) ?? container, urls), ...(link ? { channel: presentChannelLink(link) } : {}) });
  });

  api.get('/containers/:id', { schema: { tags: ['Containers'], summary: 'One container with its channels and entity counts', params: z.object({ id: s.id }), response: { 200: z.object({ container: s.containerOut, channels: z.array(s.channelLinkOut), counts: z.record(z.string(), z.number()) }), 404: s.errorResponse } } }, async (request) => {
    requirePrincipal(request);
    const container = await store.getContainer(request.params.id);
    if (!container) throw new AccessError(404, 'No such container');
    return { container: presentContainer(container, urls), channels: (await store.channelLinks(container.id)).map(presentChannelLink), counts: await store.entityCounts(container.id) };
  });

  api.patch('/containers/:id', { schema: { tags: ['Containers'], summary: 'Change a container (a new version)', params: z.object({ id: s.id }), body: s.patchContainerIn, response: { 200: z.object({ container: s.containerOut }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot change containers');
    return { container: presentContainer(await store.updateContainer(request.params.id, request.body, writeContext(request, principal)), urls) };
  });

  api.post('/containers/:id/archive', { schema: { tags: ['Containers'], summary: 'Archive a container (it stays searchable, FR-1.6)', params: z.object({ id: s.id }), response: { 200: z.object({ container: s.containerOut }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot archive containers');
    return { container: presentContainer(await store.updateContainer(request.params.id, { status: 'archived' }, writeContext(request, principal)), urls) };
  });

  api.get('/containers/:id/entities', { schema: { tags: ['Containers'], summary: "A container's entities the caller may see", params: z.object({ id: s.id }), querystring: z.object({ type: s.entityType.optional(), status: z.string().optional(), includeArchived: z.enum(['true', 'false']).optional(), ...s.paging }), response: { 200: z.object({ entities: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    const entities = await store.listEntities({ containerId: request.params.id, type: request.query.type, status: request.query.status, includeArchived: request.query.includeArchived === 'true', limit: request.query.limit, offset: request.query.offset });
    const visible = [];
    for (const entity of entities) if (await access.canSeeEntity(principal, entity)) visible.push(presentEntitySummary(entity, urls));
    return { entities: visible };
  });

  api.post('/containers/:id/channels', { schema: { tags: ['Containers'], summary: 'Link a Mattermost channel: its threads become the container\'s conversations (D50, D57)', params: z.object({ id: s.id }), body: s.linkChannelIn, response: { 201: z.object({ channel: s.channelLinkOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot link channels');
    const container = await store.getContainer(request.params.id);
    if (!container) throw new AccessError(404, 'No such container');
    if (container.kind === 'general') throw new AccessError(400, 'Channels feed General by default; link them to a Project or Topic instead');
    const link = await linker.attach(container, request.body.mmChannelId, request.body.role, principal, writeContext(request, principal));
    return reply.code(201).send({ channel: presentChannelLink(link) });
  });

  api.delete('/containers/:id/channels/:mmChannelId', { schema: { tags: ['Containers'], summary: 'Unlink a channel (its conversations go back to General)', params: z.object({ id: s.id, mmChannelId: s.mmId }), response: { 200: z.object({ removed: z.boolean() }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot unlink channels');
    const link = await store.channelLinkByMm(request.params.mmChannelId);
    if (!link || link.containerId !== request.params.id) return { removed: false };
    if (principal.kind === 'person' && !principal.isAdmin && !(await deps.chat.isChannelMember(link.mmChannelId, principal.userId))) throw new AccessError(403, 'Only members of the channel can unlink it');
    return { removed: await store.unlinkChannel(link.mmChannelId, writeContext(request, principal)) };
  });

  // --- entities ---

  api.get('/entities', { schema: { tags: ['Entities'], summary: 'List entities the caller may see', querystring: z.object({ type: s.entityType.optional(), container: s.id.optional(), status: z.string().optional(), owner: s.id.optional(), q: z.string().optional(), includeArchived: z.enum(['true', 'false']).optional(), ...s.paging }), response: { 200: z.object({ entities: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    const { container, owner, ...rest } = request.query;
    const entities = await store.listEntities({ containerId: container, ownerId: owner, type: rest.type, status: rest.status, q: rest.q, includeArchived: rest.includeArchived === 'true', limit: rest.limit, offset: rest.offset });
    const visible = [];
    for (const entity of entities) if (await access.canSeeEntity(principal, entity)) visible.push(presentEntitySummary(entity, urls));
    return { entities: visible };
  });

  api.post('/entities', { schema: { tags: ['Entities'], summary: 'Create an entity (version 1, indexed at once)', body: s.newEntityIn, response: { 201: z.object({ entity: s.entityOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose entities; they do not create them (Phase 2)');
    const container = await store.getContainer(request.body.containerId);
    if (!container) throw new AccessError(404, 'No such container');
    const entity = await store.createEntity({ ...request.body, containerId: container.id }, writeContext(request, principal));
    return reply.code(201).send({ entity: presentEntity(entity, urls) });
  });

  const loadVisible = async (request: Parameters<typeof requirePrincipal>[0], id: string) => {
    const principal = requirePrincipal(request);
    const entity = await store.getEntity(id);
    if (!entity || !(await access.canSeeEntity(principal, entity))) throw new AccessError(404, 'No such entity');
    return { principal, entity };
  };

  api.get('/entities/:id', { schema: { tags: ['Entities'], summary: 'One entity', params: z.object({ id: s.id }), response: { 200: z.object({ entity: s.entityOut, container: s.containerOut }), 404: s.errorResponse } } }, async (request) => {
    const { entity } = await loadVisible(request, request.params.id);
    const container = await store.getContainer(entity.containerId);
    return { entity: presentEntity(entity, urls), container: presentContainer(container!, urls) };
  });

  api.patch('/entities/:id', { schema: { tags: ['Entities'], summary: 'Change an entity (a new version; unchanged fields stay)', params: z.object({ id: s.id }), body: s.patchEntityIn, response: { 200: z.object({ entity: s.entityOut }) } } }, async (request) => {
    const { principal } = await loadVisible(request, request.params.id);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose changes; they do not make them (Phase 2)');
    return { entity: presentEntity(await store.updateEntity(request.params.id, request.body, writeContext(request, principal)), urls) };
  });

  api.post('/entities/:id/archive', { schema: { tags: ['Entities'], summary: 'Archive an entity (people only; agents cannot)', params: z.object({ id: s.id }), response: { 200: z.object({ entity: s.entityOut }) } } }, async (request) => {
    const { principal } = await loadVisible(request, request.params.id);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot archive entities');
    return { entity: presentEntity(await store.archiveEntity(request.params.id, writeContext(request, principal)), urls) };
  });

  api.get('/entities/:id/versions', { schema: { tags: ['Entities'], summary: 'Every version of an entity, newest first', params: z.object({ id: s.id }), response: { 200: z.object({ versions: z.array(s.versionOut) }) } } }, async (request) => {
    await loadVisible(request, request.params.id);
    return { versions: (await store.listVersions(request.params.id)).map(presentVersion) };
  });

  api.get('/entities/:id/versions/:n', { schema: { tags: ['Entities'], summary: 'One version of an entity', params: z.object({ id: s.id, n: z.coerce.number().int().min(1) }), response: { 200: z.object({ version: s.versionOut }), 404: s.errorResponse } } }, async (request) => {
    await loadVisible(request, request.params.id);
    const version = await store.getVersion(request.params.id, request.params.n);
    if (!version) throw new AccessError(404, 'No such version');
    return { version: presentVersion(version) };
  });

  api.get('/entities/:id/links', { schema: { tags: ['Entities'], summary: 'Links from and to an entity', params: z.object({ id: s.id }), querystring: z.object({ kind: s.linkKind.optional() }), response: { 200: z.object({ outgoing: z.array(s.linkOut), incoming: z.array(s.linkOut) }) } } }, async (request) => {
    await loadVisible(request, request.params.id);
    const { outgoing, incoming } = await store.linksOf(request.params.id, request.query.kind);
    return { outgoing: outgoing.map(presentLink), incoming: incoming.map(presentLink) };
  });

  api.get('/entities/:id/backlinks', { schema: { tags: ['Entities'], summary: 'What points at an entity: incoming links and texts that name it (FR-9.4)', params: z.object({ id: s.id }), response: { 200: z.object({ links: z.array(s.linkOut), mentions: z.array(s.searchResultOut) }) } } }, async (request) => {
    const { principal, entity } = await loadVisible(request, request.params.id);
    const { links, mentions } = await store.backlinks(entity, await access.scope(principal));
    return { links: links.map(presentLink), mentions: mentions.map((result) => presentSearchResult(result, urls)) };
  });

  // --- links ---

  api.post('/links', { schema: { tags: ['Entities'], summary: 'Link two entities (or an entity and a container)', body: s.newLinkIn, response: { 201: z.object({ link: s.linkOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose links; they do not make them (Phase 2)');
    for (const id of [request.body.fromId, request.body.toId]) {
      const entity = await store.getEntity(id);
      if (entity && !(await access.canSeeEntity(principal, entity))) throw new AccessError(404, `No such entity ${id}`);
    }
    return reply.code(201).send({ link: presentLink(await store.createLink(request.body, writeContext(request, principal))) });
  });

  api.delete('/links/:id', { schema: { tags: ['Entities'], summary: 'Remove a link', params: z.object({ id: z.coerce.number().int().min(1) }), response: { 200: z.object({ removed: z.boolean() }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot remove links');
    return { removed: await store.deleteLink(request.params.id, writeContext(request, principal)) };
  });

  // --- search ---

  api.get('/search', { schema: { tags: ['Search'], summary: 'Hybrid search over everything the caller may see, with citations and facets', querystring: s.searchQuery, response: { 200: z.object({ results: z.array(s.searchResultOut), semantic: z.boolean(), tookMs: z.number(), facets: z.object({ types: z.record(z.string(), z.number()), containers: z.record(z.string(), z.number()) }) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    const started = Date.now();
    const q = request.query;
    const scope = await access.scope(principal);
    let embedding: number[] | undefined;
    if (deps.embeddings) {
      try {
        embedding = (await deps.embeddings.embed([q.q], 'query'))[0];
      } catch (error) {
        log.warn({ requestId: request.id, err: error instanceof Error ? error.message : String(error) }, 'Query embedding failed; keyword search only');
      }
    }
    const types = q.type?.split(',').map((value) => value.trim()).filter(isEntityType);
    const results = await store.search({
      query: q.q,
      embedding,
      ...(deps.embeddings ? { maxDistance: deps.embeddings.relevanceDistance } : {}),
      scope,
      filters: { containerId: q.container, types: types && types.length > 0 ? types : undefined, personId: q.person, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, includeArchived: q.includeArchived === 'true' },
      limit: q.limit,
    });
    await store.audit({ action: 'search', details: { queryHash: createHash('sha256').update(q.q).digest('hex').slice(0, 16), results: results.length, semantic: embedding !== undefined } }, writeContext(request, principal));
    const facets = { types: {} as Record<string, number>, containers: {} as Record<string, number> };
    for (const result of results) {
      facets.types[result.entityType] = (facets.types[result.entityType] ?? 0) + 1;
      facets.containers[result.containerId] = (facets.containers[result.containerId] ?? 0) + 1;
    }
    return { results: results.map((result) => presentSearchResult(result, urls)), semantic: embedding !== undefined, tookMs: Date.now() - started, facets };
  });

  // --- audit ---

  api.get('/audit', { schema: { tags: ['Audit'], summary: 'Audit entries (administrators)', querystring: z.object({ entity: s.id.optional(), container: s.id.optional(), actor: z.string().optional(), from: s.isoDate.optional(), to: s.isoDate.optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }), response: { 200: z.object({ entries: z.array(s.auditOut) }) } } }, async (request) => {
    requireAdmin(request);
    const q = request.query;
    const entries = await store.listAudit({ entityId: q.entity, containerId: q.container, actorId: q.actor, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, limit: q.limit });
    return { entries: entries.map(presentAudit) };
  });

  // --- export (NFR-9) ---

  api.get('/export/manifest', { schema: { tags: ['Export'], summary: 'What an export contains: tables and row counts', response: { 200: z.object({ format: z.string(), generatedAt: z.string(), tables: z.record(z.string(), z.number()), files: z.array(z.string()) }) } } }, async (request) => {
    requireAdmin(request);
    const counts = await store.counts();
    return { format: 'jsonl/1', generatedAt: new Date().toISOString(), tables: counts, files: EXPORT_TABLES.map((table) => `${table}.jsonl`) };
  });

  api.get('/export/:file', { schema: { tags: ['Export'], summary: 'One table as JSON Lines (administrators); chunks without embeddings unless ?embeddings=true', params: z.object({ file: z.string().regex(/^[a-z_]+\.jsonl$/) }), querystring: z.object({ embeddings: z.enum(['true', 'false']).optional() }) } }, async (request, reply) => {
    const principal = requireAdmin(request);
    const table = request.params.file.replace(/\.jsonl$/, '');
    if (!(EXPORT_TABLES as readonly string[]).includes(table)) throw new AccessError(404, 'No such table');
    await store.audit({ action: 'export', details: { table } }, writeContext(request, principal));
    const rows = store.exportRows(table as ExportTable, { withEmbeddings: request.query.embeddings === 'true' });
    const lines = (async function* () {
      for await (const row of rows) yield `${JSON.stringify(row)}\n`;
    })();
    return reply.type('application/x-ndjson').send(Readable.from(lines));
  });

  // --- agents and channels (the former admin API, D43) ---

  const agents = new AgentRepository(deps.pool);
  const provisionDeps = { pool: deps.pool, chat: deps.adminChat, relay: deps.relay, keyStore: deps.keyStore, bridgeSigner: deps.bridgeSigner, teamName: deps.teamName, log };

  api.get('/agents', { schema: { tags: ['Agents'], summary: 'Agents (without keys or tokens)', response: { 200: z.object({ agents: z.array(s.agentOut) }) } } }, async (request) => {
    requireAdmin(request);
    return { agents: (await agents.listAll()).map(publicAgent) };
  });

  api.post('/agents', { schema: { tags: ['Agents'], summary: 'Create or update an agent (bot, token, relay identity, registry record)', body: s.createAgentIn, response: { 201: z.object({ agent: s.agentOut }) } } }, async (request, reply) => {
    requireAdmin(request);
    const input = request.body;
    const agent = await provisionAgent(provisionDeps, {
      handle: input.handle,
      displayName: input.name,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    return reply.code(201).send({ agent: publicAgent(agent) });
  });

  async function channelOrFail(channelId: string): Promise<void> {
    const channel = await deps.chat.getChannel(channelId);
    if (!channel || channel.delete_at !== 0) throw new AccessError(404, 'No such channel');
    if (channel.type !== 'O' && channel.type !== 'P') throw new AccessError(400, 'Only open and private channels can have agents');
  }

  api.post('/channels/:id/enable', { schema: { tags: ['Agents'], summary: 'Add @brain to a channel so it is captured (D5)', params: z.object({ id: s.mmId }), response: { 202: z.object({ channelId: z.string(), enabled: z.boolean(), note: z.string() }) } } }, async (request, reply) => {
    requireAdmin(request);
    await channelOrFail(request.params.id);
    await deps.chat.addChannelMember(request.params.id, deps.botUserId);
    return reply.code(202).send({ channelId: request.params.id, enabled: true, note: 'The bridge mirrors the channel within seconds.' });
  });

  api.post('/channels/:id/agents', { schema: { tags: ['Agents'], summary: "Add an agent's bot to a channel", params: z.object({ id: s.mmId }), body: z.object({ handle: z.string().min(1) }), response: { 202: z.object({ channelId: z.string(), agent: z.string() }) } } }, async (request, reply) => {
    requireAdmin(request);
    await channelOrFail(request.params.id);
    const agent = await agents.getByHandle(request.body.handle);
    if (!agent) throw new AccessError(404, `No agent @${request.body.handle}`);
    if (!(await deps.chat.isChannelMember(request.params.id, deps.botUserId))) throw new AccessError(409, 'Enable the channel first (POST /channels/{id}/enable)');
    await deps.chat.addChannelMember(request.params.id, agent.mmBotUserId);
    return reply.code(202).send({ channelId: request.params.id, agent: agent.handle });
  });

  api.delete('/channels/:id/agents/:handle', { schema: { tags: ['Agents'], summary: "Remove an agent's bot from a channel", params: z.object({ id: s.mmId, handle: z.string().min(1) }), response: { 202: z.object({ channelId: z.string(), agent: z.string(), removed: z.boolean() }) } } }, async (request, reply) => {
    requireAdmin(request);
    const agent = await agents.getByHandle(request.params.handle);
    if (!agent) throw new AccessError(404, `No agent @${request.params.handle}`);
    await deps.chat.removeChannelMember(request.params.id, agent.mmBotUserId).catch((error: unknown) => {
      if (!(error instanceof ChatApiError && error.status === 404)) throw error;
    });
    return reply.code(202).send({ channelId: request.params.id, agent: agent.handle, removed: true });
  });

  // --- setup ---

  api.post('/setup/mattermost', { schema: { tags: ['Setup'], summary: 'Register the brain with Mattermost: allow-list, OAuth app, /brain command (idempotent)', response: { 200: z.object({ allowedHost: z.string(), oauthClientId: z.string(), commands: z.array(z.object({ teamId: z.string(), commandId: z.string(), created: z.boolean() })) }) } } }, async (request) => {
    const principal = requireAdmin(request);
    const result = await ensureMattermostIntegration({ adminChat: deps.adminChat, store, keyStore: deps.keyStore, publicUrl: config.BRAIN_PUBLIC_URL, internalUrl: config.BRAIN_INTERNAL_URL, log });
    await store.audit({ action: 'setup.mattermost', details: { commands: result.commands.length } }, writeContext(request, principal));
    return result;
  });

  void GENERAL_CONTAINER_ID;
}
