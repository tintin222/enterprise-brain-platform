// People routes (FR-2; plan sections 4 and 15): the directory, profiles, external contacts, roles in a
// container, suggestions to confirm, and "who knows about X".
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { requireAdmin, requirePrincipal, writeContext } from './auth.ts';
import { entityUrl, presentEntity, presentEntitySummary, presentLink } from './present.ts';
import * as s from './schemas.ts';

export function registerPeopleRoutes(app: FastifyInstance, deps: BrainApiDeps): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, people, config, log } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const off = (): void => {
    if (!config.BRAIN_FEATURE_PEOPLE) throw new AccessError(404, 'The people directory is switched off on this installation');
  };

  const loadPerson = async (id: string) => {
    const entity = await store.getEntity(id);
    if (!entity || entity.type !== 'person') throw new AccessError(404, 'No such person');
    return entity;
  };

  api.get('/people', { schema: { tags: ['People'], summary: 'The people directory (everyone signed in)', querystring: z.object({ q: z.string().optional(), external: z.enum(['true', 'false']).optional(), includeInactive: z.enum(['true', 'false']).optional(), ...s.paging }), response: { 200: z.object({ people: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    requirePrincipal(request);
    off();
    const q = request.query;
    const entities = await store.listEntities({ type: 'person', q: q.q, status: q.includeInactive === 'true' ? undefined : 'active', limit: q.limit ?? 500, offset: q.offset });
    const wanted = q.external === undefined ? entities : entities.filter((entity) => Boolean(entity.data.external) === (q.external === 'true'));
    return { people: wanted.sort((a, b) => a.title.localeCompare(b.title)).map((entity) => presentEntitySummary(entity, urls)) };
  });

  api.post('/people', { schema: { tags: ['People'], summary: 'An external contact without an account (FR-2.2)', body: s.externalContactIn, response: { 201: z.object({ person: s.entityOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot create people');
    const person = await people.createExternal(request.body, writeContext(request, principal));
    return reply.code(201).send({ person: presentEntity(person, urls) });
  });

  api.post('/people/sync', { schema: { tags: ['People'], summary: 'Create or refresh a person for every chat account now (administrators; the daily job does the same)', response: { 200: z.object({ seen: z.number(), people: z.number() }) } } }, async (request) => {
    requireAdmin(request);
    off();
    return (await deps.jobs.runNow('people-sync')) as { seen: number; people: number } | undefined ?? people.syncAll();
  });

  api.get('/people/search', { schema: { tags: ['People'], summary: 'Who knows about X: people ranked by the evidence that links them to what matches (FR-2.4)', querystring: z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().min(1).max(20).optional() }), response: { 200: z.object({ people: z.array(s.whoKnowsOut), semantic: z.boolean() }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const scope = await access.scope(principal);
    let embedding: number[] | undefined;
    if (deps.embeddings) {
      try {
        embedding = (await deps.embeddings.embed([request.query.q], 'query'))[0];
      } catch (error) {
        log.warn({ requestId: request.id, err: error instanceof Error ? error.message : String(error) }, 'Query embedding failed; keyword search only');
      }
    }
    const results = await store.search({ query: request.query.q, embedding, ...(deps.embeddings ? { maxDistance: deps.embeddings.relevanceDistance } : {}), scope, limit: 50 });
    const ranked = (await people.whoKnows(results, scope)).slice(0, request.query.limit ?? 10);
    return { people: ranked.map((hit) => ({ person: presentEntitySummary(hit.person, urls), score: Number(hit.score.toFixed(4)), evidence: hit.evidence.map((item) => ({ ...item, url: entityUrl(urls, item.entityId) })) })), semantic: embedding !== undefined };
  });

  api.get('/people/:id', { schema: { tags: ['People'], summary: 'One person with their roles in projects and topics', params: z.object({ id: s.id }), response: { 200: z.object({ person: s.entityOut, memberships: z.array(z.object({ containerId: s.id, role: z.string(), title: z.string(), kind: z.string() })), suggestions: z.array(z.object({ kind: z.string(), value: z.string(), by: z.string(), at: z.string(), reason: z.string().optional() })) }), 404: s.errorResponse } } }, async (request) => {
    requirePrincipal(request);
    off();
    const person = await loadPerson(request.params.id);
    const memberships = [];
    for (const membership of await people.memberships(person.id)) {
      const container = await store.getContainer(membership.containerId);
      if (container) memberships.push({ ...membership, title: container.title, kind: container.kind });
    }
    const suggestions = Array.isArray(person.data.suggested) ? (person.data.suggested as { kind: string; value: string; by: string; at: string; reason?: string }[]) : [];
    return { person: presentEntity(person, urls), memberships, suggestions };
  });

  api.patch('/people/:id', { schema: { tags: ['People'], summary: 'Edit a profile (the person themselves, or an administrator; external contacts: anyone signed in)', params: z.object({ id: s.id }), body: s.profilePatchIn.extend({ name: z.string().trim().min(1).max(200).optional(), emails: z.array(z.email()).max(10).optional(), notes: z.string().trim().max(5000).optional() }), response: { 200: z.object({ person: s.entityOut }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const person = await loadPerson(request.params.id);
    const external = Boolean(person.data.external);
    const self = principal.kind === 'person' && principal.personId === person.id;
    const admin = principal.kind === 'service' || (principal.kind === 'person' && principal.isAdmin);
    if (!external && !self && !admin) throw new AccessError(403, 'Only the person or an administrator can edit this profile');
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents suggest; they do not edit profiles');
    const { name, emails, notes, ...profile } = request.body;
    const ctx = writeContext(request, principal);
    let updated = await people.updateProfile(person, profile, ctx);
    if (external && (name !== undefined || emails !== undefined || notes !== undefined)) {
      updated = await store.updateEntity(person.id, { ...(name ? { title: name } : {}), data: { ...(emails ? { emails: emails.map((email) => email.toLowerCase()) } : {}), ...(notes !== undefined ? { notes } : {}) } }, ctx);
    }
    return { person: presentEntity(updated, urls) };
  });

  api.post('/people/:id/suggestions/:n/:decision', { schema: { tags: ['People'], summary: 'Confirm or dismiss a suggested expertise or responsibility (FR-2.5)', params: z.object({ id: s.id, n: z.coerce.number().int().min(0), decision: z.enum(['confirm', 'dismiss']) }), response: { 200: z.object({ person: s.entityOut }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const person = await loadPerson(request.params.id);
    const self = principal.kind === 'person' && principal.personId === person.id;
    const admin = principal.kind === 'service' || (principal.kind === 'person' && principal.isAdmin);
    if (!self && !admin) throw new AccessError(403, 'Only the person or an administrator can decide');
    return { person: presentEntity(await people.decideSuggestion(person, request.params.n, request.params.decision === 'confirm', writeContext(request, principal)), urls) };
  });

  // --- roles in a container (FR-2.3) ---

  api.get('/containers/:id/members', { schema: { tags: ['People'], summary: "A container's people and their roles", params: z.object({ id: s.id }), response: { 200: z.object({ members: z.array(s.memberOut) }) } } }, async (request) => {
    requirePrincipal(request);
    off();
    const container = await store.getContainer(request.params.id);
    if (!container) throw new AccessError(404, 'No such container');
    return { members: (await people.members(container.id)).map((member) => ({ person: presentEntitySummary(member.person, urls), role: member.role, linkId: member.linkId })) };
  });

  api.post('/containers/:id/members', { schema: { tags: ['People'], summary: 'Give a person a role in a Project or Topic (members of the container, administrators)', params: z.object({ id: s.id }), body: s.memberIn, response: { 201: z.object({ link: s.linkOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot assign roles');
    const container = await store.getContainer(request.params.id);
    if (!container || container.kind === 'general') throw new AccessError(404, 'No such Project or Topic');
    if (principal.kind === 'person' && !principal.isAdmin && !(await access.membership(principal.userId)).containerIds.includes(container.id)) throw new AccessError(403, 'Only members of the container can assign roles');
    const person = await loadPerson(request.body.personId);
    const link = await people.setRole(container.id, person.id, request.body.role, writeContext(request, principal));
    if (typeof person.data.mmUserId === 'string') access.invalidate(person.data.mmUserId);
    return reply.code(201).send({ link: presentLink(link) });
  });

  api.delete('/containers/:id/members/:personId', { schema: { tags: ['People'], summary: "Remove a person's role in a container", params: z.object({ id: s.id, personId: s.id }), response: { 200: z.object({ removed: z.boolean() }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot remove roles');
    const container = await store.getContainer(request.params.id);
    if (!container) throw new AccessError(404, 'No such container');
    if (principal.kind === 'person' && !principal.isAdmin && !(await access.membership(principal.userId)).containerIds.includes(container.id)) throw new AccessError(403, 'Only members of the container can remove roles');
    const person = await loadPerson(request.params.personId);
    const removed = await people.removeRole(container.id, person.id, writeContext(request, principal));
    if (typeof person.data.mmUserId === 'string') access.invalidate(person.data.mmUserId);
    return { removed };
  });
}
