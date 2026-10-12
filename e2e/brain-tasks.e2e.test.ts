// Tasks (FR-11.1 to 11.3; docs/brain/02-phase1-plan.md section 7): one-step creation, the board states and
// comments, /task from a chat thread with the thread as evidence, /task mine, the morning reminder with its
// buttons (a button press through Mattermost completes the task), and an agent's proposal accepted into a task.
import { nowSeconds, type MmChannel, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

describe('tasks', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let bob: MmSession;
  let aliceCookie = '';
  let bobCookie = '';
  let projectId = '';
  let alicePerson = '';
  let bobPerson = '';

  const headers = (auth: { token?: string; cookie?: string }, json = false): Record<string, string> => ({
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'X-Requested-With': 'XMLHttpRequest',
    ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    ...(auth.cookie ? { Cookie: auth.cookie } : {}),
  });
  const json = async <T = unknown>(path: string, init: RequestInit = {}, auth: { token?: string; cookie?: string } = { token: api.token }): Promise<T> => {
    const response = await fetch(`${api.url}${path}`, { ...init, headers: { ...headers(auth, init.body !== undefined), ...(init.headers ?? {}) } });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };
  type Task = { id: string; title: string; status: string; version: number; containerId: string; data: Record<string, unknown> };

  async function signIn(session: MmSession, clientId: string): Promise<string> {
    const state = api.tokens.sign({ uid: 'anonymous', exp: nowSeconds() + 600, use: 'state', data: { purpose: 'login', redirect: '/tasks' } });
    const authorize = await fetch(`${stack.config.MM_URL}/oauth/authorize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.api.token ?? ''}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ response_type: 'code', client_id: clientId, redirect_uri: `${api.url}/auth/callback`, state }),
    });
    const { redirect } = (await authorize.json()) as { redirect: string };
    const code = new URL(redirect).searchParams.get('code') ?? '';
    const callback = await fetch(`${api.url}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    return callback.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    api = await stack.startBrainApi();
    const setup = await json<{ oauthClientId: string }>('/api/v1/brain/setup/mattermost', { method: 'POST' });
    aliceCookie = await signIn(alice, setup.oauthClientId);
    bobCookie = await signIn(bob, setup.oauthClientId);
    alicePerson = (await json<{ principal: { personId: string } }>('/api/v1/brain/me', {}, { cookie: aliceCookie })).principal.personId;
    bobPerson = (await json<{ principal: { personId: string } }>('/api/v1/brain/me', {}, { cookie: bobCookie })).principal.personId;
    const { container } = await json<{ container: { id: string } }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `Tasks ${uniqueName('p')}`, channels: false }) }, { cookie: aliceCookie });
    projectId = container.id;
    await json(`/api/v1/brain/containers/${projectId}/members`, { method: 'POST', body: JSON.stringify({ personId: bobPerson, role: 'developer' }) }, { cookie: aliceCookie });
  }, 180_000);

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await api?.stop();
    await stack?.close();
  });

  it('a task takes one step to create; it moves across the board, takes comments, and shows in "my tasks" (FR-11.1)', { timeout: 60_000 }, async () => {
    const { task } = await json<{ task: Task }>('/api/v1/brain/tasks', { method: 'POST', body: JSON.stringify({ title: 'Send the signed offer', containerId: projectId, assigneeId: bobPerson, dueAt: '2026-12-01' }) }, { cookie: aliceCookie });
    expect(task.data).toMatchObject({ state: 'open', priority: 'normal', assigneeId: bobPerson, dueAt: '2026-12-01' });
    const mine = await json<{ tasks: Task[] }>('/api/v1/brain/tasks/mine', {}, { cookie: bobCookie });
    expect(mine.tasks.map((item) => item.id)).toContain(task.id);
    const started = await json<{ task: Task }>(`/api/v1/brain/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'in_progress' }) }, { cookie: bobCookie });
    expect(started.task.data.state).toBe('in_progress');
    const commented = await json<{ task: Task }>(`/api/v1/brain/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ text: 'Offer sent by mail' }) }, { cookie: bobCookie });
    expect((commented.task.data.comments as { by: string; text: string }[])[0]).toMatchObject({ by: bobPerson, text: 'Offer sent by mail' });
    const done = await json<{ task: Task }>(`/api/v1/brain/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'done' }) }, { cookie: bobCookie });
    expect(done.task.status).toBe('closed');
    expect(done.task.data.doneAt).toBeTruthy();
    const open = await json<{ tasks: Task[] }>(`/api/v1/brain/containers/${projectId}/tasks?state=open`, {}, { cookie: aliceCookie });
    expect(open.tasks.some((item) => item.id === task.id)).toBe(false);
    const { versions } = await json<{ versions: { version: number }[] }>(`/api/v1/brain/entities/${task.id}/versions`, {}, { cookie: aliceCookie });
    expect(versions.length).toBe(4);
  });

  it('/task in a chat thread makes a task with the thread as evidence; /task mine lists it (FR-11.1)', { timeout: 60_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'tasks-chat', [bob.user.id]);
    await json(`/api/v1/brain/containers/${projectId}/channels`, { method: 'POST', body: JSON.stringify({ mmChannelId: channel.id, role: 'linked' }) }, { cookie: aliceCookie });
    const root = await stack.post(bob, channel.id, 'Can someone call the supplier about the delayed pallets?');
    const response = await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, root_id: root.id, command: '/task Call the supplier about the pallets' });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { text?: string };
    expect(body.text).toContain('Task created');
    const mine = await json<{ tasks: Task[] }>('/api/v1/brain/tasks/mine', {}, { cookie: aliceCookie });
    const task = mine.tasks.find((item) => item.title === 'Call the supplier about the pallets');
    expect(task?.containerId).toBe(projectId);
    const evidence = task?.data.evidence as { kind: string; ref: string; url?: string; title?: string }[];
    expect(evidence[0]).toMatchObject({ kind: 'post', ref: root.id });
    expect(evidence[0]?.url).toContain(root.id);
    expect(evidence[0]?.title).toContain('delayed pallets');
    const listed = (await (await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: '/task mine' })).json()) as { text?: string };
    expect(listed.text).toContain('Call the supplier about the pallets');
  });

  it('the morning reminder lists due and overdue tasks with buttons, and a button press completes the task (FR-11.2)', { timeout: 90_000 }, async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const { task } = await json<{ task: Task }>('/api/v1/brain/tasks', { method: 'POST', body: JSON.stringify({ title: `Overdue ${uniqueName('t')}`, containerId: projectId, assigneeId: alicePerson, dueAt: yesterday, priority: 'high' }) }, { cookie: aliceCookie });
    const result = await api.jobs.runNow('task-reminders');
    expect(result?.sent).toBeGreaterThanOrEqual(1);
    const botId = await stack.botUserId();
    const direct = await alice.api.post<MmChannel>('/channels/direct', [alice.user.id, botId]);
    const posts = await alice.api.get<{ posts: Record<string, MmPost> }>(`/channels/${direct.id}/posts?per_page=30`);
    const reminder = Object.values(posts.posts)
      .filter((post) => (post.props as { brain?: { kind?: string } } | undefined)?.brain?.kind === 'reminder')
      .sort((a, b) => b.create_at - a.create_at)[0];
    expect(reminder?.message).toMatch(/overdue/);
    const attachments = (reminder?.props as { attachments?: { title: string; actions: { id: string; name: string }[] }[] }).attachments ?? [];
    const card = attachments.find((attachment) => attachment.title === task.title);
    expect(card?.actions.map((action) => action.name)).toEqual(['Done', 'Snooze a day', 'Snooze a week', 'Reassign']);
    // Pressing "Done" in Mattermost calls our action endpoint with the signed context.
    const done = card!.actions.find((action) => action.name === 'Done')!;
    const pressed = await alice.api.raw('POST', `/posts/${reminder!.id}/actions/${done.id}`, {});
    expect(pressed.ok).toBe(true);
    const after = await waitFor(async () => {
      const { task: current } = await json<{ task: Task }>(`/api/v1/brain/tasks/${task.id}`, {}, { cookie: aliceCookie });
      return current.data.state === 'done' ? current : undefined;
    }, 20_000, 500);
    expect(after.status).toBe('closed');
  });

  it("an agent's proposal shares the model and becomes a normal task on acceptance (FR-11.3)", { timeout: 60_000 }, async () => {
    const proposed = await api.store.createEntity(
      { type: 'task', title: `Follow up on the invoice ${uniqueName('t')}`, containerId: projectId, ownerId: bobPerson, data: { assigneeId: bobPerson, dueAt: '2026-12-15', priority: 'normal', state: 'open', comments: [], evidence: [], proposal: { by: 'follow-up', state: 'proposed', at: new Date().toISOString() }, snoozedUntil: null } },
      { actor: { kind: 'agent', id: 'follow-up' }, source: { kind: 'system' } },
    );
    const mine = await json<{ tasks: Task[] }>('/api/v1/brain/tasks/mine', {}, { cookie: bobCookie });
    expect(mine.tasks.find((item) => item.id === proposed.id)).toBeTruthy();
    const accepted = await json<{ task: Task }>(`/api/v1/brain/tasks/${proposed.id}/accept`, { method: 'POST' }, { cookie: bobCookie });
    expect((accepted.task.data.proposal as { state: string; decidedBy: string }).state).toBe('accepted');
    expect((accepted.task.data.proposal as { decidedBy: string }).decidedBy).toBe(bobPerson);
    const again = await fetch(`${api.url}/api/v1/brain/tasks/${proposed.id}/accept`, { method: 'POST', headers: headers({ cookie: bobCookie }) });
    expect(again.status).toBe(409);
    const dismissed = await api.store.createEntity(
      { type: 'task', title: `Noise ${uniqueName('t')}`, containerId: projectId, data: { assigneeId: bobPerson, state: 'open', priority: 'low', comments: [], evidence: [], proposal: { by: 'follow-up', state: 'proposed', at: new Date().toISOString() } } },
      { actor: { kind: 'agent', id: 'follow-up' }, source: { kind: 'system' } },
    );
    const gone = await json<{ task: Task }>(`/api/v1/brain/tasks/${dismissed.id}/dismiss`, { method: 'POST' }, { cookie: bobCookie });
    expect(gone.task.data.state).toBe('dismissed');
    expect(gone.task.status).toBe('closed');
  });
});
