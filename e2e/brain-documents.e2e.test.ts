// Documents (FR-5; docs/brain/02-phase1-plan.md section 6): upload and extraction, searchable within 5 s,
// versions by name (FR-5.3), confidential access and its audit (FR-5.5), no-ai files never reach the OCR
// provider (D65), and chat attachments through the same pipeline (FR-5.6).
import type { Bridge } from '@brain/bridge';
import type { Ingestion } from '@brain/ingestion';
import { nowSeconds } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, waitFor, type BrainApiHandle, type MmSession } from './lib/harness.ts';

const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 18 Tf 20 100 Td (The migration plan inside the pdf) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('documents', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let alice: MmSession;
  let bob: MmSession;
  let bridge: Bridge;
  let ingestion: Ingestion;
  let aliceCookie = '';
  let bobCookie = '';
  let projectId = '';

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
  const status = async (path: string, auth: { token?: string; cookie?: string }): Promise<number> => (await fetch(`${api.url}${path}`, { headers: headers(auth) })).status;
  async function upload(auth: { token?: string; cookie?: string }, name: string, content: Buffer | string, type: string, fields: Record<string, string>): Promise<{ document: Doc; created: boolean }> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([content], { type }), name);
    const response = await fetch(`${api.url}/api/v1/brain/documents`, { method: 'POST', body: form, headers: headers(auth) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} upload: ${text.slice(0, 300)}`);
    return JSON.parse(text) as { document: Doc; created: boolean };
  }
  type Doc = { id: string; title: string; version: number; containerId: string; data: Record<string, unknown>; text: string };
  const extractedOf = (doc: Doc) => doc.data.extracted as { status: string; method?: string; reason?: string } | undefined;
  const untilExtracted = (id: string): Promise<Doc> =>
    waitFor(async () => {
      await api.extraction?.runOnce();
      const { entity } = await json<{ entity: Doc }>(`/api/v1/brain/entities/${id}`);
      return extractedOf(entity)?.status && extractedOf(entity)?.status !== 'pending' ? entity : undefined;
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
    bob = await stack.login('bob');
    api = await stack.startBrainApi();
    const setup = await json<{ oauthClientId: string }>('/api/v1/brain/setup/mattermost', { method: 'POST' });
    aliceCookie = await signIn(alice, setup.oauthClientId);
    bobCookie = await signIn(bob, setup.oauthClientId);
    bridge = await stack.startBridge();
    ingestion = await stack.startIngestion({ INGEST_DEBOUNCE_SECONDS: '1' });
    const { container } = await json<{ container: { id: string } }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `Docs ${uniqueName('p')}`, channels: false }) }, { cookie: aliceCookie });
    projectId = container.id;
  }, 180_000);

  afterAll(async () => {
    await ingestion?.stop();
    await bridge?.stop();
    await stack?.archiveCreatedChannels();
    await api?.stop();
    await stack?.close();
  });

  it('an uploaded Markdown file is extracted, chunked and searchable within 5 s (FR-5.1, FR-5.2)', { timeout: 60_000 }, async () => {
    const word = uniqueName('lorry').replace(/-/g, '');
    const started = Date.now();
    const { document, created } = await upload({ cookie: aliceCookie }, 'scope.md', `# Scope\n\nThe ${word} fleet moves to the new warehouse in March.`, 'text/markdown', { attachTo: projectId, useAsContext: 'true' });
    expect(created).toBe(true);
    expect(document.data.name).toBe('scope.md');
    expect(document.data.useAsContext).toBe(true);
    const found = await waitFor(async () => {
      await api.extraction?.runOnce();
      const result = await json<{ results: { entityId: string; entityType: string }[] }>(`/api/v1/brain/search?q=${word}`, {}, { cookie: aliceCookie });
      return result.results.find((hit) => hit.entityId === document.id) ? result : undefined;
    }, 5000, 200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(found.results[0]?.entityType).toBe('document');
    const { text, extracted } = await json<{ text: string; extracted: { status: string; method: string } }>(`/api/v1/brain/documents/${document.id}/text`, {}, { cookie: aliceCookie });
    expect(text).toContain(word);
    expect(extracted).toMatchObject({ status: 'done', method: 'text' });
    const file = await fetch(`${api.url}/api/v1/brain/documents/${document.id}/file`, { headers: headers({ cookie: aliceCookie }) });
    expect(file.status).toBe(200);
    expect(await file.text()).toContain(word);
  });

  it("a PDF's text layer is read; a second upload with the same name is a new version, not a copy (FR-5.3)", { timeout: 60_000 }, async () => {
    const first = await upload({ cookie: aliceCookie }, 'plan.pdf', Buffer.from(PDF, 'latin1'), 'application/pdf', { attachTo: projectId });
    const extracted = await untilExtracted(first.document.id);
    expect(extractedOf(extracted)).toMatchObject({ status: 'done', method: 'text' });
    expect(extracted.text).toContain('The migration plan inside the pdf');
    const second = await upload({ cookie: aliceCookie }, 'plan.pdf', 'The plan, rewritten as text', 'text/plain', { attachTo: projectId });
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    const { versions } = await json<{ versions: { version: number }[] }>(`/api/v1/brain/entities/${first.document.id}/versions`, {}, { cookie: aliceCookie });
    expect(versions.length).toBeGreaterThanOrEqual(3);
    const latest = await untilExtracted(first.document.id);
    expect(latest.text).toContain('rewritten');
    expect(latest.data.fileId).not.toBe(first.document.data.fileId);
  });

  it('a confidential document is seen by its uploader and allowed people only, and every read is audited (FR-5.5)', { timeout: 60_000 }, async () => {
    const bobMe = await json<{ principal: { personId: string } }>('/api/v1/brain/me', {}, { cookie: bobCookie });
    await json(`/api/v1/brain/containers/${projectId}/members`, { method: 'POST', body: JSON.stringify({ personId: bobMe.principal.personId, role: 'reviewer' }) }, { cookie: aliceCookie });
    const { document } = await upload({ cookie: aliceCookie }, 'salaries.txt', 'Secret numbers 4711', 'text/plain', { attachTo: projectId, confidential: 'true' });
    await untilExtracted(document.id);
    // Bob is a member of the project, but the document is confidential: not his.
    expect(await status(`/api/v1/brain/documents/${document.id}/text`, { cookie: bobCookie })).toBe(404);
    expect(await status(`/api/v1/brain/entities/${document.id}`, { cookie: bobCookie })).toBe(404);
    // Allowed by name, he may read it, and the read is logged.
    await json(`/api/v1/brain/documents/${document.id}`, { method: 'PATCH', body: JSON.stringify({ allowedPersonIds: [bobMe.principal.personId] }) }, { cookie: aliceCookie });
    const { text } = await json<{ text: string }>(`/api/v1/brain/documents/${document.id}/text`, {}, { cookie: bobCookie });
    expect(text).toContain('4711');
    const { entries } = await json<{ entries: { action: string; actorId: string }[] }>(`/api/v1/brain/audit?entity=${document.id}`);
    expect(entries.some((entry) => entry.action === 'document.read' && entry.actorId === bob.user.id)).toBe(true);
  });

  it('a no-ai image is never sent to the OCR provider; a plain image is (D65)', { timeout: 60_000 }, async () => {
    const before = api.ocr.calls.length;
    const { document: kept } = await upload({ cookie: aliceCookie }, 'id-card.png', PNG, 'image/png', { attachTo: projectId, noAi: 'true' });
    const skipped = await untilExtracted(kept.id);
    expect(extractedOf(skipped)).toMatchObject({ status: 'skipped' });
    expect(extractedOf(skipped)?.reason).toContain('no-ai');
    expect(api.ocr.calls.length).toBe(before);
    const { document: scan } = await upload({ cookie: aliceCookie }, 'whiteboard.png', PNG, 'image/png', { attachTo: projectId });
    const read = await untilExtracted(scan.id);
    expect(extractedOf(read)).toMatchObject({ status: 'done', method: 'ocr' });
    expect(read.text).toBe('fake ocr text');
    expect(api.ocr.calls.length).toBe(before + 1);
  });

  it('a file posted in a captured channel becomes a document of the channel\'s container with the post as source (FR-5.6)', { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'docs-attach');
    await stack.enable(alice, channel.id);
    await json(`/api/v1/brain/containers/${projectId}/channels`, { method: 'POST', body: JSON.stringify({ mmChannelId: channel.id, role: 'linked' }) }, { cookie: aliceCookie });
    const word = uniqueName('manifest').replace(/-/g, '');
    const fileId = await stack.uploadFile(alice, channel.id, 'manifest.txt', `Shipping ${word} for the warehouse`);
    const post = await alice.api.post<{ id: string }>('/posts', { channel_id: channel.id, message: 'The manifest', file_ids: [fileId] });
    // Ingestion renders the thread with the file tag; the attachments job then fetches the file.
    const document = await waitFor(async () => {
      await api.jobs.runNow('chat-attachments');
      await api.extraction?.runOnce();
      const { documents } = await json<{ documents: Doc[] }>(`/api/v1/brain/documents?container=${projectId}`, {}, { cookie: aliceCookie });
      return documents.find((candidate) => candidate.data.name === 'manifest.txt');
    }, 90_000, 1000);
    expect(document.data.source_url).toContain(post.id);
    const extracted = await untilExtracted(document.id);
    expect(extracted.text).toContain(word);
    const found = await waitFor(async () => (await json<{ results: { entityId: string }[] }>(`/api/v1/brain/search?q=${word}`, {}, { cookie: aliceCookie })).results.find((hit) => hit.entityId === document.id), 10_000, 500);
    expect(found).toBeTruthy();
  });
});
