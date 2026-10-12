// Task routes (FR-11.1 to 11.3; plan sections 7 and 15): lists per container and per person, creation with
// evidence, edits, comments, snoozing, and the proposal decisions.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { requirePrincipal, writeContext } from './auth.ts';
import { presentEntity, presentEntitySummary } from './present.ts';
import * as s from './schemas.ts';
import { TASK_STATES, type TaskService } from './tasks.ts';

export function registerTaskRoutes(app: FastifyInstance, deps: BrainApiDeps, tasks: TaskService): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, config } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const off = (): void => {
    if (!config.BRAIN_FEATURE_TASKS) throw new AccessError(404, 'Tasks are switched off on this installation');
  };
  const loadVisible = async (request: Parameters<typeof requirePrincipal>[0], id: string) => {
    const principal = requirePrincipal(request);
    const task = await store.getEntity(id);
    // A task's assignee sees it even outside the container (plan section 9).
    const assigned = principal.kind === 'person' && principal.personId !== undefined && task?.data.assigneeId === principal.personId;
    if (!task || task.type !== 'task' || (!assigned && !(await access.canSeeEntity(principal, task)))) throw new AccessError(404, 'No such task');
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose tasks; they do not change them');
    return { principal, task };
  };

  api.get('/containers/:id/tasks', { schema: { tags: ['Tasks'], summary: "A container's tasks, open first, soonest due first", params: z.object({ id: s.id }), querystring: z.object({ state: z.enum(TASK_STATES).optional() }), response: { 200: z.object({ tasks: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const visible = [];
    for (const task of await tasks.forContainer(request.params.id, request.query.state)) if (await access.canSeeEntity(principal, task)) visible.push(presentEntitySummary(task, urls));
    return { tasks: visible };
  });

  api.get('/tasks/mine', { schema: { tags: ['Tasks'], summary: "The caller's tasks across projects and topics, proposals included", querystring: z.object({ includeClosed: z.enum(['true', 'false']).optional() }), response: { 200: z.object({ tasks: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    if (principal.kind !== 'person' || !principal.personId) return { tasks: [] };
    return { tasks: (await tasks.mine(principal.personId, request.query.includeClosed === 'true')).map((task) => presentEntitySummary(task, urls)) };
  });

  api.post('/tasks', { schema: { tags: ['Tasks'], summary: 'Create a task (one step: a title; everything else has a default)', body: s.taskIn, response: { 201: z.object({ task: s.entityOut }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents propose tasks through their runs (Phase 4)');
    const containerId = request.body.containerId ?? 'general';
    if (principal.kind === 'person' && !principal.isAdmin && !(await access.membership(principal.userId)).containerIds.includes(containerId)) throw new AccessError(403, 'Only members of the container can add tasks to it');
    const task = await tasks.create({ ...request.body, containerId }, writeContext(request, principal));
    return reply.code(201).send({ task: presentEntity(task, urls) });
  });

  api.get('/tasks/:id', { schema: { tags: ['Tasks'], summary: 'One task', params: z.object({ id: s.id }), response: { 200: z.object({ task: s.entityOut }), 404: s.errorResponse } } }, async (request) => {
    const { task } = await loadVisible(request, request.params.id);
    off();
    return { task: presentEntity(task, urls) };
  });

  api.patch('/tasks/:id', { schema: { tags: ['Tasks'], summary: 'Change a task: title, text, assignee, due date, priority, state, snooze', params: z.object({ id: s.id }), body: s.taskPatchIn, response: { 200: z.object({ task: s.entityOut }) } } }, async (request) => {
    const { principal, task } = await loadVisible(request, request.params.id);
    off();
    return { task: presentEntity(await tasks.update(task, request.body, writeContext(request, principal)), urls) };
  });

  api.post('/tasks/:id/comments', { schema: { tags: ['Tasks'], summary: 'Comment on a task', params: z.object({ id: s.id }), body: z.object({ text: z.string().trim().min(1).max(5000) }), response: { 200: z.object({ task: s.entityOut }) } } }, async (request) => {
    const { principal, task } = await loadVisible(request, request.params.id);
    off();
    const by = principal.kind === 'person' ? (principal.personId ?? principal.userId) : principal.userId;
    return { task: presentEntity(await tasks.comment(task, by, request.body.text, writeContext(request, principal)), urls) };
  });

  api.post('/tasks/:id/:decision', { schema: { tags: ['Tasks'], summary: 'Decide an agent\'s proposal: accept, edit (with changes) or dismiss (FR-11.3)', params: z.object({ id: s.id, decision: z.enum(['accept', 'edit', 'dismiss']) }), body: s.taskPatchIn.nullable().optional(), response: { 200: z.object({ task: s.entityOut }) } } }, async (request) => {
    const { principal, task } = await loadVisible(request, request.params.id);
    off();
    const by = principal.kind === 'person' ? (principal.personId ?? principal.userId) : principal.userId;
    return { task: presentEntity(await tasks.decide(task, request.params.decision, by, request.body ?? undefined, writeContext(request, principal)), urls) };
  });
}
