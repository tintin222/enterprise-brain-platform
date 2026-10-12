// Tasks (FR-11.1 to 11.3; plan section 7): one model for people's tasks and agents' proposals, lists and boards
// per container, "my tasks" per person, comments and evidence, snoozing and reassignment, and the daily reminder
// message with its buttons.
import { GENERAL_CONTAINER_ID, type BrainStore, type Entity, type WriteContext } from '@brain/brain';
import { errorFields, nowSeconds, type ChatClient, type Logger } from '@brain/shared';
import { AccessError, type Principal } from './access.ts';
import type { PeopleService } from './people.ts';
import { entityUrl } from './present.ts';
import { localParts } from './schedule.ts';
import type { TokenSigner } from './sessions.ts';

export const TASK_STATES = ['open', 'in_progress', 'done', 'dismissed'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Evidence {
  kind: 'post' | 'entity' | 'url' | 'mail';
  ref: string;
  url?: string;
  title?: string;
}

export interface TaskComment {
  by: string;
  at: string;
  text: string;
}

export interface Proposal {
  by: string;
  runId?: string;
  state: 'proposed' | 'accepted' | 'edited' | 'dismissed';
  at: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface TaskInput {
  title: string;
  containerId?: string;
  text?: string;
  assigneeId?: string;
  dueAt?: string;
  priority?: TaskPriority;
  evidence?: Evidence[];
  /** An agent's proposal (FR-11.3); people's tasks have none. */
  proposal?: { by: string; runId?: string };
}

export interface TaskPatch {
  title?: string;
  text?: string;
  assigneeId?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  state?: TaskState;
  snoozedUntil?: string | null;
}

export interface TaskDeps {
  store: BrainStore;
  chat: ChatClient;
  people: PeopleService;
  tokens: TokenSigner;
  log: Logger;
  botUserId: string;
  publicUrl: string;
  internalUrl: string;
  timeZone: string;
}

const OPEN: readonly TaskState[] = ['open', 'in_progress'];
const dayOf = (iso: string): string => iso.slice(0, 10);

export class TaskService {
  readonly #deps: TaskDeps;

  constructor(deps: TaskDeps) {
    this.#deps = deps;
  }

  async create(input: TaskInput, ctx: WriteContext): Promise<Entity> {
    const { store } = this.#deps;
    const containerId = input.containerId ?? GENERAL_CONTAINER_ID;
    if (!(await store.getContainer(containerId))) throw new AccessError(404, 'No such container');
    const data: Record<string, unknown> = {
      assigneeId: input.assigneeId ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority ?? 'normal',
      state: 'open',
      comments: [],
      evidence: input.evidence ?? [],
      proposal: input.proposal ? ({ by: input.proposal.by, ...(input.proposal.runId ? { runId: input.proposal.runId } : {}), state: 'proposed', at: new Date().toISOString() } satisfies Proposal) : null,
      snoozedUntil: null,
    };
    return store.createEntity({ type: 'task', title: input.title, containerId, ...(input.assigneeId ? { ownerId: input.assigneeId } : {}), data, text: input.text ?? '' }, ctx);
  }

  async update(task: Entity, patch: TaskPatch, ctx: WriteContext): Promise<Entity> {
    const data: Record<string, unknown> = {};
    for (const key of ['assigneeId', 'dueAt', 'priority', 'state', 'snoozedUntil'] as const) if (patch[key] !== undefined) data[key] = patch[key];
    if (patch.state === 'done') data.doneAt = new Date().toISOString();
    const status = patch.state ? (patch.state === 'done' || patch.state === 'dismissed' ? 'closed' : 'active') : undefined;
    return this.#deps.store.updateEntity(task.id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.text !== undefined ? { text: patch.text } : {}), ...(status ? { status } : {}), ...(patch.assigneeId !== undefined ? { ownerId: patch.assigneeId } : {}), data }, ctx);
  }

  async comment(task: Entity, by: string, text: string, ctx: WriteContext): Promise<Entity> {
    const comments = Array.isArray(task.data.comments) ? (task.data.comments as TaskComment[]) : [];
    return this.#deps.store.updateEntity(task.id, { data: { comments: [...comments, { by, at: new Date().toISOString(), text }] } }, ctx);
  }

  /** A proposal becomes a normal task on acceptance; an edited acceptance changes it first (FR-11.3). */
  async decide(task: Entity, decision: 'accept' | 'edit' | 'dismiss', by: string, patch: TaskPatch | undefined, ctx: WriteContext): Promise<Entity> {
    const proposal = task.data.proposal as Proposal | null | undefined;
    if (!proposal || proposal.state !== 'proposed') throw new AccessError(409, 'This task is not an open proposal');
    const next: Proposal = { ...proposal, state: decision === 'accept' ? 'accepted' : decision === 'edit' ? 'edited' : 'dismissed', decidedBy: by, decidedAt: new Date().toISOString() };
    const updated = await this.#deps.store.updateEntity(task.id, { data: { proposal: next, ...(decision === 'dismiss' ? { state: 'dismissed' } : {}) }, ...(decision === 'dismiss' ? { status: 'closed' } : {}) }, ctx);
    return decision === 'edit' && patch ? this.update(updated, patch, ctx) : updated;
  }

  async forContainer(containerId: string, state?: TaskState): Promise<Entity[]> {
    const tasks = await this.#deps.store.listEntities({ containerId, type: 'task', limit: 500 });
    return sortTasks(tasks.filter((task) => (state ? task.data.state === state : true)));
  }

  /** The person's tasks across containers, proposals included (FR-11.1 "My tasks"). */
  async mine(personId: string, includeClosed = false): Promise<Entity[]> {
    const r = await this.#deps.store.pool.query<{ id: string }>(
      `SELECT id FROM brain.entities WHERE type = 'task' AND archived_at IS NULL AND data->>'assigneeId' = $1 ${includeClosed ? '' : "AND data->>'state' IN ('open', 'in_progress')"} ORDER BY updated_at DESC LIMIT 500`,
      [personId],
    );
    const out: Entity[] = [];
    for (const row of r.rows) {
      const task = await this.#deps.store.getEntity(row.id);
      if (task) out.push(task);
    }
    return sortTasks(out);
  }

  /** Evidence for a task made from a chat post: the post's text and its permalink (FR-11.1). */
  async evidenceFromPost(postId: string, teamName: string): Promise<Evidence | undefined> {
    const post = await this.#deps.chat.getPost(postId);
    if (!post) return undefined;
    return { kind: 'post', ref: postId, url: this.#deps.chat.permalink(teamName, postId), title: post.message.replace(/\s+/g, ' ').slice(0, 140) };
  }

  // --- reminders (FR-11.2) ---

  /** Who is reminded today: people with tasks due today or overdue that are open and not snoozed past today. */
  async dueToday(today: string): Promise<Map<string, Entity[]>> {
    const r = await this.#deps.store.pool.query<{ id: string }>(
      `SELECT id FROM brain.entities WHERE type = 'task' AND archived_at IS NULL AND data->>'state' IN ('open', 'in_progress') AND data->>'assigneeId' IS NOT NULL
         AND data->>'dueAt' IS NOT NULL AND left(data->>'dueAt', 10) <= $1 AND (data->>'snoozedUntil' IS NULL OR left(data->>'snoozedUntil', 10) <= $1)
       ORDER BY data->>'dueAt'`,
      [today],
    );
    const byPerson = new Map<string, Entity[]>();
    for (const row of r.rows) {
      const task = await this.#deps.store.getEntity(row.id);
      const assignee = typeof task?.data.assigneeId === 'string' ? task.data.assigneeId : undefined;
      if (!task || !assignee) continue;
      byPerson.set(assignee, [...(byPerson.get(assignee) ?? []), task]);
    }
    return byPerson;
  }

  /** One direct message per person with their due and overdue tasks and buttons on each (done, snooze, reassign). */
  async sendReminders(now = new Date()): Promise<{ people: number; tasks: number; sent: number }> {
    const { store, chat, botUserId, publicUrl, internalUrl, tokens, log, timeZone } = this.#deps;
    const today = localParts(now, timeZone).day;
    const due = await this.dueToday(today);
    let sent = 0;
    let tasks = 0;
    for (const [personId, list] of due) {
      tasks += list.length;
      const person = await store.getEntity(personId);
      const userId = person && typeof person.data.mmUserId === 'string' ? person.data.mmUserId : undefined;
      if (!userId) continue;
      try {
        const direct = await chat.createDirectChannel(botUserId, userId);
        const overdue = list.filter((task) => dayOf(String(task.data.dueAt)) < today);
        const header = overdue.length > 0 ? `You have ${list.length} task${list.length === 1 ? '' : 's'} due, ${overdue.length} overdue.` : `You have ${list.length} task${list.length === 1 ? '' : 's'} due today.`;
        const attachments = list.map((task) => {
          const state = tokens.sign({ uid: userId, exp: nowSeconds() + 7 * 86_400, use: 'state', data: { purpose: 'task', taskId: task.id } });
          const action = (name: string, text: string, extra: Record<string, unknown> = {}) => ({ id: `${name}-${task.id.slice(0, 8)}`, name: text, type: 'button', integration: { url: `${internalUrl}/mm/actions/${name}`, context: { state, taskId: task.id, ...extra } } });
          return {
            title: task.title,
            title_link: entityUrl({ publicUrl }, task.id),
            text: `Due ${dayOf(String(task.data.dueAt))}${dayOf(String(task.data.dueAt)) < today ? ' (overdue)' : ''} · ${typeof task.data.priority === 'string' ? task.data.priority : 'normal'} priority`,
            actions: [action('task-done', 'Done'), action('task-snooze', 'Snooze a day', { days: 1 }), action('task-snooze', 'Snooze a week', { days: 7 }), action('task-reassign', 'Reassign')],
          };
        });
        await chat.createPost({ channel_id: direct.id, message: `${header} ${publicUrl}/tasks`, props: { brain: { kind: 'reminder', day: today }, attachments } });
        sent++;
      } catch (error) {
        log.warn({ personId, ...errorFields(error) }, 'Could not send a task reminder');
      }
    }
    return { people: due.size, tasks, sent };
  }

  /** A button on the reminder: done, snooze or reassign, by the task's assignee or any member who can see it. */
  async act(task: Entity, name: string, context: Record<string, unknown>, principal: Principal, ctx: WriteContext): Promise<string> {
    switch (name) {
      case 'task-done':
        await this.update(task, { state: 'done' }, ctx);
        return `Done: **${task.title}**.`;
      case 'task-snooze': {
        const days = typeof context.days === 'number' ? context.days : Number(context.days ?? 1) || 1;
        const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
        await this.update(task, { snoozedUntil: until, dueAt: until }, ctx);
        return `Snoozed **${task.title}** until ${until}.`;
      }
      case 'task-reassign': {
        const toUserId = typeof context.assignee === 'string' ? context.assignee : undefined;
        if (!toUserId) throw new AccessError(400, 'Choose who takes the task');
        const person = await this.#deps.people.ensurePerson(toUserId);
        await this.update(task, { assigneeId: person.id }, ctx);
        return `**${task.title}** is now with ${person.title}.`;
      }
      default:
        throw new AccessError(404, `No task action ${name}`);
    }
    void principal;
  }
}

/** Open before closed, then by due date (soonest first), then priority, then title. */
export function sortTasks(tasks: Entity[]): Entity[] {
  const rank = (state: unknown): number => (state === 'in_progress' ? 0 : state === 'open' ? 1 : state === 'done' ? 2 : 3);
  const prio = (priority: unknown): number => (priority === 'high' ? 0 : priority === 'normal' ? 1 : 2);
  return [...tasks].sort((a, b) => {
    const byState = rank(a.data.state) - rank(b.data.state);
    if (byState !== 0) return byState;
    const dueA = typeof a.data.dueAt === 'string' ? a.data.dueAt : '9999';
    const dueB = typeof b.data.dueAt === 'string' ? b.data.dueAt : '9999';
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    const byPriority = prio(a.data.priority) - prio(b.data.priority);
    return byPriority !== 0 ? byPriority : a.title.localeCompare(b.title);
  });
}

export const isOpen = (task: Entity): boolean => OPEN.includes(task.data.state as TaskState);
