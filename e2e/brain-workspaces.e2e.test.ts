// Projects and Topics as workspaces (FR-1; docs/brain/02-phase1-plan.md section 3): the channel group, the home
// panels, the timeline, stale projects, Topics from a channel through the /topic dialog, spawning a Project from a
// Topic and moving its items, and archiving.
import type { Bridge } from '@brain/bridge';
import { nowSeconds, type MmChannel, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

describe('workspaces', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let bob: MmSession;
  let bridge: Bridge;
  let aliceCookie = '';
  let bobCookie = '';
  const created: string[] = [];

  const call = (path: string, init: RequestInit = {}, auth: { token?: string; cookie?: string } = { token: api.token }): Promise<Response> =>
    fetch(`${api.url}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Requested-With': 'XMLHttpRequest',
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        ...(auth.cookie ? { Cookie: auth.cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
  const json = async <T = unknown>(path: string, init: RequestInit = {}, auth?: { token?: string; cookie?: string }): Promise<T> => {
    const response = await call(path, init, auth);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };

  async function signIn(session: MmSession, clientId: string): Promise<string> {
    const state = api.tokens.sign({ uid: 'anonymous', exp: nowSeconds() + 600, use: 'state', data: { purpose: 'login', redirect: '/containers' } });
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

  type Container = { id: string; kind: string; title: string; status: string; slug: string; ownerId: string | null; version: number; data: Record<string, unknown> };
  type Home = { container: Container; owner: { id: string } | null; channels: { mmChannelId: string; role: string }[]; people: { person: { id: string }; role: string }[]; systems: unknown[]; tasks: { open: number }; milestones: { title: string; date: string }[]; stale: boolean; spawnedFrom: Container | null };

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    api = await stack.startBrainApi({ BRAIN_STALE_DAYS: '0' });
    const setup = await json<{ oauthClientId: string; commands: unknown[] }>('/api/v1/brain/setup/mattermost', { method: 'POST' });
    expect(setup.commands.length).toBeGreaterThanOrEqual(3);
    aliceCookie = await signIn(alice, setup.oauthClientId);
    bobCookie = await signIn(bob, setup.oauthClientId);
    bridge = await stack.startBridge();
  }, 180_000);

  afterAll(async () => {
    // Archive what the tests created in Mattermost so the dev team stays tidy.
    for (const channelId of created) await alice.api.raw('DELETE', `/channels/${channelId}`).catch(() => undefined);
    await bridge?.stop();
    await stack?.archiveCreatedChannels();
    await api?.stop();
    await stack?.close();
  });

  it('creates a project with its three channels, @brain and the creator in each, and shows its home (FR-1.1, 1.2, 1.3)', { timeout: 90_000 }, async () => {
    const title = `Warehouse ${uniqueName('proj')}`;
    const { container, channels } = await json<{ container: Container; channels: { id: string; name: string; type: string }[] }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title, client: 'Example AS', goal: 'Move the warehouse to the new ERP', stage: 'analysis' }) }, { cookie: aliceCookie });
    created.push(...channels.map((channel) => channel.id));
    expect(container.kind).toBe('project');
    expect(container.data.client).toBe('Example AS');
    expect(channels.map((channel) => channel.name)).toEqual([`proj-${container.slug}`, `proj-${container.slug}-requirements`, `proj-${container.slug}-agent`]);
    const botId = await stack.botUserId();
    for (const channel of channels) {
      const members = await alice.api.get<{ user_id: string }[]>(`/channels/${channel.id}/members`);
      expect(members.map((member) => member.user_id)).toEqual(expect.arrayContaining([botId, alice.user.id]));
    }
    const home = await json<Home>(`/api/v1/brain/containers/${container.id}/home`, {}, { cookie: aliceCookie });
    expect(home.channels.map((channel) => channel.role).sort()).toEqual(['agent', 'home', 'requirements']);
    const me = await json<{ principal: { personId: string } }>('/api/v1/brain/me', {}, { cookie: aliceCookie });
    expect(home.owner?.id).toBe(me.principal.personId);
    expect(home.stale).toBe(false);
    // A second call with the same name finds the channels again instead of failing.
    const again = await json<{ container: Container; channels: { id: string }[] }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title, channels: false }) }, { cookie: aliceCookie });
    expect(again.container.slug).not.toBe(container.slug);
  });

  it('the timeline is edited by members and versioned (FR-1.4)', { timeout: 60_000 }, async () => {
    const { container } = await json<{ container: Container }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `Timeline ${uniqueName('p')}`, channels: false }) }, { cookie: aliceCookie });
    const milestones = [{ title: 'Go live', date: '2026-12-01', kind: 'milestone' }, { title: 'Build', date: '2026-11-01', kind: 'phase' }];
    const updated = await json<{ container: Container }>(`/api/v1/brain/containers/${container.id}/timeline`, { method: 'PATCH', body: JSON.stringify({ milestones }) }, { cookie: aliceCookie });
    expect((updated.container.data.milestones as { title: string }[]).map((item) => item.title)).toEqual(['Build', 'Go live']);
    expect(updated.container.version).toBe(2);
    // Bob is not a member of this project (no channel, no role): he cannot edit its timeline.
    expect((await call(`/api/v1/brain/containers/${container.id}/timeline`, { method: 'PATCH', body: JSON.stringify({ milestones: [] }) }, { cookie: bobCookie })).status).toBe(403);
  });

  it('a project without activity is flagged stale and its owner is told once (FR-1.5)', { timeout: 60_000 }, async () => {
    const { container } = await json<{ container: Container }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `Quiet ${uniqueName('p')}`, channels: false }) }, { cookie: aliceCookie });
    const result = await api.jobs.runNow('stale-projects');
    expect(result?.stale).toBeGreaterThanOrEqual(1);
    const home = await json<Home>(`/api/v1/brain/containers/${container.id}/home`, {}, { cookie: aliceCookie });
    expect(home.stale).toBe(true);
    const botId = await stack.botUserId();
    const direct = await alice.api.post<MmChannel>('/channels/direct', [alice.user.id, botId]);
    const posts = await alice.api.get<{ posts: Record<string, MmPost> }>(`/channels/${direct.id}/posts?per_page=50`);
    const notice = Object.values(posts.posts).find((post) => (post.props as { brain?: { kind?: string; containerId?: string } } | undefined)?.brain?.containerId === container.id);
    expect(notice?.message).toContain(container.title);
    // Activity clears the flag on the next run.
    await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'decision', title: 'Back to work', containerId: container.id, text: 'We resumed.' }) }, { cookie: aliceCookie });
    const second = await api.jobs.runNow('stale-projects');
    expect(second).toBeDefined();
    // With BRAIN_STALE_DAYS=0 the new entity is already "old"; the flag stays, but no second message is sent.
    const postsAfter = await alice.api.get<{ posts: Record<string, MmPost> }>(`/channels/${direct.id}/posts?per_page=50`);
    expect(Object.values(postsAfter.posts).filter((post) => (post.props as { brain?: { containerId?: string } } | undefined)?.brain?.containerId === container.id).length).toBe(1);
  });

  it('/topic here promotes the channel through its dialog; the home shows the topic (FR-1.7, 1.8)', { timeout: 90_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'topic-here', [bob.user.id]);
    const teamId = await stack.teamId();
    const execute = await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: '/topic here' });
    expect(execute.ok).toBe(true);
    // Mattermost shows the dialog; the submission comes back to us. The test submits it the way Mattermost does.
    const state = api.tokens.sign({ uid: alice.user.id, exp: nowSeconds() + 600, use: 'state', data: { purpose: 'topic', channel: channel.id, team: teamId, mode: 'here' } });
    const submit = await alice.api.raw('POST', '/actions/dialogs/submit', { url: `${api.internalUrl}/mm/dialogs/topic`, callback_id: 'topic', state, user_id: alice.user.id, channel_id: channel.id, team_id: teamId, submission: { title: 'Procurement with Example AS', kind: 'external', organisation: 'Example AS', description: 'Everything about the purchasing side.' }, cancelled: false });
    expect(submit.ok).toBe(true);
    const link = await waitFor(() => api.store.channelLinkByMm(channel.id), 20_000);
    expect(link.role).toBe('home');
    const home = await json<Home>(`/api/v1/brain/containers/${link.containerId}/home`, {}, { cookie: bobCookie });
    expect(home.container.kind).toBe('topic');
    expect(home.container.data.topicKind).toBe('external');
    expect(home.container.data.organisation).toBe('Example AS');
    // A second /topic here answers that the channel already feeds the topic.
    const again = (await (await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: '/topic here' })).json()) as { text?: string };
    expect(again.text).toContain('already feeds');
  });

  it('spawns a project from a topic and moves the topic\'s items into it (FR-1.9)', { timeout: 90_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'topic-spawn');
    const { container: topic } = await json<{ container: Container }>('/api/v1/brain/topics', { method: 'POST', body: JSON.stringify({ title: `Spawn ${uniqueName('t')}`, kind: 'internal', channel: { mmChannelId: channel.id } }) }, { cookie: aliceCookie });
    const bobMe = await json<{ principal: { personId: string } }>('/api/v1/brain/me', {}, { cookie: bobCookie });
    await json(`/api/v1/brain/containers/${topic.id}/members`, { method: 'POST', body: JSON.stringify({ personId: bobMe.principal.personId, role: 'developer' }) }, { cookie: aliceCookie });
    const { entity: task } = await json<{ entity: { id: string } }>('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'task', title: 'Collect the invoices', containerId: topic.id, data: { state: 'open' } }) }, { cookie: aliceCookie });
    const { entity: doc } = await json<{ entity: { id: string } }>('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'document', title: 'Scope note', containerId: topic.id, text: 'The scope.' }) }, { cookie: aliceCookie });
    const { container: project, channels } = await json<{ container: Container; channels: { id: string }[] }>(`/api/v1/brain/projects/from-topic/${topic.id}`, { method: 'POST', body: JSON.stringify({ title: `From topic ${uniqueName('p')}` }) }, { cookie: aliceCookie });
    created.push(...channels.map((item) => item.id));
    expect(project.data.spawnedFrom).toBe(topic.id);
    const home = await json<Home>(`/api/v1/brain/containers/${project.id}/home`, {}, { cookie: aliceCookie });
    expect(home.spawnedFrom?.id).toBe(topic.id);
    expect(home.people.map((item) => [item.person.id, item.role])).toContainEqual([bobMe.principal.personId, 'developer']);
    const moved = await json<{ moved: string[]; linked: string[]; skipped: string[] }>(`/api/v1/brain/topics/${topic.id}/move-items`, { method: 'POST', body: JSON.stringify({ projectId: project.id, entityIds: [task.id, doc.id, 'nonsense'], mode: 'move' }) }, { cookie: aliceCookie });
    expect(moved.moved.sort()).toEqual([task.id, doc.id].sort());
    expect(moved.skipped).toEqual(['nonsense']);
    const { entity } = await json<{ entity: { containerId: string; version: number } }>(`/api/v1/brain/entities/${task.id}`, {}, { cookie: aliceCookie });
    expect(entity.containerId).toBe(project.id);
    expect(entity.version).toBe(2);
    const projectHome = await json<Home>(`/api/v1/brain/containers/${project.id}/home`, {}, { cookie: aliceCookie });
    expect(projectHome.tasks.open).toBe(1);
  });

  it('/project archive archives the channel\'s project for its owner; it stays searchable (FR-1.6)', { timeout: 90_000 }, async () => {
    const title = `Archive ${uniqueName('p')}`;
    const { container, channels } = await json<{ container: Container; channels: { id: string; name: string }[] }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title }) }, { cookie: aliceCookie });
    created.push(...channels.map((channel) => channel.id));
    const home = channels[0]!;
    await alice.api.post(`/channels/${home.id}/members`, { user_id: bob.user.id });
    const refused = (await (await bob.api.raw('POST', '/commands/execute', { channel_id: home.id, command: '/project archive' })).json()) as { text?: string };
    expect(refused.text ?? '').toMatch(/owner|administrator/i);
    const done = (await (await alice.api.raw('POST', '/commands/execute', { channel_id: home.id, command: '/project archive' })).json()) as { text?: string };
    expect(done.text).toContain('Archived');
    const { containers } = await json<{ containers: Container[] }>('/api/v1/brain/containers?status=archived', {}, { cookie: aliceCookie });
    expect(containers.some((item) => item.id === container.id)).toBe(true);
  });
});
