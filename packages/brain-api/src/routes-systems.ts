// System routes (FR-3; plan sections 5 and 15): creation and edits, links to Projects and Topics, integrations,
// the system's view with its artifacts, and the diff between two versions of any entity (FR-3.6).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { requirePrincipal, writeContext } from './auth.ts';
import { diffFields, diffLines, hunks } from './diff.ts';
import { presentContainer, presentEntity, presentEntitySummary, presentLink } from './present.ts';
import * as s from './schemas.ts';
import type { SystemService } from './systems.ts';

export function registerSystemRoutes(app: FastifyInstance, deps: BrainApiDeps, systems: SystemService): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, config } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const off = (): void => {
    if (!config.BRAIN_FEATURE_SYSTEMS) throw new AccessError(404, 'Systems are switched off on this installation');
  };
  const loadSystem = async (id: string) => {
    const entity = await store.getEntity(id);
    if (!entity || entity.type !== 'system') throw new AccessError(404, 'No such system');
    return entity;
  };
  const writer = (request: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(request);
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose; they do not edit systems');
    return principal;
  };

  api.get('/systems', { schema: { tags: ['Systems'], summary: 'Every system (installation-wide, FR-3.7)', querystring: z.object({ q: z.string().optional(), container: s.id.optional(), ...s.paging }), response: { 200: z.object({ systems: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    requirePrincipal(request);
    off();
    let entities = await store.listEntities({ type: 'system', q: request.query.q, limit: request.query.limit ?? 500, offset: request.query.offset });
    if (request.query.container) {
      const wanted = request.query.container;
      const kept = [];
      for (const entity of entities) if ((await systems.containersOf(entity)).includes(wanted)) kept.push(entity);
      entities = kept;
    }
    return { systems: entities.sort((a, b) => a.title.localeCompare(b.title)).map((entity) => presentEntitySummary(entity, urls)) };
  });

  api.post('/systems', { schema: { tags: ['Systems'], summary: 'Create a system (FR-3.1), optionally linked to Projects and Topics', body: s.systemIn, response: { 201: z.object({ system: s.entityOut }) } } }, async (request, reply) => {
    const principal = writer(request);
    off();
    return reply.code(201).send({ system: presentEntity(await systems.create(request.body, writeContext(request, principal)), urls) });
  });

  api.get('/systems/:id', { schema: { tags: ['Systems'], summary: 'A system with its artifacts, integrations and the containers that use it', params: z.object({ id: s.id }), response: { 200: s.systemViewOut, 404: s.errorResponse } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const system = await loadSystem(request.params.id);
    const artifacts = [];
    for (const document of await systems.artifacts(system)) if (await access.canSeeEntity(principal, document)) artifacts.push(presentEntitySummary(document, urls));
    const containers = [];
    for (const id of await systems.containersOf(system)) {
      const container = await store.getContainer(id);
      if (container) containers.push(presentContainer(container, urls));
    }
    return {
      system: presentEntity(system, urls),
      artifacts,
      integrations: (await systems.integrations(system)).map((item) => ({ link: presentLink(item.link), other: presentEntitySummary(item.other, urls), direction: item.direction })),
      containers,
    };
  });

  api.patch('/systems/:id', { schema: { tags: ['Systems'], summary: 'Edit a system: description, owners, stack, environments, repositories, deployment, inventory (FR-3.1, FR-3.5)', params: z.object({ id: s.id }), body: s.systemPatchIn, response: { 200: z.object({ system: s.entityOut }) } } }, async (request) => {
    const principal = writer(request);
    off();
    return { system: presentEntity(await systems.update(await loadSystem(request.params.id), request.body, writeContext(request, principal)), urls) };
  });

  api.post('/systems/:id/containers', { schema: { tags: ['Systems'], summary: 'Use the system in a Project or Topic (FR-3.7)', params: z.object({ id: s.id }), body: z.object({ containerId: s.id }), response: { 201: z.object({ link: s.linkOut }) } } }, async (request, reply) => {
    const principal = writer(request);
    off();
    return reply.code(201).send({ link: presentLink(await systems.linkContainer(await loadSystem(request.params.id), request.body.containerId, writeContext(request, principal))) });
  });

  api.delete('/systems/:id/containers/:containerId', { schema: { tags: ['Systems'], summary: 'Stop using the system in a container', params: z.object({ id: s.id, containerId: s.id }), response: { 200: z.object({ removed: z.boolean() }) } } }, async (request) => {
    const principal = writer(request);
    off();
    return { removed: await systems.unlinkContainer(await loadSystem(request.params.id), request.params.containerId, writeContext(request, principal)) };
  });

  api.post('/systems/:id/integrations', { schema: { tags: ['Systems'], summary: 'Record that this system talks to another: protocol, data, direction (FR-3.4)', params: z.object({ id: s.id }), body: s.integrationIn, response: { 201: z.object({ link: s.linkOut }) } } }, async (request, reply) => {
    const principal = writer(request);
    off();
    return reply.code(201).send({ link: presentLink(await systems.addIntegration(await loadSystem(request.params.id), request.body, writeContext(request, principal))) });
  });

  // --- versions: the difference between two (FR-3.6, any entity) ---

  api.get('/entities/:id/versions/:a/diff/:b', { schema: { tags: ['Entities'], summary: 'What changed between two versions: text lines and data fields (FR-3.6)', params: z.object({ id: s.id, a: z.coerce.number().int().min(1), b: z.coerce.number().int().min(1) }), response: { 200: s.diffOut, 404: s.errorResponse } } }, async (request) => {
    const principal = requirePrincipal(request);
    const entity = await store.getEntity(request.params.id);
    if (!entity || !(await access.canSeeEntity(principal, entity))) throw new AccessError(404, 'No such entity');
    const [before, after] = await Promise.all([store.getVersion(entity.id, request.params.a), store.getVersion(entity.id, request.params.b)]);
    if (!before || !after) throw new AccessError(404, 'No such version');
    const lines = diffLines(before.text, after.text);
    return {
      from: before.version,
      to: after.version,
      title: before.title !== after.title ? { before: before.title, after: after.title } : null,
      fields: diffFields(before.data, after.data),
      text: { changed: lines.some((line) => line.kind !== 'same'), hunks: hunks(lines) },
    };
  });
}
