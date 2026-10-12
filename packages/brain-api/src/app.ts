// The brain API server (docs/brain/01-phase0-plan.md section 8): Fastify with zod schemas (they also produce
// docs/brain/API.md), Mattermost sign-in, the REST routes under /api/v1/brain, Mattermost's command, dialog
// and button callbacks under /mm, the operations endpoints, and the built pages.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrainStoreError, type BrainStore, type FileStore } from '@brain/brain';
import type { EmbeddingProvider, OcrProvider } from '@brain/models';
import { errorFields, metricsRegistry, type ChatClient, type KeyStore, type Logger, type Pool, type RelayClient, type Signer } from '@brain/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { AccessError, type AccessService } from './access.ts';
import { registerAuth, requireAdmin } from './auth.ts';
import { ChannelLinker } from './channels.ts';
import type { BrainApiConfig } from './config.ts';
import { DocumentService } from './documents.ts';
import type { JobRunner } from './jobs.ts';
import type { PeopleService } from './people.ts';
import { registerBrainRoutes } from './routes-brain.ts';
import { registerMattermostRoutes } from './routes-mm.ts';
import { registerDocumentRoutes } from './routes-documents.ts';
import { registerPeopleRoutes } from './routes-people.ts';
import { registerSystemRoutes } from './routes-systems.ts';
import { registerTaskRoutes } from './routes-tasks.ts';
import { SystemService } from './systems.ts';
import { TaskService } from './tasks.ts';
import { registerWorkspaceRoutes } from './routes-workspaces.ts';
import { WorkspaceService } from './workspaces.ts';
import type { TokenSigner } from './sessions.ts';

export interface BrainApiDeps {
  config: BrainApiConfig;
  pool: Pool;
  store: BrainStore;
  /** Undefined keeps search keyword-only (D53). */
  embeddings: EmbeddingProvider | undefined;
  /** Reads scans and images (D65); undefined leaves such files searchable by name only. */
  ocr?: OcrProvider | undefined;
  /** As the @brain bot. */
  chat: ChatClient;
  /** As an admin user (D25): agents, OAuth apps, commands, settings. */
  adminChat: ChatClient;
  relay: RelayClient;
  keyStore: KeyStore;
  bridgeSigner: Signer;
  access: AccessService;
  tokens: TokenSigner;
  /** Phase 1: people, uploaded files and the recurring jobs. */
  people: PeopleService;
  files: FileStore;
  jobs: JobRunner;
  /** Set by buildApp: the Project and Topic service and the document service, for the jobs and workers started after the app is built. */
  workspaces?: WorkspaceService;
  documents?: DocumentService;
  tasks?: TaskService;
  botUserId: string;
  teamName: string;
  log: Logger;
  /** Extra readiness checks (the embedding worker, for example). */
  readiness?: Record<string, () => Promise<boolean> | boolean>;
}

export const API_PREFIX = '/api/v1/brain';

export async function buildApp(deps: BrainApiDeps): Promise<FastifyInstance> {
  const { config, log, pool } = deps;
  const app = Fastify({ logger: false, trustProxy: true, genReqId: () => randomUUID(), bodyLimit: 1_048_576 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // A POST without a body but with a JSON content type (curl -X POST, many HTTP clients) is not an error here:
  // the route's schema decides whether a body is required. Fastify's own secure parser handles the rest.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') done(null, undefined);
    else void parseJson(request, body as string, done);
  });
  // Mattermost posts slash commands as forms (spike B1).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.BRAIN_FILE_MAX_MB * 1024 * 1024, files: 1, fields: 20 } });
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Enterprise Brain API', version: '0.1.0', description: 'The Company Brain (docs/COMPANY_BRAIN_SPEC.md). Sign in with a Mattermost account (cookie) or send `Authorization: Bearer <BRAIN_API_TOKEN>`.' },
      servers: [{ url: config.BRAIN_PUBLIC_URL }],
      tags: [
        { name: 'Session', description: 'Who is calling and which features are on' },
        { name: 'Containers', description: 'Projects, Topics and General (spec section 3)' },
        { name: 'Entities', description: 'Entities, versions and links' },
        { name: 'Search', description: 'Hybrid search (FR-9.1, FR-9.2)' },
        { name: 'Audit', description: 'The append-only audit log' },
        { name: 'Export', description: 'Full export in an open format (NFR-9)' },
        { name: 'Agents', description: 'Agents and channels (the former admin API, D43)' },
        { name: 'Setup', description: 'Mattermost integration setup' },
        { name: 'Mattermost', description: 'Callbacks Mattermost makes for slash commands, dialogs and buttons' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // One log line per request, without the query string (search text stays out of logs).
  app.addHook('onResponse', async (request, reply) => {
    const pathOnly = request.url.split('?')[0] ?? request.url;
    if (pathOnly === '/healthz' || pathOnly === '/readyz' || pathOnly === '/metrics') return;
    log.info({ method: request.method, path: pathOnly, status: reply.statusCode, ms: Math.round(reply.elapsedTime), requestId: request.id, actor: request.principal?.userId }, 'request');
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AccessError) return reply.code(error.status).send({ error: error.message, code: error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : error.status === 404 ? 'not_found' : 'refused' });
    if (error instanceof BrainStoreError) return reply.code(error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400).send({ error: error.message, code: error.code });
    if (hasZodFastifySchemaValidationErrors(error)) return reply.code(400).send({ error: 'Invalid request', code: 'validation', issues: error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message })) });
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) log.error({ requestId: request.id, path: request.url.split('?')[0], ...errorFields(error) }, 'Request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : error instanceof Error ? error.message : String(error), code: status >= 500 ? 'internal' : 'refused' });
  });

  registerAuth(app, deps);
  const linker = new ChannelLinker({ store: deps.store, chat: deps.chat, access: deps.access, botUserId: deps.botUserId, publicUrl: config.BRAIN_PUBLIC_URL, log });
  const workspaces = new WorkspaceService({ store: deps.store, chat: deps.chat, adminChat: deps.adminChat, access: deps.access, people: deps.people, linker, botUserId: deps.botUserId, teamName: deps.teamName, publicUrl: config.BRAIN_PUBLIC_URL, staleDays: config.BRAIN_STALE_DAYS, log });
  deps.workspaces = workspaces;
  const documents = new DocumentService({ store: deps.store, files: deps.files, chat: deps.chat, log, ocr: deps.ocr, ocrEnabled: config.BRAIN_FEATURE_OCR_MODEL, maxBytes: config.BRAIN_FILE_MAX_MB * 1024 * 1024, publicUrl: config.BRAIN_PUBLIC_URL, botUserId: deps.botUserId });
  deps.documents = documents;
  const tasks = new TaskService({ store: deps.store, chat: deps.chat, people: deps.people, tokens: deps.tokens, log, botUserId: deps.botUserId, publicUrl: config.BRAIN_PUBLIC_URL, internalUrl: config.BRAIN_INTERNAL_URL, timeZone: config.BRAIN_TIMEZONE });
  deps.tasks = tasks;
  await app.register((api, _options, done) => {
    registerBrainRoutes(api, deps, linker);
    registerPeopleRoutes(api, deps);
    registerWorkspaceRoutes(api, deps, workspaces);
    registerDocumentRoutes(api, deps, documents);
    registerSystemRoutes(api, deps, new SystemService(deps.store));
    registerTaskRoutes(api, deps, tasks);
    done();
  }, { prefix: API_PREFIX });
  registerMattermostRoutes(app, deps, linker, workspaces, tasks);

  // Operations endpoints, as the other services have them (docs/operations.md section 1).
  app.get('/healthz', { schema: { hide: true } }, () => ({ ok: true }));
  app.get('/readyz', { schema: { hide: true } }, async (_request, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      checks.database = (await pool.query('SELECT 1')).rowCount === 1;
    } catch {
      checks.database = false;
    }
    for (const [name, check] of Object.entries(deps.readiness ?? {})) checks[name] = await Promise.resolve(check()).catch(() => false);
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });
  // Metrics hold counts and timings only, but this port is public (pages, sign-in), so a scraper needs the
  // service token or an administrator's session; the other services keep theirs on a private port.
  app.get('/metrics', { schema: { hide: true } }, async (request, reply) => {
    requireAdmin(request);
    const text = await metricsRegistry.metrics();
    return reply.type(metricsRegistry.contentType).send(text);
  });
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  // The pages: a built brain-web, with every unknown GET falling back to its index (client-side routes).
  const webDir = config.BRAIN_WEB_DIR ? path.resolve(config.BRAIN_WEB_DIR) : '';
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0] ?? '';
      if (request.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/mm/') && !pathname.startsWith('/auth/')) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found', code: 'not_found' }));
  }
  return app;
}
