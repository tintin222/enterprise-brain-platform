// Document routes (FR-5; plan sections 6 and 15): multipart upload to a container or an entity, the extracted
// text, the file itself, flags, versions through the entity routes, and a re-extraction.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import type { DocumentService } from './documents.ts';
import { requirePrincipal, writeContext } from './auth.ts';
import { presentEntity, presentEntitySummary } from './present.ts';
import * as s from './schemas.ts';

const asBool = (value: unknown): boolean | undefined => (value === undefined ? undefined : value === 'true' || value === true || value === '1' || value === 'on');

export function registerDocumentRoutes(app: FastifyInstance, deps: BrainApiDeps, documents: DocumentService): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { store, access, config } = deps;
  const urls = { publicUrl: config.BRAIN_PUBLIC_URL.replace(/\/$/, '') };
  const off = (): void => {
    if (!config.BRAIN_FEATURE_DOCUMENTS) throw new AccessError(404, 'Documents are switched off on this installation');
  };
  const loadVisible = async (request: Parameters<typeof requirePrincipal>[0], id: string) => {
    const principal = requirePrincipal(request);
    const document = await store.getEntity(id);
    if (!document || document.type !== 'document' || !(await access.canSeeEntity(principal, document))) throw new AccessError(404, 'No such document');
    return { principal, document };
  };
  const mayWrite = async (principal: ReturnType<typeof requirePrincipal>, containerId: string): Promise<void> => {
    if (!access.canWrite(principal)) throw new AccessError(403, 'Agents cannot upload or change documents');
    if (principal.kind === 'person' && !principal.isAdmin && !(await access.membership(principal.userId)).containerIds.includes(containerId)) throw new AccessError(403, 'Only members of the container can add documents to it');
  };

  api.post('/documents', { schema: { tags: ['Documents'], summary: 'Upload a file to a container or an entity (multipart: file, attachTo, useAsContext, confidential, noAi, artifact, title, description)', consumes: ['multipart/form-data'], response: { 201: z.object({ document: s.entityOut, created: z.boolean() }) } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    off();
    const part = await request.file({ limits: { fileSize: config.BRAIN_FILE_MAX_MB * 1024 * 1024 } });
    if (!part) throw new AccessError(400, 'Send the file as the multipart field "file"');
    const bytes = await part.toBuffer();
    if (part.file.truncated) throw new AccessError(413, `The file is larger than the installation's limit (${config.BRAIN_FILE_MAX_MB} MB)`);
    const field = (name: string): string | undefined => {
      const value = part.fields[name];
      const single = Array.isArray(value) ? value[0] : value;
      return single && 'value' in single && typeof single.value === 'string' ? single.value : undefined;
    };
    const attachTo = field('attachTo');
    if (!attachTo) throw new AccessError(400, 'attachTo (a container or entity id) is required');
    const { container } = await documents.target(attachTo);
    await mayWrite(principal, container.id);
    const allowed = field('allowedPersonIds');
    const { document, created } = await documents.upload(
      {
        bytes,
        name: part.filename,
        mediaType: part.mimetype,
        attachTo,
        title: field('title'),
        description: field('description'),
        useAsContext: asBool(field('useAsContext')),
        confidential: asBool(field('confidential')),
        noAi: asBool(field('noAi')),
        artifact: field('artifact'),
        allowedPersonIds: allowed ? allowed.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
        source: { kind: 'upload' },
      },
      principal,
      writeContext(request, principal, 'upload'),
    );
    return reply.code(201).send({ document: presentEntity(document, urls), created });
  });

  api.get('/documents', { schema: { tags: ['Documents'], summary: 'Documents the caller may see, newest first', querystring: z.object({ container: s.id.optional(), attachedTo: s.id.optional(), ...s.paging }), response: { 200: z.object({ documents: z.array(s.entitySummaryOut) }) } } }, async (request) => {
    const principal = requirePrincipal(request);
    off();
    const entities = await store.listEntities({ type: 'document', containerId: request.query.container, limit: request.query.limit, offset: request.query.offset });
    const visible = [];
    for (const entity of entities) {
      if (request.query.attachedTo && entity.data.attachedTo !== request.query.attachedTo) continue;
      if (await access.canSeeEntity(principal, entity)) visible.push(presentEntitySummary(entity, urls));
    }
    return { documents: visible };
  });

  api.get('/documents/:id/text', { schema: { tags: ['Documents'], summary: "A document's extracted text (confidential reads are audited)", params: z.object({ id: s.id }), response: { 200: z.object({ text: z.string(), extracted: z.record(z.string(), z.unknown()) }) } } }, async (request) => {
    const { principal, document } = await loadVisible(request, request.params.id);
    off();
    return { text: await documents.readText(document, principal, writeContext(request, principal)), extracted: (document.data.extracted as Record<string, unknown> | undefined) ?? {} };
  });

  api.get('/documents/:id/file', { schema: { tags: ['Documents'], summary: 'Download the file (audited)', params: z.object({ id: s.id }) } }, async (request, reply) => {
    const { principal, document } = await loadVisible(request, request.params.id);
    off();
    const file = await documents.readFile(document, principal, writeContext(request, principal));
    return reply
      .type(file.mediaType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header('Content-Length', String(file.bytes.byteLength))
      .send(file.bytes);
  });

  api.patch('/documents/:id', { schema: { tags: ['Documents'], summary: 'Change the flags: use as context, confidential, no-ai, allowed people, artifact kind (FR-5.4, FR-5.5)', params: z.object({ id: s.id }), body: s.documentFlagsIn, response: { 200: z.object({ document: s.entityOut }) } } }, async (request) => {
    const { principal, document } = await loadVisible(request, request.params.id);
    off();
    await mayWrite(principal, document.containerId);
    return { document: presentEntity(await documents.setFlags(document, request.body, writeContext(request, principal)), urls) };
  });

  api.post('/documents/:id/extract', { schema: { tags: ['Documents'], summary: 'Extract the text again now', params: z.object({ id: s.id }), response: { 200: z.object({ extracted: z.record(z.string(), z.unknown()) }) } } }, async (request) => {
    const { principal, document } = await loadVisible(request, request.params.id);
    off();
    await mayWrite(principal, document.containerId);
    return { extracted: (await documents.extract(document)) as unknown as Record<string, unknown> };
  });
}
