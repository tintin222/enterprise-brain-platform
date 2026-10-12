// People (FR-2; docs/brain/02-phase1-plan.md section 4): a person for every account at first sight and through
// the daily sync, profiles, external contacts, roles that widen access (FR-2.3), and "who knows about X" (FR-2.4).
import type { Bridge } from '@brain/bridge';
import type { Ingestion } from '@brain/ingestion';
import { nowSeconds } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

describe('people', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let bob: MmSession;
  let bridge: Bridge;
  let ingestion: Ingestion;
  let aliceCookie = '';
  let bobCookie = '';

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
    const state = api.tokens.sign({ uid: 'anonymous', exp: nowSeconds() + 600, use: 'state', data: { purpose: 'login', redirect: '/people' } });
    const authorize = await fetch(`${stack.config.MM_URL}/oauth/authorize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.api.token ?? ''}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ response_type: 'code', client_id: clientId, redirect_uri: `${api.url}/auth/callback`, state }),
    });
    const { redirect } = (await authorize.json()) as { redirect: string };
    const code = new URL(redirect).searchParams.get('code') ?? '';
    const callback = await fetch(`${api.url}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    expect(callback.status).toBe(302);
    return callback.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  type Me = { principal: { personId?: string; userId: string } };
  type Person = { id: string; title: string; status: string; data: Record<string, unknown> };

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bob = await stack.login('bob');
    api = await stack.startBrainApi();
    const setup = await json<{ oauthClientId: string }>('/api/v1/brain/setup/mattermost', { method: 'POST' });
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

  it('a person exists for an account at its first sign-in, and the daily sync covers everyone (FR-2.1)', { timeout: 60_000 }, async () => {
    const me = await json<Me>('/api/v1/brain/me', {}, { cookie: aliceCookie });
    expect(me.principal.personId).toBeTruthy();
    const { person } = await json<{ person: Person }>(`/api/v1/brain/people/${me.principal.personId}`, {}, { cookie: aliceCookie });
    expect(person.data.username).toBe('alice');
    expect(person.data.mmUserId).toBe(alice.user.id);
    expect(person.status).toBe('active');

    // The sync job runs once a day; run it now.
    const result = await api.jobs.runNow('people-sync');
    expect(result?.people).toBeGreaterThanOrEqual(3);
    const { people } = await json<{ people: Person[] }>('/api/v1/brain/people?limit=500', {}, { cookie: aliceCookie });
    expect(people.map((item) => item.data.username)).toEqual(expect.arrayContaining(['alice', 'bob', 'sysadmin']));
    expect(people.some((item) => item.data.username === 'brain')).toBe(false);
  });

  it('a person edits their own profile; others cannot, administrators can (FR-2.1)', { timeout: 60_000 }, async () => {
    const me = await json<Me>('/api/v1/brain/me', {}, { cookie: aliceCookie });
    const word = uniqueName('kvkk').replace(/-/g, '');
    const { person } = await json<{ person: Person }>(`/api/v1/brain/people/${me.principal.personId}`, { method: 'PATCH', body: JSON.stringify({ role: 'Analyst', expertise: [word, 'warehouse'], workingHours: '09-18' }) }, { cookie: aliceCookie });
    expect(person.data.expertise).toEqual([word, 'warehouse']);
    const forbidden = await call(`/api/v1/brain/people/${me.principal.personId}`, { method: 'PATCH', body: JSON.stringify({ role: 'Intruder' }) }, { cookie: bobCookie });
    expect(forbidden.status).toBe(403);
    const asAdmin = await json<{ person: Person }>(`/api/v1/brain/people/${me.principal.personId}`, { method: 'PATCH', body: JSON.stringify({ organisation: 'Infinics' }) });
    expect(asAdmin.person.data.organisation).toBe('Infinics');
    // Expertise is searchable text.
    const found = await waitFor(async () => {
      const result = await json<{ results: { entityId: string }[] }>(`/api/v1/brain/search?q=${word}`, {}, { cookie: bobCookie });
      return result.results.some((hit) => hit.entityId === me.principal.personId) ? result : undefined;
    }, 10_000, 250);
    expect(found.results.length).toBeGreaterThan(0);
  });

  it('an external contact exists without an account (FR-2.2)', { timeout: 30_000 }, async () => {
    const name = `Client ${uniqueName('contact')}`;
    const { person } = await json<{ person: Person }>('/api/v1/brain/people', { method: 'POST', body: JSON.stringify({ name, emails: ['Ayse@Example.com'], organisation: 'Example AS', role: 'Purchasing manager' }) }, { cookie: aliceCookie });
    expect(person.data.external).toBe(true);
    expect(person.data.emails).toEqual(['ayse@example.com']);
    const { people } = await json<{ people: Person[] }>('/api/v1/brain/people?external=true', {}, { cookie: bobCookie });
    expect(people.some((item) => item.id === person.id)).toBe(true);
    const edited = await json<{ person: Person }>(`/api/v1/brain/people/${person.id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'Prefers calls in the afternoon' }) }, { cookie: bobCookie });
    expect(edited.person.data.notes).toContain('afternoon');
  });

  it('a role in a project makes someone a member who may see its entities (FR-2.3)', { timeout: 60_000 }, async () => {
    const channel = await stack.createChannel(alice, 'P', 'people-roles');
    const { container } = await json<{ container: { id: string } }>('/api/v1/brain/containers', { method: 'POST', body: JSON.stringify({ kind: 'project', title: `Roles ${uniqueName('p')}`, channel: { mmChannelId: channel.id, role: 'home' } }) }, { cookie: aliceCookie });
    const { entity } = await json<{ entity: { id: string } }>('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'decision', title: 'Members only', containerId: container.id, text: 'Only members of the project see this decision.' }) }, { cookie: aliceCookie });
    // Bob is not in the private channel: the decision is invisible to him.
    expect((await call(`/api/v1/brain/entities/${entity.id}`, {}, { cookie: bobCookie })).status).toBe(404);
    const bobMe = await json<Me>('/api/v1/brain/me', {}, { cookie: bobCookie });
    const { link } = await json<{ link: { kind: string; data: { role: string } } }>(`/api/v1/brain/containers/${container.id}/members`, { method: 'POST', body: JSON.stringify({ personId: bobMe.principal.personId, role: 'reviewer' }) }, { cookie: aliceCookie });
    expect(link.kind).toBe('member_of');
    expect(link.data.role).toBe('reviewer');
    expect((await call(`/api/v1/brain/entities/${entity.id}`, {}, { cookie: bobCookie })).status).toBe(200);
    const { members } = await json<{ members: { person: Person; role: string }[] }>(`/api/v1/brain/containers/${container.id}/members`, {}, { cookie: bobCookie });
    expect(members.map((member) => [member.person.data.username, member.role])).toContainEqual(['bob', 'reviewer']);
    const { memberships } = await json<{ memberships: { containerId: string; role: string }[] }>(`/api/v1/brain/people/${bobMe.principal.personId}`, {}, { cookie: bobCookie });
    expect(memberships).toContainEqual(expect.objectContaining({ containerId: container.id, role: 'reviewer' }));
    await json(`/api/v1/brain/containers/${container.id}/members/${bobMe.principal.personId}`, { method: 'DELETE' }, { cookie: aliceCookie });
    expect((await call(`/api/v1/brain/entities/${entity.id}`, {}, { cookie: bobCookie })).status).toBe(404);
  });

  it('"who knows about X" ranks the person who wrote about X and the owner of the matching entity (FR-2.4)', { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'people-knows', [bob.user.id]);
    await stack.enable(alice, channel.id);
    const word = uniqueName('fenerbahce').replace(/-/g, '');
    await stack.post(bob, channel.id, `${word} is the migration code name Bob keeps talking about`);
    await waitFor(async () => (await json<{ results: unknown[] }>(`/api/v1/brain/search?q=${word}`)).results.length > 0, 60_000, 500);
    const bobMe = await json<Me>('/api/v1/brain/me', {}, { cookie: bobCookie });
    const ranked = await json<{ people: { person: Person; evidence: { why: string }[] }[] }>(`/api/v1/brain/people/search?q=${word}`, {}, { cookie: aliceCookie });
    expect(ranked.people[0]?.person.id).toBe(bobMe.principal.personId);
    expect(ranked.people[0]?.evidence[0]?.why).toContain('conversation');

    // An entity alice owns about a second word puts alice first for that word.
    const aliceMe = await json<Me>('/api/v1/brain/me', {}, { cookie: aliceCookie });
    const second = uniqueName('galatasaray').replace(/-/g, '');
    await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'decision', title: `Decision about ${second}`, containerId: 'general', ownerId: aliceMe.principal.personId, text: `${second} is decided.` }) }, { cookie: aliceCookie });
    const owners = await json<{ people: { person: Person }[] }>(`/api/v1/brain/people/search?q=${second}`, {}, { cookie: bobCookie });
    expect(owners.people[0]?.person.id).toBe(aliceMe.principal.personId);
  });
});
