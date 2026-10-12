// Mattermost's callbacks (spike B1, plan section 10): the /brain, /project and /topic slash commands, dialog
// submissions and post actions. Mattermost is authenticated by the command token it was issued; dialogs and
// buttons carry a state we signed. The brain then acts as the invoking person, never as the integration.
import type { Container } from '@brain/brain';
import { nowSeconds, type MmDialog, type MmDialogElement } from '@brain/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Principal } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { safeEqual } from './auth.ts';
import type { ChannelLinker } from './channels.ts';
import { COMMAND_TRIGGERS, secretCommandToken } from './mattermost-setup.ts';
import { containerUrl } from './present.ts';
import { actionBody, commandBody, dialogBody } from './schemas.ts';
import type { TaskService } from './tasks.ts';
import type { WorkspaceService } from './workspaces.ts';

const STATE_SECONDS = 600;
const SEARCH_RESULTS = 5;
const DIALOGS = ['link', 'project', 'topic', 'task', 'task-reassign'] as const;

interface CommandResponse {
  response_type?: 'ephemeral' | 'in_channel';
  text?: string;
}

type CommandBody = z.infer<typeof commandBody>;
type Submission = Record<string, string | boolean | number | null>;

const str = (submission: Submission, key: string): string => (typeof submission[key] === 'string' ? submission[key].trim() : '');
const bool = (submission: Submission, key: string): boolean => submission[key] === true || submission[key] === 'true';

export function registerMattermostRoutes(app: FastifyInstance, deps: BrainApiDeps, linker: ChannelLinker, workspaces: WorkspaceService, tasks: TaskService): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { config, store, access, keyStore, tokens, chat, log, people } = deps;
  const publicUrl = config.BRAIN_PUBLIC_URL.replace(/\/$/, '');
  const internalUrl = config.BRAIN_INTERNAL_URL.replace(/\/$/, '');
  const ephemeral = (text: string): CommandResponse => ({ response_type: 'ephemeral', text });
  const chatCtx = (principal: Principal, requestId: string, ref?: string) => ({ actor: { kind: 'person' as const, id: principal.userId }, source: { kind: 'chat' as const, ...(ref ? { ref } : {}) }, requestId });

  async function personFor(userId: string): Promise<Principal> {
    const membership = await access.membership(userId);
    return { kind: 'person', userId, username: membership.username, isAdmin: membership.isAdmin, ...(membership.personId ? { personId: membership.personId } : {}) };
  }

  const help = [
    '**Enterprise Brain**',
    '- `/brain search <words>`: search everything you may see.',
    '- `/brain link`: make this channel feed a Project or Topic (its threads become that container\'s conversations).',
    '- `/project new [title]`: create a project with its three channels; `/project new --from-topic` spawns it from a topic.',
    '- `/project archive`: archive the project this channel belongs to.',
    '- `/topic here`: make this channel a topic; `/topic new`: start a new topic channel.',
    '- `/task <title>`: make a task from this thread or channel (typed in a thread, the thread is its evidence); `/task` alone opens a form; `/task mine` lists yours.',
    `- Pages: ${publicUrl}`,
  ].join('\n');

  const state = (body: CommandBody, purpose: string, extra: Record<string, unknown> = {}): string => tokens.sign({ uid: body.user_id, exp: nowSeconds() + STATE_SECONDS, use: 'state', data: { purpose, channel: body.channel_id, team: body.team_id, ...extra } });

  async function openDialog(body: CommandBody, name: (typeof DIALOGS)[number], dialog: Omit<MmDialog, 'callback_id' | 'state'>, extra: Record<string, unknown> = {}): Promise<CommandResponse> {
    if (!body.trigger_id) return ephemeral('This command needs a Mattermost that sends trigger ids.');
    await chat.openDialog({ trigger_id: body.trigger_id, url: `${internalUrl}/mm/dialogs/${name}`, dialog: { ...dialog, callback_id: name, notify_on_cancel: false, state: state(body, name, extra) } });
    return {};
  }

  // --- /brain ---

  async function searchCommand(principal: Principal, text: string, requestId: string): Promise<CommandResponse> {
    if (!text) return ephemeral('What should I search for? `/brain search <words>`');
    const scope = await access.scope(principal);
    let embedding: number[] | undefined;
    if (deps.embeddings) {
      try {
        embedding = (await deps.embeddings.embed([text], 'query'))[0];
      } catch {
        embedding = undefined;
      }
    }
    const results = await store.search({ query: text, embedding, ...(deps.embeddings ? { maxDistance: deps.embeddings.relevanceDistance } : {}), scope, limit: SEARCH_RESULTS });
    await store.audit({ action: 'search', details: { via: 'chat', results: results.length, semantic: embedding !== undefined } }, chatCtx(principal, requestId));
    const more = `${publicUrl}/search?q=${encodeURIComponent(text)}`;
    if (results.length === 0) return ephemeral(`Nothing found for "${text}". [Search the pages](${more})`);
    const lines = results.map((result) => {
      const url = result.citation.url ?? `${publicUrl}/entities/${result.entityId}`;
      const snippet = result.snippet.replace(/\s+/g, ' ').slice(0, 160);
      return `- **${result.title}** (${result.entityType}): ${snippet} [open](${url})`;
    });
    return ephemeral(`Results for "${text}":\n${lines.join('\n')}\n[All results](${more})`);
  }

  async function linkCommand(body: CommandBody): Promise<CommandResponse> {
    const containers = (await store.listContainers({ status: 'active', limit: 100 })).filter((container) => container.kind !== 'general');
    if (containers.length === 0) return ephemeral(`There are no Projects or Topics yet. Create one with \`/project new\` or \`/topic here\`, or on the pages: ${publicUrl}/containers`);
    const existing = await store.channelLinkByMm(body.channel_id);
    return openDialog(body, 'link', {
      title: 'Link this channel',
      introduction_text: existing ? `This channel feeds **${(await store.getContainer(existing.containerId))?.title ?? existing.containerId}** now. Choose where its threads should go.` : "Choose the Project or Topic this channel feeds. Its threads become that container's conversations.",
      elements: [
        { display_name: 'Project or Topic', name: 'container', type: 'select', options: containers.map((container) => ({ text: `${container.title} (${container.kind})`, value: container.id })), ...(existing ? { default: existing.containerId } : {}) },
        { display_name: 'Role of this channel', name: 'role', type: 'select', default: 'linked', options: [{ text: 'Linked channel', value: 'linked' }, { text: 'Home channel', value: 'home' }, { text: 'Requirements channel', value: 'requirements' }] },
      ],
      submit_label: 'Link',
    });
  }

  // --- /project ---

  const STAGES = ['discovery', 'analysis', 'build', 'rollout', 'live', 'closed'];

  async function projectNewCommand(body: CommandBody, argument: string): Promise<CommandResponse> {
    const fromTopic = /--from-topic/.test(argument);
    const title = argument.replace(/--from-topic/g, '').trim();
    const topics = fromTopic ? (await store.listContainers({ kind: 'topic', status: 'active', limit: 100 })) : [];
    if (fromTopic && topics.length === 0) return ephemeral('There are no Topics to spawn from yet. `/topic here` makes this channel one.');
    const elements: MmDialogElement[] = [
      { display_name: 'Name', name: 'title', type: 'text', default: title, max_length: 200, placeholder: 'Warehouse migration' },
      ...(fromTopic ? [{ display_name: 'From topic', name: 'topic', type: 'select' as const, options: topics.map((topic) => ({ text: topic.title, value: topic.id })) }] : []),
      { display_name: 'Client', name: 'client', type: 'text', optional: true, max_length: 200 },
      { display_name: 'Goal', name: 'goal', type: 'textarea', optional: true, max_length: 2000, help_text: 'What done looks like.' },
      { display_name: 'Stage', name: 'stage', type: 'select', default: 'discovery', options: STAGES.map((stage) => ({ text: stage, value: stage })) },
      { display_name: 'Private channels', name: 'private', type: 'bool', optional: true, help_text: 'The three project channels are private (invite only).' },
    ];
    return openDialog(body, 'project', { title: fromTopic ? 'New project from a topic' : 'New project', introduction_text: 'Creates the project and its channels: #proj-<name>, -requirements and -agent.', elements, submit_label: 'Create' });
  }

  async function projectArchiveCommand(principal: Principal, body: CommandBody, requestId: string): Promise<CommandResponse> {
    const link = await store.channelLinkByMm(body.channel_id);
    const container = link ? await store.getContainer(link.containerId) : undefined;
    if (!container || container.kind !== 'project') return ephemeral('This channel does not belong to a project.');
    if (principal.kind === 'person' && !principal.isAdmin && container.ownerId !== principal.personId) return ephemeral(`Only the project's owner or an administrator can archive **${container.title}**.`);
    await store.updateContainer(container.id, { status: 'archived' }, chatCtx(principal, requestId, body.channel_id));
    return ephemeral(`Archived **${container.title}**. It stays searchable. ${containerUrl({ publicUrl }, container.id)}`);
  }

  // --- /topic ---

  async function topicHereCommand(body: CommandBody): Promise<CommandResponse> {
    const channel = await chat.getChannel(body.channel_id);
    if (!channel || (channel.type !== 'O' && channel.type !== 'P')) return ephemeral('Only an open or private channel can become a topic.');
    const existing = await store.channelLinkByMm(body.channel_id);
    if (existing) {
      const container = await store.getContainer(existing.containerId);
      return ephemeral(`This channel already feeds **${container?.title ?? existing.containerId}** (${container?.kind ?? 'container'}). ${containerUrl({ publicUrl }, existing.containerId)}`);
    }
    return openDialog(body, 'topic', { title: 'Make this channel a topic', introduction_text: `#${channel.name} becomes the topic's home: its threads are the topic's conversations.`, elements: topicElements(channel.display_name, false), submit_label: 'Create topic' }, { mode: 'here' });
  }

  function topicElements(defaultTitle: string, withChannel: boolean): MmDialogElement[] {
    return [
      { display_name: 'Name', name: 'title', type: 'text', default: defaultTitle, max_length: 200 },
      ...(withChannel ? [{ display_name: 'Channel name', name: 'channelName', type: 'text' as const, optional: true, max_length: 60, help_text: 'Lowercase, dashes; empty uses the topic name.' }, { display_name: 'Private channel', name: 'private', type: 'bool' as const, optional: true }] : []),
      { display_name: 'Kind', name: 'kind', type: 'select', default: 'internal', options: [{ text: 'Internal', value: 'internal' }, { text: 'External (a client, a vendor)', value: 'external' }] },
      { display_name: 'Organisation', name: 'organisation', type: 'text', optional: true, max_length: 200, help_text: 'For external topics: the other organisation.' },
      { display_name: 'Description', name: 'description', type: 'textarea', optional: true, max_length: 2000 },
    ];
  }

  function topicNewCommand(body: CommandBody, argument: string): Promise<CommandResponse> {
    return openDialog(body, 'topic', { title: 'New topic', introduction_text: 'Creates the topic and a channel for it.', elements: topicElements(argument, true), submit_label: 'Create topic' }, { mode: 'new' });
  }

  // --- /task (FR-11.1) ---

  async function taskContainerFor(channelId: string): Promise<string> {
    const link = await store.channelLinkByMm(channelId);
    return link?.containerId ?? 'general';
  }

  async function taskCreateCommand(principal: Principal, body: CommandBody, title: string, requestId: string): Promise<CommandResponse> {
    const postId = body.root_id || undefined;
    const evidence = postId ? await tasks.evidenceFromPost(postId, body.team_domain ?? deps.teamName) : undefined;
    if (!title) {
      return openDialog(body, 'task', {
        title: 'New task',
        introduction_text: evidence ? `Evidence: "${evidence.title ?? ''}"` : 'A task in this channel\'s project or topic.',
        elements: [
          { display_name: 'What has to be done', name: 'title', type: 'text', max_length: 500 },
          { display_name: 'Who', name: 'assignee', type: 'select', data_source: 'users', optional: true, default: body.user_id },
          { display_name: 'Due (YYYY-MM-DD)', name: 'dueAt', type: 'text', optional: true, placeholder: new Date().toISOString().slice(0, 10) },
          { display_name: 'Priority', name: 'priority', type: 'select', default: 'normal', options: [{ text: 'Low', value: 'low' }, { text: 'Normal', value: 'normal' }, { text: 'High', value: 'high' }] },
        ],
        submit_label: 'Create task',
      }, { postId: postId ?? null });
    }
    const person = principal.kind === 'person' && principal.personId ? principal.personId : (await people.ensurePerson(body.user_id)).id;
    const task = await tasks.create({ title, containerId: await taskContainerFor(body.channel_id), assigneeId: person, evidence: evidence ? [evidence] : [] }, chatCtx(principal, requestId, postId ?? body.channel_id));
    return ephemeral(`Task created: **${task.title}** (assigned to you). ${publicUrl}/entities/${task.id}`);
  }

  async function taskMineCommand(principal: Principal): Promise<CommandResponse> {
    const personId = principal.kind === 'person' ? principal.personId : undefined;
    const mine = personId ? await tasks.mine(personId) : [];
    if (mine.length === 0) return ephemeral(`You have no open tasks. ${publicUrl}/tasks`);
    const lines = mine.slice(0, 15).map((task) => {
      const due = typeof task.data.dueAt === 'string' ? ` · due ${task.data.dueAt.slice(0, 10)}` : '';
      const state = typeof task.data.state === 'string' ? task.data.state : 'open';
      return `- **${task.title}**${due} · ${state} [open](${publicUrl}/entities/${task.id})`;
    });
    return ephemeral(`Your open tasks (${mine.length}):\n${lines.join('\n')}\n[All tasks](${publicUrl}/tasks)`);
  }

  // --- the command endpoint ---

  api.post('/mm/commands/:trigger', { schema: { tags: ['Mattermost'], summary: 'A slash command (/brain, /project, /topic; form body from Mattermost)', params: z.object({ trigger: z.enum(COMMAND_TRIGGERS as [string, ...string[]]) }), body: commandBody, hide: false } }, async (request, reply) => {
    const body = request.body;
    const trigger = request.params.trigger;
    const expected = await keyStore.getSecretText(secretCommandToken(body.team_id, trigger));
    if (!expected || !safeEqual(body.token, expected)) return reply.code(401).send({ error: 'Unknown command token', code: 'unauthorized' });
    if (!config.BRAIN_FEATURE_CHAT_COMMANDS) return ephemeral('The brain chat commands are switched off on this installation.');
    const principal = await personFor(body.user_id);
    const [sub = '', ...rest] = body.text.trim().split(/\s+/);
    const argument = rest.join(' ').trim();
    try {
      if (trigger === 'brain') {
        if (sub === 'search' || sub === 's') return await searchCommand(principal, argument, request.id);
        if (sub === 'link') return await linkCommand(body);
        return ephemeral(help);
      }
      if (!config.BRAIN_FEATURE_PROJECTS) return ephemeral('Projects and Topics are switched off on this installation.');
      if (trigger === 'project') {
        if (sub === 'new') return await projectNewCommand(body, argument);
        if (sub === 'archive') return await projectArchiveCommand(principal, body, request.id);
        return ephemeral(help);
      }
      if (trigger === 'topic') {
        if (sub === 'here') return await topicHereCommand(body);
        if (sub === 'new') return await topicNewCommand(body, argument);
        return ephemeral(help);
      }
      if (trigger === 'task') {
        if (!config.BRAIN_FEATURE_TASKS) return ephemeral('Tasks are switched off on this installation.');
        if (sub === 'mine') return await taskMineCommand(principal);
        if (sub === 'help') return ephemeral(help);
        return await taskCreateCommand(principal, body, body.text.trim(), request.id);
      }
      return ephemeral(help);
    } catch (error) {
      log.warn({ requestId: request.id, trigger, sub, err: error instanceof Error ? error.message : String(error) }, 'Slash command failed');
      return ephemeral(`Sorry, that did not work: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // --- dialogs ---

  api.post('/mm/dialogs/:name', { schema: { tags: ['Mattermost'], summary: 'A dialog submission (JSON from Mattermost)', params: z.object({ name: z.enum(DIALOGS) }), body: dialogBody } }, async (request, reply) => {
    const body = request.body;
    const verified = tokens.verify(body.state, 'state');
    if (!verified || verified.uid !== body.user_id || verified.data?.purpose !== request.params.name || verified.data.channel !== body.channel_id) return reply.code(401).send({ error: 'Unknown or expired dialog', code: 'unauthorized' });
    if (body.cancelled) return {};
    const principal = await personFor(body.user_id);
    const submission = body.submission;
    const ctx = chatCtx(principal, request.id, body.channel_id);
    try {
      switch (request.params.name) {
        case 'link': {
          const containerId = str(submission, 'container');
          const role = str(submission, 'role') || 'linked';
          const container = await store.getContainer(containerId);
          if (!container || container.kind === 'general') return { errors: { container: 'Choose a Project or Topic' } };
          if (role !== 'linked' && role !== 'home' && role !== 'requirements') return { errors: { role: 'Choose a role' } };
          await linker.attach(container, body.channel_id, role, principal, ctx);
          await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: `Linked: this channel now feeds **${container.title}**. ${containerUrl({ publicUrl }, container.id)}` }).catch(() => undefined);
          return {};
        }
        case 'project': {
          const title = str(submission, 'title');
          if (!title) return { errors: { title: 'Give the project a name' } };
          const topicId = str(submission, 'topic') || undefined;
          const { container, channels } = await workspaces.createProject({ title, client: str(submission, 'client'), goal: str(submission, 'goal'), stage: str(submission, 'stage') || 'discovery', private: bool(submission, 'private'), ...(topicId ? { parentTopicId: topicId } : {}) }, principal, ctx);
          await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: `Created the project **${container.title}** with ${channels.map((channel) => `~${channel.name}`).join(', ')}. ${containerUrl({ publicUrl }, container.id)}` }).catch(() => undefined);
          return {};
        }
        case 'task': {
          const title = str(submission, 'title');
          if (!title) return { errors: { title: 'Say what has to be done' } };
          const dueAt = str(submission, 'dueAt');
          if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return { errors: { dueAt: 'Use YYYY-MM-DD' } };
          const assigneeUser = str(submission, 'assignee') || body.user_id;
          const assignee = await people.ensurePerson(assigneeUser);
          const postId = typeof verified.data.postId === 'string' ? verified.data.postId : undefined;
          const evidence = postId ? await tasks.evidenceFromPost(postId, body.team_id) : undefined;
          const priority = str(submission, 'priority');
          const task = await tasks.create({ title, containerId: await taskContainerFor(body.channel_id), assigneeId: assignee.id, ...(dueAt ? { dueAt } : {}), priority: priority === 'low' || priority === 'high' ? priority : 'normal', evidence: evidence ? [evidence] : [] }, ctx);
          await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: `Task created: **${task.title}** for ${assignee.title}. ${publicUrl}/entities/${task.id}` }).catch(() => undefined);
          return {};
        }
        case 'task-reassign': {
          const taskId = typeof verified.data.taskId === 'string' ? verified.data.taskId : '';
          const task = await store.getEntity(taskId);
          if (!task || task.type !== 'task') return { error: 'The task no longer exists' };
          const toUser = str(submission, 'assignee');
          if (!toUser) return { errors: { assignee: 'Choose who takes the task' } };
          const text = await tasks.act(task, 'task-reassign', { assignee: toUser }, principal, ctx);
          await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: text }).catch(() => undefined);
          return {};
        }
        case 'topic': {
          const title = str(submission, 'title');
          if (!title) return { errors: { title: 'Give the topic a name' } };
          const kind = str(submission, 'kind') === 'external' ? 'external' : 'internal';
          const channelSpec = verified.data.mode === 'new' ? { create: true as const, ...(str(submission, 'channelName') ? { name: str(submission, 'channelName') } : {}), private: bool(submission, 'private') } : { mmChannelId: body.channel_id };
          const { container, channel } = await workspaces.createTopic({ title, kind, organisation: str(submission, 'organisation'), description: str(submission, 'description'), channel: channelSpec }, principal, ctx);
          await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: `Created the topic **${container.title}**; its home is ~${channel.name}. ${containerUrl({ publicUrl }, container.id)}` }).catch(() => undefined);
          return {};
        }
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  api.post('/mm/actions/:name', { schema: { tags: ['Mattermost'], summary: 'A button on a post (JSON from Mattermost); the context carries a signed state', params: z.object({ name: z.string().min(1) }), body: actionBody } }, async (request, reply) => {
    const body = request.body;
    const verified = tokens.verify(typeof body.context.state === 'string' ? body.context.state : undefined, 'state');
    const purpose = request.params.name.startsWith('task-') ? 'task' : request.params.name;
    if (!verified || verified.data?.purpose !== purpose || verified.uid !== body.user_id) return reply.code(401).send({ error: 'Unknown or expired action', code: 'unauthorized' });
    if (purpose === 'task') {
      const taskId = typeof verified.data.taskId === 'string' ? verified.data.taskId : '';
      const task = await store.getEntity(taskId);
      if (!task || task.type !== 'task') return { ephemeral_text: 'The task no longer exists.' };
      const principal = await personFor(body.user_id);
      if (request.params.name === 'task-reassign') {
        if (!body.trigger_id) return { ephemeral_text: 'This Mattermost does not send trigger ids.' };
        await chat.openDialog({
          trigger_id: body.trigger_id,
          url: `${internalUrl}/mm/dialogs/task-reassign`,
          dialog: { callback_id: 'task-reassign', title: `Reassign: ${task.title.slice(0, 40)}`, elements: [{ display_name: 'Who takes it', name: 'assignee', type: 'select', data_source: 'users' }], submit_label: 'Reassign', notify_on_cancel: false, state: tokens.sign({ uid: body.user_id, exp: nowSeconds() + STATE_SECONDS, use: 'state', data: { purpose: 'task-reassign', channel: body.channel_id, team: body.team_id, taskId: task.id } }) },
        });
        return {};
      }
      try {
        const text = await tasks.act(task, request.params.name, body.context, principal, chatCtx(principal, request.id, body.post_id));
        return { ephemeral_text: text };
      } catch (error) {
        return { ephemeral_text: error instanceof Error ? error.message : String(error) };
      }
    }
    // Proposals (Phase 2) answer here.
    return { ephemeral_text: `Nothing to do for "${request.params.name}" yet.` };
  });

  void containerLabel;
}

function containerLabel(container: Container): string {
  return `${container.title} (${container.kind})`;
}
