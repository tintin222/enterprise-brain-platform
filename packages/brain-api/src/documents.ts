// Documents (FR-5; plan section 6): uploads into the file store, versions by name, flags, logged access to
// confidential files, the extraction worker that fills the text (chunked and embedded like any entity), and the
// job that turns chat attachments into documents through the same pipeline (FR-5.6).
import path from 'node:path';
import { GENERAL_CONTAINER_ID, type BrainStore, type Container, type Entity, type FileStore, type Visibility, type WriteContext } from '@brain/brain';
import type { OcrProvider } from '@brain/models';
import { counter, errorFields, gaugeFrom, type ChatClient, type Logger } from '@brain/shared';
import { AccessError, type Principal } from './access.ts';
import { extractText, type Extraction } from './extract.ts';
import { parseDdl } from './parsers/ddl.ts';
import { describeApi, describeDdl, parseOpenApi } from './parsers/openapi.ts';

const extracted = counter('brain_documents_extracted_total', 'Documents extracted, by outcome', ['outcome']);
const attachments = counter('brain_documents_attachments_total', 'Chat attachments turned into documents, by outcome', ['outcome']);

export interface DocumentFlags {
  useAsContext?: boolean;
  confidential?: boolean;
  noAi?: boolean;
  allowedPersonIds?: string[];
  /** For a System's artifacts (FR-3.2, FR-3.3): what the file is. */
  artifact?: string;
}

export interface UploadInput extends DocumentFlags {
  bytes: Uint8Array;
  name: string;
  mediaType: string;
  /** A container id, or an entity id (the document is attached to it and lives in its container). */
  attachTo: string;
  title?: string;
  description?: string;
  visibility?: Visibility;
  /** For chat attachments: the post's permalink and id. */
  source?: { kind: 'upload' | 'chat' | 'mail'; ref?: string; url?: string };
  externalKey?: string;
}

export interface ExtractionState {
  status: 'pending' | 'done' | 'failed' | 'skipped';
  method?: Extraction['method'];
  chars?: number;
  pages?: number;
  sheets?: number;
  slides?: number;
  entries?: number;
  reason?: string;
  at?: string;
}

export interface DocumentDeps {
  store: BrainStore;
  files: FileStore;
  chat: ChatClient;
  log: Logger;
  ocr: OcrProvider | undefined;
  ocrEnabled: boolean;
  maxBytes: number;
  publicUrl: string;
  botUserId: string;
}

const SYSTEM_CTX = (id: string): WriteContext => ({ actor: { kind: 'system', id }, source: { kind: 'system' } });
const SETTING_ATTACHMENT_CURSOR = 'documents.attachments.cursor';

export const fileKey = (fileId: string): string => `mmfile:${fileId}`;

export class DocumentService {
  readonly #deps: DocumentDeps;

  constructor(deps: DocumentDeps) {
    this.#deps = deps;
    gaugeFrom('brain_documents_pending', 'Documents waiting for text extraction', () => this.pendingCount());
  }

  /** Where a document goes: the container itself, or the entity it is attached to and that entity's container. */
  async target(attachTo: string): Promise<{ container: Container; entity: Entity | undefined }> {
    const { store } = this.#deps;
    const container = await store.getContainer(attachTo);
    if (container) return { container, entity: undefined };
    const entity = await store.getEntity(attachTo);
    if (!entity) throw new AccessError(404, 'No such container or entity to attach to');
    const owner = await store.getContainer(entity.containerId);
    if (!owner) throw new AccessError(404, 'The entity has no container');
    return { container: owner, entity };
  }

  /** The same file name on the same target makes a new version, not a copy (FR-5.3). */
  async #existing(name: string, container: Container, entity: Entity | undefined): Promise<Entity | undefined> {
    const { store } = this.#deps;
    const candidates = await store.listEntities({ containerId: container.id, type: 'document', includeArchived: false, limit: 500 });
    return candidates.find((candidate) => candidate.data.name === name && (candidate.data.attachedTo ?? null) === (entity?.id ?? null));
  }

  async upload(input: UploadInput, principal: Principal, ctx: WriteContext): Promise<{ document: Entity; created: boolean }> {
    const { store, files, maxBytes } = this.#deps;
    if (input.bytes.byteLength === 0) throw new AccessError(400, 'The file is empty');
    if (input.bytes.byteLength > maxBytes) throw new AccessError(413, `The file is larger than the installation's limit (${Math.round(maxBytes / 1024 / 1024)} MB)`);
    const name = path.basename(input.name).trim() || 'file';
    const { container, entity: parent } = await this.target(input.attachTo);
    const stored = await files.put(input.bytes, input.mediaType || 'application/octet-stream', ctx.actor.id);
    const flags = { useAsContext: input.useAsContext ?? false, confidential: input.confidential ?? false, noAi: input.noAi ?? false, allowedPersonIds: input.allowedPersonIds ?? [], ...(input.artifact ? { artifact: input.artifact } : {}) };
    const data: Record<string, unknown> = {
      name,
      fileId: stored.file.id,
      sha256: stored.file.sha256,
      mediaType: stored.file.mediaType,
      size: stored.file.size,
      ...(parent ? { attachedTo: parent.id, attachedType: parent.type } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.source?.url ? { source_url: input.source.url } : {}),
      ...flags,
      extracted: { status: 'pending' } satisfies ExtractionState,
    };
    const visibility = input.visibility ?? (parent?.visibility ?? (container.id === GENERAL_CONTAINER_ID ? 'public' : 'container'));
    const existing = input.externalKey ? await store.getEntityByExternalKey(input.externalKey) : await this.#existing(name, container, parent);
    const title = input.title ?? name;
    let document: Entity;
    let created = false;
    if (existing) {
      document = await store.updateEntity(existing.id, { title, data, text: '', visibility }, ctx);
    } else {
      document = await store.createEntity({ type: 'document', title, containerId: container.id, visibility, ...(input.externalKey ? { externalKey: input.externalKey } : {}), data, text: '' }, ctx);
      created = true;
      if (parent) await store.createLink({ fromId: document.id, toId: parent.id, kind: 'attached_to' }, ctx).catch(() => undefined);
    }
    void principal;
    return { document, created };
  }

  async setFlags(document: Entity, flags: DocumentFlags, ctx: WriteContext): Promise<Entity> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flags)) if (value !== undefined) data[key] = value;
    const updated = await this.#deps.store.updateEntity(document.id, { data }, ctx);
    // A document that may now be read by the model, or no longer may, is extracted again.
    const wasSkipped = (document.data.extracted as ExtractionState | undefined)?.status === 'skipped';
    if (wasSkipped && (flags.noAi === false || flags.confidential === false)) return this.#deps.store.updateEntity(updated.id, { data: { extracted: { status: 'pending' } } }, ctx);
    return updated;
  }

  // --- reading (FR-5.5: confidential reads are audited) ---

  async readText(document: Entity, principal: Principal, ctx: WriteContext): Promise<string> {
    if (document.data.confidential === true) await this.#deps.store.audit({ action: 'document.read', entityId: document.id, containerId: document.containerId, details: { what: 'text', confidential: true } }, ctx);
    void principal;
    return document.text;
  }

  async readFile(document: Entity, principal: Principal, ctx: WriteContext): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
    const fileId = typeof document.data.fileId === 'string' ? document.data.fileId : '';
    const file = await this.#deps.files.get(fileId);
    if (!file) throw new AccessError(404, 'The file is missing');
    await this.#deps.store.audit({ action: 'document.download', entityId: document.id, containerId: document.containerId, details: { confidential: document.data.confidential === true, size: file.size } }, ctx);
    void principal;
    return { bytes: file.bytes, mediaType: file.mediaType, name: typeof document.data.name === 'string' ? document.data.name : 'file' };
  }

  // --- extraction (FR-5.2) ---

  async pendingCount(): Promise<number> {
    const r = await this.#deps.store.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM brain.entities WHERE type = 'document' AND archived_at IS NULL AND data->'extracted'->>'status' = 'pending'");
    return r.rows[0]?.n ?? 0;
  }

  async pending(limit: number): Promise<Entity[]> {
    const r = await this.#deps.store.pool.query<{ id: string }>("SELECT id FROM brain.entities WHERE type = 'document' AND archived_at IS NULL AND data->'extracted'->>'status' = 'pending' ORDER BY updated_at LIMIT $1", [limit]);
    const out: Entity[] = [];
    for (const row of r.rows) {
      const entity = await this.#deps.store.getEntity(row.id);
      if (entity) out.push(entity);
    }
    return out;
  }

  /** Extract one document's text now; the result lands on the entity (a new version, chunked and embedded). */
  async extract(document: Entity): Promise<ExtractionState> {
    const { store, files, ocr, ocrEnabled, log } = this.#deps;
    const ctx = SYSTEM_CTX('extraction');
    const fileId = typeof document.data.fileId === 'string' ? document.data.fileId : '';
    const name = typeof document.data.name === 'string' ? document.data.name : 'file';
    const file = await files.get(fileId);
    const finish = async (state: ExtractionState, text?: string): Promise<ExtractionState> => {
      await store.updateEntity(document.id, { data: { extracted: { ...state, at: new Date().toISOString() } }, ...(text !== undefined ? { text } : {}) }, ctx);
      extracted.inc({ outcome: state.status });
      return state;
    };
    if (!file) return finish({ status: 'failed', reason: 'the file is missing' });
    // Model OCR only when the installation allows it and the document is neither confidential nor no-ai (D65).
    const modelAllowed = ocrEnabled && ocr !== undefined && document.data.confidential !== true && document.data.noAi !== true;
    const ocrUnavailable = !ocrEnabled ? 'reading scans with the model is switched off on this installation' : ocr === undefined ? 'no model provider is configured for reading scans' : document.data.confidential === true ? 'confidential documents are never sent to a model' : 'this document is marked no-ai, so it is not sent to a model';
    try {
      const result = await extractText(file.bytes, file.mediaType, name, { ocr: modelAllowed ? ocr : undefined, ocrUnavailable });
      // A System's artifact gets its structure read and described, so endpoints and tables are searchable (FR-3.2, FR-3.3).
      const structure = structureOf(document, result.text);
      if (structure) result.text = `${result.text}\n\n${structure.description}`;
      const state: ExtractionState = {
        status: result.method === 'none' ? 'skipped' : 'done',
        method: result.method,
        chars: result.text.length,
        ...(result.pages !== undefined ? { pages: result.pages } : {}),
        ...(result.sheets !== undefined ? { sheets: result.sheets } : {}),
        ...(result.slides !== undefined ? { slides: result.slides } : {}),
        ...(result.entries !== undefined ? { entries: result.entries } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
      if (structure) await store.updateEntity(document.id, { data: { structure: structure.structure } }, ctx);
      return finish(state, result.text);
    } catch (error) {
      log.warn({ documentId: document.id, ...errorFields(error) }, 'Extraction failed');
      return finish({ status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** One worker round: extract what is pending, up to `limit` documents; how many were handled. */
  async extractPending(limit: number): Promise<number> {
    const documents = await this.pending(limit);
    for (const document of documents) await this.extract(document);
    return documents.length;
  }

  // --- chat attachments (FR-5.6) ---

  /**
   * Conversations whose chunks list attachments (the bridge's `mm_file` tags) become documents of the conversation's
   * container, fetched with the bot's token, with the post as source. A cursor in the settings keeps the scan short.
   */
  async ingestChatAttachments(limit = 200): Promise<{ scanned: number; created: number; skipped: number; failed: number }> {
    const { store, chat, log, publicUrl } = this.#deps;
    const cursor = (await store.getSetting<string>(SETTING_ATTACHMENT_CURSOR)) ?? '1970-01-01T00:00:00Z';
    const r = await store.pool.query<{ entity_id: string; metadata: Record<string, unknown>; updated_at: Date }>(
      "SELECT entity_id, metadata, updated_at FROM brain.chunks WHERE entity_type = 'conversation' AND metadata ? 'files' AND updated_at > $1 ORDER BY updated_at LIMIT $2",
      [cursor, limit],
    );
    const result = { scanned: r.rows.length, created: 0, skipped: 0, failed: 0 };
    let last = cursor;
    for (const row of r.rows) {
      last = row.updated_at.toISOString();
      const conversation = await store.getEntity(row.entity_id);
      if (!conversation) continue;
      const files = Array.isArray(row.metadata.files) ? (row.metadata.files as { id: string; name: string; mediaType: string; size: number; postId?: string }[]) : [];
      const anchors = Array.isArray(row.metadata.anchors) ? (row.metadata.anchors as { postId?: string; url?: string }[]) : [];
      for (const file of files) {
        if (await store.getEntityByExternalKey(fileKey(file.id))) {
          result.skipped++;
          continue;
        }
        if (file.size > this.#deps.maxBytes) {
          result.skipped++;
          continue;
        }
        try {
          const fetched = await chat.getFile(file.id);
          const url = anchors.find((anchor) => anchor.postId === file.postId)?.url;
          const principal: Principal = { kind: 'service', userId: 'service' };
          await this.upload(
            {
              bytes: fetched.bytes,
              name: file.name,
              mediaType: file.mediaType || fetched.contentType || 'application/octet-stream',
              attachTo: conversation.id,
              visibility: conversation.visibility,
              externalKey: fileKey(file.id),
              source: { kind: 'chat', ref: file.postId, url },
            },
            principal,
            { actor: { kind: 'system', id: 'chat-attachments' }, source: { kind: 'chat', ref: file.postId } },
          );
          attachments.inc({ outcome: 'created' });
          result.created++;
        } catch (error) {
          attachments.inc({ outcome: 'failed' });
          result.failed++;
          log.warn({ fileId: file.id, conversationId: conversation.id, ...errorFields(error) }, 'Could not ingest a chat attachment');
        }
      }
    }
    if (r.rows.length > 0) await store.setSetting(SETTING_ATTACHMENT_CURSOR, last);
    void publicUrl;
    return result;
  }
}

/** The structure of a technical artifact, when the document is one and the text can be read as such. */
function structureOf(document: Entity, text: string): { structure: Record<string, unknown>; description: string } | undefined {
  if (!text.trim()) return undefined;
  if (document.data.artifact === 'ddl') {
    const structure = parseDdl(text);
    return structure.tables.length > 0 ? { structure: structure as unknown as Record<string, unknown>, description: describeDdl(structure) } : undefined;
  }
  if (document.data.artifact === 'openapi') {
    const api = parseOpenApi(text);
    return api ? { structure: api as unknown as Record<string, unknown>, description: describeApi(api) } : undefined;
  }
  return undefined;
}

export interface ExtractionWorker {
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

/** Extracts pending documents every `intervalMs`, `concurrency` at a time; `runOnce` for tests. */
export function startExtractionWorker(options: { documents: DocumentService; log: Logger; intervalMs: number; concurrency: number }): ExtractionWorker {
  const { documents, log } = options;
  let running: Promise<number> | undefined;
  let stopped = false;
  const round = async (): Promise<number> => {
    let total = 0;
    for (;;) {
      if (stopped) return total;
      const n = await documents.extractPending(options.concurrency);
      total += n;
      if (n < options.concurrency) return total;
    }
  };
  const runOnce = (): Promise<number> => {
    running ??= round()
      .catch((error: unknown) => {
        log.error(errorFields(error), 'Extraction round failed');
        return 0;
      })
      .finally(() => (running = undefined));
    return running;
  };
  const timer = setInterval(() => void runOnce(), options.intervalMs);
  void runOnce();
  return {
    runOnce,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
