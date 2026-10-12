// The brain API (Phase 0, docs/brain/01-phase0-plan.md): the gate ("any entity is searchable within 5 s"),
// versions and audit, links and backlinks (FR-9.4), sign-in through Mattermost (spike B3), access (FR-9.5),
// channel linking and attribution (FR-1.7 groundwork, D50, D57), the /brain command and dialogs through
// Mattermost (spike B1), the agent routes that moved here from the admin API (D43), and the export (NFR-9).
import type { Bridge } from '@brain/bridge';
import type { Ingestion } from '@brain/ingestion';
import { nowSeconds, type MmPost } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

describe('brain API', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let bob: MmSession;
  let bridge: Bridge;
  let ingestion: Ingestion;
  let aliceCookie = '';
  let bobCookie = '';
  let gateWord = '';

  const parse = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  };
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
  const json = async (path: string, init: RequestInit = {}, auth?: { token?: string; cookie?: string }): Promise<unknown> => {
    const response = await call(path, init, auth);
    const body = await parse(response);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  };
  type SearchResponse = { results: { entityId: string; containerId: string; matched: string[]; citation: { url?: string } }[]; semantic: boolean };
  const search = (q: string, auth?: { token?: string; cookie?: string }): Promise<SearchResponse> => json(`/api/v1/brain/search?q=${encodeURIComponent(q)}`, {}, auth) as Promise<SearchResponse>;

  /** Sign a person in the way the browser flow does (spike B3) and return the session cookie. */
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
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${api.url}/containers`);
    return callback.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    api = await stack.startBrainApi();
    const setup = (await json('/api/v1/brain/setup/mattermost', { method: 'POST' })) as { oauthClientId: string; commands: unknown[] };
    expect(setup.commands.length).toBeGreaterThan(0);
    aliceCookie = await signIn(alice, setup.oauthClientId);
    bobCookie = await signIn(bob, setup.oauthClientId);
    bridge = await stack.startBridge();
    ingestion = await stack.startIngestion({ INGEST_DEBOUNCE_SECONDS: '1' });
  }, 180_000);

  afterAll(async () => {
    await ingestion?.stop();
    await bridge?.stop();
    await stack?.archiveCreatedChannels();
    await api?.stop();
    await stack?.close();
  });

  it('gate: a new entity is searchable within 5 seconds, by keywords and by meaning', { timeout: 60_000 }, async () => {
    gateWord = uniqueName('zebra').replace(/-/g, '');
    const { container } = (await json('/api/v1/brain/containers', { method: 'POST', body: JSON.stringify({ kind: 'project', title: `Gate project ${gateWord}` }) })) as { container: { id: string; slug: string } };
    expect(container.slug).toContain('gate-project');
    const created = Date.now();
    const { entity } = (await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'decision', title: `Decision about ${gateWord}`, containerId: container.id, text: `We decided that ${gateWord} is the code name of the warehouse migration.` }) })) as { entity: { id: string; version: number } };
    const found = await waitFor(async () => {
      const result = await search(gateWord);
      return result.results.find((hit) => hit.entityId === entity.id) ? result : undefined;
    }, 5000, 200);
    expect(Date.now() - created).toBeLessThan(5000);
    expect(found.results[0]?.matched).toContain('keyword');

    // The worker embeds the new chunk (mock provider); a paraphrase then matches by meaning as well.
    await api.worker?.runOnce();
    const byMeaning = await search('code name warehouse migration');
    const hit = byMeaning.results.find((candidate) => candidate.entityId === entity.id);
    expect(byMeaning.semantic).toBe(true);
    expect(hit?.matched).toContain('semantic');

    // Every change is a version; every write is audited.
    await json(`/api/v1/brain/entities/${entity.id}`, { method: 'PATCH', body: JSON.stringify({ title: `Decision about ${gateWord}, revised` }) });
    const { versions } = (await json(`/api/v1/brain/entities/${entity.id}/versions`)) as { versions: { version: number; title: string }[] };
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    const { entries } = (await json(`/api/v1/brain/audit?entity=${entity.id}`)) as { entries: { action: string; actorKind: string }[] };
    expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(['entity.create', 'entity.update']));
    expect(entries.every((entry) => entry.actorKind === 'system')).toBe(true);
  });

  it('links and backlinks (FR-9.4)', { timeout: 30_000 }, async () => {
    const word = uniqueName('erp').replace(/-/g, '');
    const { entity: system } = (await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'system', title: `System ${word}`, containerId: 'general', text: 'The warehouse ERP.' }) })) as { entity: { id: string } };
    const { entity: requirement } = (await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'requirement', title: `Requirement ${word}`, containerId: 'general', text: `Needs an export from System ${word} every night.` }) })) as { entity: { id: string } };
    const { link } = (await json('/api/v1/brain/links', { method: 'POST', body: JSON.stringify({ fromId: requirement.id, toId: system.id, kind: 'depends_on' }) })) as { link: { id: number; kind: string } };
    expect(link.kind).toBe('depends_on');
    const backlinks = (await json(`/api/v1/brain/entities/${system.id}/backlinks`)) as { links: { fromId: string }[]; mentions: { entityId: string }[] };
    expect(backlinks.links.map((candidate) => candidate.fromId)).toEqual([requirement.id]);
    expect(backlinks.mentions.map((mention) => mention.entityId)).toContain(requirement.id);
    const links = (await json(`/api/v1/brain/entities/${requirement.id}/links?kind=depends_on`)) as { outgoing: { toId: string }[] };
    expect(links.outgoing.map((candidate) => candidate.toId)).toEqual([system.id]);
  });

  it('a signed-in person is who Mattermost says, and browser writes need the header', { timeout: 30_000 }, async () => {
    const me = (await json('/api/v1/brain/me', {}, { cookie: aliceCookie })) as { principal: { kind: string; username: string; isAdmin: boolean } };
    expect(me.principal).toMatchObject({ kind: 'person', username: 'alice', isAdmin: false });
    const withoutHeader = await fetch(`${api.url}/api/v1/brain/containers`, { method: 'POST', headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'topic', title: 'no header' }) });
    expect(withoutHeader.status).toBe(403);
    expect((await fetch(`${api.url}/api/v1/brain/containers`)).status).toBe(401);
    expect((await fetch(`${api.url}/api/v1/brain/containers`, { headers: { Authorization: 'Bearer FAKE-not-the-token' } })).status).toBe(401);
  });

  it("a private channel's conversation is visible to its members only (FR-9.5)", { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'P', 'api-private');
    await stack.enable(alice, channel.id);
    const word = uniqueName('pelican').replace(/-/g, '');
    await stack.post(alice, channel.id, `the ${word} plan stays between us`);
    const entityId = await waitFor(async () => (await search(word)).results.find((hit) => hit.matched.includes('keyword'))?.entityId, 60_000, 500);
    // Memberships are cached briefly (access.ts); the channel is newer than the cache from sign-in.
    api.access.invalidate(alice.user.id);
    api.access.invalidate(bob.user.id);
    expect((await search(word, { cookie: aliceCookie })).results.map((hit) => hit.entityId)).toContain(entityId);
    expect((await search(word, { cookie: bobCookie })).results.map((hit) => hit.entityId)).not.toContain(entityId);
    expect((await call(`/api/v1/brain/entities/${entityId}`, {}, { cookie: bobCookie })).status).toBe(404);
    expect((await call(`/api/v1/brain/entities/${entityId}`, {}, { cookie: aliceCookie })).status).toBe(200);
  });

  it('a channel linked to a Topic feeds it: existing and new threads, @brain in the channel, a pinned note (D50, D57)', { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'api-topic');
    await stack.enable(alice, channel.id);
    const before = uniqueName('heron').replace(/-/g, '');
    await stack.post(alice, channel.id, `${before} was said before the link`);
    const keywordHit = (q: string) => async () => (await search(q)).results.find((hit) => hit.matched.includes('keyword'));
    const earlier = await waitFor(keywordHit(before), 60_000, 500);
    expect(earlier.containerId).toBe('general');

    const { container, channel: link } = (await json('/api/v1/brain/containers', { method: 'POST', body: JSON.stringify({ kind: 'topic', title: `Topic ${before}`, channel: { mmChannelId: channel.id, role: 'home' } }) }, { cookie: aliceCookie })) as { container: { id: string; channelId: string }; channel: { containerId: string; role: string } };
    expect(link).toMatchObject({ containerId: container.id, role: 'home' });
    expect(container.channelId).toBe(channel.id);
    expect((await keywordHit(before)())?.containerId).toBe(container.id);

    const after = uniqueName('egret').replace(/-/g, '');
    await stack.post(alice, channel.id, `${after} is said after the link`);
    await waitFor(async () => (await keywordHit(after)())?.containerId === container.id, 60_000, 500);
    const { entities } = (await json(`/api/v1/brain/containers/${container.id}/entities?type=conversation`, {}, { cookie: aliceCookie })) as { entities: { id: string }[] };
    expect(entities.length).toBeGreaterThanOrEqual(2);

    const pinned = await alice.api.get<{ order: string[]; posts: Record<string, MmPost> }>(`/channels/${channel.id}/pinned`);
    const note = Object.values(pinned.posts).find((post) => (post.props as { brain?: { containerId?: string } } | undefined)?.brain?.containerId === container.id);
    expect(note?.message).toContain(`Topic ${before}`);
    expect(note?.message).toContain(`${api.url}/containers/${container.id}`);
  });

  it('/brain search answers through Mattermost (spike B1)', { timeout: 30_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'api-command');
    const response = await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: `/brain search ${gateWord}` });
    const body = (await response.json()) as { response_type?: string; text?: string };
    expect(response.ok).toBe(true);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain(gateWord);
    const help = (await (await alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: '/brain help' })).json()) as { text?: string };
    expect(help.text).toContain('/brain search');
  });

  it('a dialog submission from Mattermost links the channel (spike B1)', { timeout: 60_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'api-dialog');
    const { container } = (await json('/api/v1/brain/containers', { method: 'POST', body: JSON.stringify({ kind: 'project', title: `Dialog project ${uniqueName('d')}` }) })) as { container: { id: string } };
    const teamId = await stack.teamId();
    const state = api.tokens.sign({ uid: alice.user.id, exp: nowSeconds() + 600, use: 'state', data: { purpose: 'link', channel: channel.id, team: teamId } });
    const submit = await alice.api.raw('POST', '/actions/dialogs/submit', { url: `${api.internalUrl}/mm/dialogs/link`, callback_id: 'link', state, user_id: alice.user.id, channel_id: channel.id, team_id: teamId, submission: { container: container.id, role: 'linked' }, cancelled: false });
    expect(submit.ok).toBe(true);
    const link = await waitFor(() => api.store.channelLinkByMm(channel.id), 20_000);
    expect(link.containerId).toBe(container.id);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'active', 30_000);
    // A forged state is refused.
    const forged = await fetch(`${api.internalUrl.replace('host.docker.internal', '127.0.0.1')}/mm/dialogs/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'nope', user_id: alice.user.id, channel_id: channel.id, team_id: teamId, submission: { container: container.id } }) });
    expect(forged.status).toBe(401);
  });

  it('agents and channels (the former admin API, D43)', { timeout: 90_000 }, async () => {
    const { agent } = (await json('/api/v1/brain/agents', { method: 'POST', body: JSON.stringify({ handle: 'api-agent', name: 'API Agent', model: 'echo' }) })) as { agent: Record<string, unknown> };
    expect(agent).toMatchObject({ handle: 'api-agent', model: 'echo', status: 'active' });
    expect(Object.keys(agent).some((key) => /token|secret/i.test(key))).toBe(false);
    const channel = await stack.createChannel(alice, 'O', 'api-agents');
    expect((await call(`/api/v1/brain/channels/${channel.id}/agents`, { method: 'POST', body: JSON.stringify({ handle: 'api-agent' }) })).status).toBe(409);
    expect((await call(`/api/v1/brain/channels/${channel.id}/enable`, { method: 'POST' })).status).toBe(202);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'active', 30_000);
    expect((await call(`/api/v1/brain/channels/${channel.id}/agents`, { method: 'POST', body: JSON.stringify({ handle: 'api-agent' }) })).status).toBe(202);
    await waitFor(async () => (await alice.api.raw('GET', `/channels/${channel.id}/members/${String(agent.mmBotUserId)}`)).ok, 20_000);
    expect((await call(`/api/v1/brain/channels/${channel.id}/agents/api-agent`, { method: 'DELETE' })).status).toBe(202);
    const { agents } = (await json('/api/v1/brain/agents')) as { agents: { handle: string }[] };
    expect(agents.map((candidate) => candidate.handle)).toContain('api-agent');
    // People who are not administrators may not manage agents.
    expect((await call('/api/v1/brain/agents', {}, { cookie: aliceCookie })).status).toBe(403);
  });

  it('exports every table as JSON Lines (NFR-9)', { timeout: 60_000 }, async () => {
    const manifest = (await json('/api/v1/brain/export/manifest')) as { format: string; tables: Record<string, number>; files: string[] };
    expect(manifest.format).toBe('jsonl/1');
    expect(manifest.files).toContain('entities.jsonl');
    const response = await call('/api/v1/brain/export/entities.jsonl');
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await response.text()).trim().split('\n');
    expect(lines).toHaveLength(manifest.tables.entities!);
    expect(JSON.parse(lines[0]!)).toHaveProperty('id');
    expect((await call('/api/v1/brain/export/manifest', {}, { cookie: aliceCookie })).status).toBe(403);
  });
});
