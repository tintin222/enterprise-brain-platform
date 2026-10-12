// Systems (FR-3; docs/brain/02-phase1-plan.md section 5): a system described once and used by projects (FR-3.1,
// 3.7), a DDL and an OpenAPI upload read into structure (FR-3.2, 3.3), integrations (FR-3.4), the inventory
// (FR-3.5), and the diff between two versions of an artifact (FR-3.6).
import { nowSeconds } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

const DDL = `CREATE TABLE erp.customers (id serial PRIMARY KEY, name varchar(200) NOT NULL);
CREATE TABLE erp.orders (id bigint PRIMARY KEY, customer_id integer REFERENCES erp.customers(id), total numeric(12,2));`;
const OPENAPI = JSON.stringify({ openapi: '3.0.3', info: { title: 'ERP API' }, servers: [{ url: 'https://erp.example.com/api' }], paths: { '/orders': { get: { summary: 'List orders', responses: { '200': { description: 'ok' } } }, post: { summary: 'Create an order', responses: { '201': { description: 'created' } } } } } });

describe('systems', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let aliceCookie = '';

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
  async function upload(auth: { token?: string; cookie?: string }, name: string, content: string, type: string, fields: Record<string, string>): Promise<{ document: Entity }> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([content], { type }), name);
    const response = await fetch(`${api.url}/api/v1/brain/documents`, { method: 'POST', body: form, headers: headers(auth) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} upload: ${text.slice(0, 300)}`);
    return JSON.parse(text) as { document: Entity };
  }
  type Entity = { id: string; title: string; version: number; data: Record<string, unknown>; text: string };
  const untilExtracted = (id: string): Promise<Entity> =>
    waitFor(async () => {
      await api.extraction?.runOnce();
      const { entity } = await json<{ entity: Entity }>(`/api/v1/brain/entities/${id}`);
      const state = (entity.data.extracted as { status?: string } | undefined)?.status;
      return state && state !== 'pending' ? entity : undefined;
    }, 20_000, 250);

  async function signIn(session: MmSession, clientId: string): Promise<string> {
    const state = api.tokens.sign({ uid: 'anonymous', exp: nowSeconds() + 600, use: 'state', data: { purpose: 'login', redirect: '/' } });
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
    api = await stack.startBrainApi();
    const setup = await json<{ oauthClientId: string }>('/api/v1/brain/setup/mattermost', { method: 'POST' });
    aliceCookie = await signIn(alice, setup.oauthClientId);
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
    await stack?.close();
  });

  it('a system is described once, lives in General and is used by a project (FR-3.1, FR-3.7)', { timeout: 60_000 }, async () => {
    const { container } = await json<{ container: { id: string } }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `ERP rollout ${uniqueName('p')}`, channels: false }) }, { cookie: aliceCookie });
    const { system } = await json<{ system: Entity & { containerId: string } }>('/api/v1/brain/systems', { method: 'POST', body: JSON.stringify({ title: `ERP ${uniqueName('s')}`, description: 'The client ERP', stack: ['java', 'oracle'], environments: [{ name: 'prod', url: 'https://erp.example.com' }], repositories: ['git@example.com:erp/core.git'], deployment: 'on-prem', containerIds: [container.id] }) }, { cookie: aliceCookie });
    expect(system.containerId).toBe('general');
    expect(system.text).toContain('oracle');
    const view = await json<{ containers: { id: string }[] }>(`/api/v1/brain/systems/${system.id}`, {}, { cookie: aliceCookie });
    expect(view.containers.map((item) => item.id)).toEqual([container.id]);
    const home = await json<{ systems: { id: string }[] }>(`/api/v1/brain/containers/${container.id}/home`, {}, { cookie: aliceCookie });
    expect(home.systems.map((item) => item.id)).toEqual([system.id]);
    const listed = await json<{ systems: { id: string }[] }>(`/api/v1/brain/systems?container=${container.id}`, {}, { cookie: aliceCookie });
    expect(listed.systems.map((item) => item.id)).toEqual([system.id]);
  });

  it('a DDL upload and an OpenAPI upload are read into structure and made searchable (FR-3.2, FR-3.3)', { timeout: 90_000 }, async () => {
    const { system } = await json<{ system: Entity }>('/api/v1/brain/systems', { method: 'POST', body: JSON.stringify({ title: `Schema ${uniqueName('s')}` }) }, { cookie: aliceCookie });
    const { document: ddl } = await upload({ cookie: aliceCookie }, 'erp.sql', DDL, 'application/sql', { attachTo: system.id, artifact: 'ddl' });
    const read = await untilExtracted(ddl.id);
    const structure = read.data.structure as { kind: string; tables: { name: string; columns: { name: string }[] }[] };
    expect(structure.kind).toBe('ddl');
    expect(structure.tables.map((table) => table.name)).toEqual(['customers', 'orders']);
    expect(read.text).toContain('## Table erp.orders');
    const { document: spec } = await upload({ cookie: aliceCookie }, 'erp-api.json', OPENAPI, 'application/json', { attachTo: system.id, artifact: 'openapi' });
    const api2 = await untilExtracted(spec.id);
    const apiStructure = api2.data.structure as { kind: string; endpoints: { method: string; path: string }[] };
    expect(apiStructure.kind).toBe('openapi');
    expect(apiStructure.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual(['GET /orders', 'POST /orders']);
    const view = await json<{ artifacts: { id: string; data: { artifact: string } }[] }>(`/api/v1/brain/systems/${system.id}`, {}, { cookie: aliceCookie });
    expect(view.artifacts.map((artifact) => artifact.data.artifact).sort()).toEqual(['ddl', 'openapi']);
    const found = await waitFor(async () => (await json<{ results: { entityId: string }[] }>('/api/v1/brain/search?q=customers%20orders', {}, { cookie: aliceCookie })).results.find((hit) => hit.entityId === ddl.id), 10_000, 500);
    expect(found).toBeTruthy();
  });

  it('integrations and the inventory are recorded; versions of an artifact can be compared (FR-3.4, FR-3.5, FR-3.6)', { timeout: 90_000 }, async () => {
    const { system: erp } = await json<{ system: Entity }>('/api/v1/brain/systems', { method: 'POST', body: JSON.stringify({ title: `ERP ${uniqueName('a')}` }) }, { cookie: aliceCookie });
    const { system: wms } = await json<{ system: Entity }>('/api/v1/brain/systems', { method: 'POST', body: JSON.stringify({ title: `WMS ${uniqueName('b')}` }) }, { cookie: aliceCookie });
    const { link } = await json<{ link: { kind: string; data: { protocol: string } } }>(`/api/v1/brain/systems/${wms.id}/integrations`, { method: 'POST', body: JSON.stringify({ toSystemId: erp.id, protocol: 'REST', payload: 'stock levels, every 15 minutes' }) }, { cookie: aliceCookie });
    expect(link.kind).toBe('depends_on');
    expect(link.data.protocol).toBe('REST');
    const erpView = await json<{ integrations: { direction: string; other: { id: string } }[] }>(`/api/v1/brain/systems/${erp.id}`, {}, { cookie: aliceCookie });
    expect(erpView.integrations.some((item) => item.direction === 'incoming' && item.other.id === wms.id)).toBe(true);
    const { system: updated } = await json<{ system: Entity }>(`/api/v1/brain/systems/${erp.id}`, { method: 'PATCH', body: JSON.stringify({ inventory: { screens: ['Order entry', 'Stock overview'], knownIssues: ['Slow month-end close'] } }) }, { cookie: aliceCookie });
    expect((updated.data.inventory as { screens: string[] }).screens).toEqual(['Order entry', 'Stock overview']);
    expect(updated.text).toContain('Slow month-end close');
    // Two uploads of the schema file: the diff shows the added table.
    const first = await upload({ cookie: aliceCookie }, 'schema.sql', 'CREATE TABLE a (id int PRIMARY KEY);', 'application/sql', { attachTo: erp.id, artifact: 'ddl' });
    await untilExtracted(first.document.id);
    const second = await upload({ cookie: aliceCookie }, 'schema.sql', 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));', 'application/sql', { attachTo: erp.id, artifact: 'ddl' });
    expect(second.document.id).toBe(first.document.id);
    const latest = await untilExtracted(first.document.id);
    const { versions } = await json<{ versions: { version: number; text: string }[] }>(`/api/v1/brain/entities/${first.document.id}/versions`, {}, { cookie: aliceCookie });
    const withText = versions.filter((version) => version.text.includes('CREATE TABLE')).map((version) => version.version);
    const to = latest.version;
    const from = withText.at(-1) ?? 1;
    const diff = await json<{ text: { changed: boolean; hunks: { kind: string; text: string }[][] }; fields: { field: string }[] }>(`/api/v1/brain/entities/${first.document.id}/versions/${from}/diff/${to}`, {}, { cookie: aliceCookie });
    expect(diff.text.changed).toBe(true);
    expect(diff.text.hunks.flat().some((line) => line.kind === 'added' && line.text.includes('CREATE TABLE b'))).toBe(true);
    expect(diff.fields.map((change) => change.field)).toContain('structure');
  });
});
