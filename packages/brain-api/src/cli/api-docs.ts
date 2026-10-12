// pnpm brain:api-docs [--check]: render docs/brain/API.md from the routes' OpenAPI document (spec section 12).
// Builds the app without touching any service: handlers are never called.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrainStore } from '@brain/brain';
import { createPool, KeyStore, silentLogger, signerFromHex } from '@brain/shared';
import { AccessService } from '../access.ts';
import { buildApp } from '../app.ts';
import { brainApiConfigSchema } from '../config.ts';
import { TokenSigner } from '../sessions.ts';

const ZERO_KEY = '0'.repeat(64);
const config = brainApiConfigSchema.parse({
  STATE_DATABASE_URL: 'postgres://docs:docs@localhost:1/docs',
  KEY_ENCRYPTION_KEY: ZERO_KEY,
  RELAY_HTTP_URL: 'http://localhost:3000',
  RELAY_WS_URL: 'ws://localhost:3000',
  READER_SECRET_KEY: ZERO_KEY,
  MM_URL: 'http://localhost:8065',
  MM_BRIDGE_TOKEN: 'docs',
  MM_ADMIN_TOKEN: 'docs',
  MM_TEAM_NAME: 'docs',
  BRIDGE_SECRET_KEY: ZERO_KEY,
  BRAIN_API_TOKEN: 'docs-'.repeat(8),
  BRAIN_SESSION_SECRET: ZERO_KEY,
  BRAIN_PUBLIC_URL: 'https://brain.example.com',
  BRAIN_WEB_DIR: '',
});

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; schema?: { type?: string; enum?: string[] } }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  nullable?: boolean;
}

function typeOf(schema: JsonSchema | undefined): string {
  if (!schema) return '';
  if (schema.enum) return schema.enum.map((value) => `\`${String(value)}\``).join(' \\| ');
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map(typeOf).filter(Boolean).join(' \\| ');
  const type = Array.isArray(schema.type) ? schema.type.join(' \\| ') : (schema.type ?? 'object');
  if (type === 'array') return `array of ${typeOf(schema.items) || 'items'}`;
  return type;
}

function fields(schema: JsonSchema | undefined, depth = 0): string[] {
  if (!schema?.properties || depth > 1) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    const line = `| \`${name}\` | ${typeOf(property)} | ${required.has(name) ? 'yes' : 'no'} |`;
    return [line];
  });
}

function render(spec: { info: { title: string; version: string; description?: string }; paths: Record<string, Record<string, Operation>>; tags?: { name: string; description?: string }[] }): string {
  const out: string[] = [];
  out.push(`# ${spec.info.title}`, '', `Generated from the routes by \`pnpm brain:api-docs\`; do not edit by hand. Version ${spec.info.version}.`, '', spec.info.description ?? '', '');
  out.push('Errors are `{ "error": "<message>", "code": "<code>" }`; validation errors add `issues`.', '');
  const byTag = new Map<string, { method: string; path: string; op: Operation }[]>();
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags?.[0] ?? 'Other';
      const list = byTag.get(tag) ?? [];
      list.push({ method: method.toUpperCase(), path: route, op });
      byTag.set(tag, list);
    }
  }
  const tags = [...(spec.tags ?? []).map((tag) => tag.name), ...byTag.keys()].filter((tag, index, all) => all.indexOf(tag) === index && byTag.has(tag));
  out.push('## Contents', '');
  for (const tag of tags) out.push(`- [${tag}](#${tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`);
  out.push('');
  for (const tag of tags) {
    const description = spec.tags?.find((candidate) => candidate.name === tag)?.description;
    out.push(`## ${tag}`, '');
    if (description) out.push(description, '');
    for (const { method, path: route, op } of byTag.get(tag) ?? []) {
      out.push(`### \`${method} ${route}\``, '');
      if (op.summary) out.push(op.summary, '');
      if (op.description) out.push(op.description, '');
      const params = op.parameters ?? [];
      if (params.length > 0) {
        out.push('| Parameter | In | Type | Required |', '| --- | --- | --- | --- |');
        for (const param of params) out.push(`| \`${param.name}\` | ${param.in} | ${typeOf(param.schema)} | ${param.required ? 'yes' : 'no'} |`);
        out.push('');
      }
      const body = op.requestBody?.content?.['application/json']?.schema ?? op.requestBody?.content?.['application/x-www-form-urlencoded']?.schema;
      const bodyFields = fields(body);
      if (bodyFields.length > 0) {
        out.push('Body:', '', '| Field | Type | Required |', '| --- | --- | --- |', ...bodyFields, '');
      }
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        const schema = response.content?.['application/json']?.schema;
        const responseFields = fields(schema);
        if (responseFields.length > 0) out.push(`Response ${status}:`, '', '| Field | Type | Required |', '| --- | --- | --- |', ...responseFields, '');
        else out.push(`Response ${status}${response.description ? `: ${response.description}` : ''}`, '');
      }
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const pool = createPool(config.STATE_DATABASE_URL);
const store = new BrainStore(pool);
const chat = { getMe: () => Promise.reject(new Error('docs')) } as never;
const app = await buildApp({
  config,
  pool,
  store,
  embeddings: undefined,
  chat,
  adminChat: chat,
  people: {} as never,
  files: {} as never,
  jobs: {} as never,
  relay: {} as never,
  keyStore: new KeyStore(pool, ZERO_KEY),
  bridgeSigner: signerFromHex('1'.repeat(64)),
  access: new AccessService(chat, store),
  tokens: new TokenSigner(ZERO_KEY),
  botUserId: 'docs',
  teamName: 'docs',
  log: silentLogger(),
});
await app.ready();
const markdown = render(app.swagger() as Parameters<typeof render>[0]);
await app.close();
await pool.end();

const target = path.resolve(import.meta.dirname, '../../../../docs/brain/API.md');
if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== markdown) {
    console.error(`${target} is out of date: run pnpm brain:api-docs`);
    process.exit(1);
  }
  console.log(`${target} is current.`);
} else {
  writeFileSync(target, markdown);
  console.log(`Wrote ${target}`);
}
