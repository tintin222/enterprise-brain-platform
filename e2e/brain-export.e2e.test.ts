// The open export (NFR-9; docs/brain/export-format.md): tables, files and manifest written to a directory, the
// API's file routes, and the round trip into a temporary database that reproduces counts, versions and hashes.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportToDirectory, verifyRoundTrip } from '@brain/brain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, uniqueName, type BrainApiHandle } from './lib/harness.ts';

describe('export', () => {
  let stack: Stack;
  let api: BrainApiHandle;
  let dir = '';

  const headers = { Authorization: '', 'X-Requested-With': 'XMLHttpRequest' };
  const json = async <T = unknown>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${api.url}${path}`, { ...init, headers: { ...headers, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };

  beforeAll(async () => {
    stack = new Stack();
    api = await stack.startBrainApi();
    headers.Authorization = `Bearer ${api.token}`;
    dir = await mkdtemp(path.join(os.tmpdir(), 'brain-export-'));
  }, 180_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await api?.stop();
    await stack?.close();
  });

  it('writes every table and the files, and the round trip reproduces the store (NFR-9)', { timeout: 300_000 }, async () => {
    const word = uniqueName('export').replace(/-/g, '');
    const { container } = await json<{ container: { id: string } }>('/api/v1/brain/projects', { method: 'POST', body: JSON.stringify({ title: `Export ${word}`, channels: false }) });
    await json('/api/v1/brain/entities', { method: 'POST', body: JSON.stringify({ type: 'decision', title: `Decision ${word}`, containerId: container.id, text: `${word} is exported.` }) });
    const form = new FormData();
    form.append('attachTo', container.id);
    form.append('file', new Blob([`# Notes\n\n${word}`], { type: 'text/markdown' }), 'notes.md');
    const uploaded = await fetch(`${api.url}/api/v1/brain/documents`, { method: 'POST', body: form, headers });
    expect(uploaded.status).toBe(201);
    const { document } = (await uploaded.json()) as { document: { id: string; data: { fileId: string; sha256: string } } };

    const manifest = await exportToDirectory(api.store, dir);
    expect(manifest.format).toBe('jsonl/2');
    expect(manifest.tables.entities).toBeGreaterThan(0);
    expect(manifest.files.count).toBeGreaterThan(0);
    const entities = (await readFile(path.join(dir, 'entities.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(entities.some((line) => line.includes(`Decision ${word}`))).toBe(true);
    expect((await readFile(path.join(dir, 'files', document.data.fileId), 'utf8'))).toContain(word);

    const report = await verifyRoundTrip(api.config.STATE_DATABASE_URL, dir);
    expect(report.entityMismatches).toEqual([]);
    expect(report.files.hashMismatches).toEqual([]);
    expect(report.tables.entities).toEqual({ expected: manifest.tables.entities, imported: manifest.tables.entities });
    expect(report.ok).toBe(true);

    // The same through the API: the manifest counts the uploads, and a file comes back byte for byte.
    const apiManifest = await json<{ format: string; uploads: { count: number }; files: string[] }>('/api/v1/brain/export/manifest');
    expect(apiManifest.format).toBe('jsonl/2');
    expect(apiManifest.uploads.count).toBe(manifest.files.count);
    expect(apiManifest.files).toContain('files.jsonl');
    const file = await fetch(`${api.url}/api/v1/brain/export/files/${document.data.fileId}`, { headers });
    expect(file.status).toBe(200);
    expect(await file.text()).toContain(word);
    const meta = await (await fetch(`${api.url}/api/v1/brain/export/files.jsonl`, { headers })).text();
    expect(meta).toContain(document.data.sha256);
  });
});
