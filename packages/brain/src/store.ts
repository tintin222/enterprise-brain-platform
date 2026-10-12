// The knowledge store (spec section 3 and 9; docs/brain/01-phase0-plan.md section 4): containers, entities with
// versions, links, chunks, the append-only audit log and the event outbox, in schema `brain` of our state
// database. Every write goes through here so that one transaction bumps the version, keeps the version row,
// re-chunks changed text, writes the audit row and appends the event.
import path from 'node:path';
import { migrate, relayChannelIdFor, withTransaction, type Pool, type PoolClient, type Queryable } from '@brain/shared';
import { chunkEntityText } from './chunker.ts';
import { hybridSearch } from './search.ts';
import {
  GENERAL_CONTAINER_ID,
  type AuditEntry,
  type BrainEvent,
  type ChannelLink,
  type ChannelRole,
  type Chunk,
  type ChunkInput,
  type Container,
  type ContainerKind,
  type ContainerStatus,
  type Entity,
  type EntityPatch,
  type EntityType,
  type EntityVersion,
  type Link,
  type LinkKind,
  type NewContainer,
  type NewEntity,
  type Scope,
  type SearchParams,
  type SearchResult,
  type Visibility,
  type WriteContext,
} from './types.ts';

export const BRAIN_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

export class BrainStoreError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid';

  constructor(code: 'not_found' | 'conflict' | 'invalid', message: string) {
    super(message);
    this.code = code;
  }
}

// --- row shapes ---

interface ContainerRow {
  id: string;
  kind: ContainerKind;
  slug: string;
  title: string;
  status: ContainerStatus;
  owner_id: string | null;
  channel_id: string | null;
  data: Record<string, unknown>;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface ChannelLinkRow {
  mm_channel_id: string;
  relay_channel_id: string;
  container_id: string;
  role: ChannelRole;
  created_by: string;
  created_at: Date;
}

interface EntityRow {
  id: string;
  type: EntityType;
  title: string;
  status: string;
  owner_id: string | null;
  container_id: string;
  external_key: string | null;
  channel_id: string | null;
  visibility: Visibility;
  data: Record<string, unknown>;
  text: string;
  version: number;
  source_kind: Entity['sourceKind'];
  source_ref: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface VersionRow {
  entity_id: string;
  version: number;
  title: string;
  status: string;
  owner_id: string | null;
  container_id: string;
  visibility: Visibility;
  data: Record<string, unknown>;
  text: string;
  actor_id: string;
  actor_kind: EntityVersion['actorKind'];
  source_kind: EntityVersion['sourceKind'];
  source_ref: string | null;
  created_at: Date;
}

interface LinkRow {
  id: string;
  from_id: string;
  to_id: string;
  kind: LinkKind;
  data: Record<string, unknown>;
  created_by: string;
  created_at: Date;
}

interface ChunkRow {
  id: string;
  entity_id: string;
  ordinal: number;
  text: string;
  metadata: Record<string, unknown>;
  embedded_at: Date | null;
  updated_at: Date;
}

interface AuditRow {
  id: string;
  at: Date;
  actor_id: string;
  actor_kind: AuditEntry['actorKind'];
  action: string;
  entity_id: string | null;
  container_id: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  request_id: string | null;
}

interface EventRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  created_at: Date;
  delivered_at: Date | null;
}

const CONTAINER_COLUMNS = 'id, kind, slug, title, status, owner_id, channel_id, data, version, created_by, created_at, updated_at';
const ENTITY_COLUMNS = 'id, type, title, status, owner_id, container_id, external_key, channel_id, visibility, data, text, version, source_kind, source_ref, created_by, created_at, updated_at, archived_at';
const VERSION_COLUMNS = 'entity_id, version, title, status, owner_id, container_id, visibility, data, text, actor_id, actor_kind, source_kind, source_ref, created_at';
const LINK_COLUMNS = 'id, from_id, to_id, kind, data, created_by, created_at';

const toContainer = (r: ContainerRow): Container => ({ id: r.id, kind: r.kind, slug: r.slug, title: r.title, status: r.status, ownerId: r.owner_id, channelId: r.channel_id, data: r.data, version: r.version, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
const toChannelLink = (r: ChannelLinkRow): ChannelLink => ({ mmChannelId: r.mm_channel_id, relayChannelId: r.relay_channel_id, containerId: r.container_id, role: r.role, createdBy: r.created_by, createdAt: r.created_at });
const toEntity = (r: EntityRow): Entity => ({
  id: r.id,
  type: r.type,
  title: r.title,
  status: r.status,
  ownerId: r.owner_id,
  containerId: r.container_id,
  externalKey: r.external_key,
  channelId: r.channel_id,
  visibility: r.visibility,
  data: r.data,
  text: r.text,
  version: r.version,
  sourceKind: r.source_kind,
  sourceRef: r.source_ref,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});
const toVersion = (r: VersionRow): EntityVersion => ({ entityId: r.entity_id, version: r.version, title: r.title, status: r.status, ownerId: r.owner_id, containerId: r.container_id, visibility: r.visibility, data: r.data, text: r.text, actorId: r.actor_id, actorKind: r.actor_kind, sourceKind: r.source_kind, sourceRef: r.source_ref, createdAt: r.created_at });
const toLink = (r: LinkRow): Link => ({ id: Number(r.id), fromId: r.from_id, toId: r.to_id, kind: r.kind, data: r.data, createdBy: r.created_by, createdAt: r.created_at });
const toChunk = (r: ChunkRow): Chunk => ({ id: r.id, entityId: r.entity_id, ordinal: r.ordinal, text: r.text, metadata: r.metadata, embeddedAt: r.embedded_at });
const toAudit = (r: AuditRow): AuditEntry => ({ id: Number(r.id), at: r.at, actorId: r.actor_id, actorKind: r.actor_kind, action: r.action, entityId: r.entity_id, containerId: r.container_id, details: r.details, ip: r.ip, requestId: r.request_id });
const toEvent = (r: EventRow): BrainEvent => ({ id: Number(r.id), name: r.name, payload: r.payload, createdAt: r.created_at, deliveredAt: r.delivered_at });

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Visibility when the writer gave none: members of the channel, everyone for General, else the container's members. */
export function defaultVisibility(containerId: string, channelId: string | undefined): Visibility {
  if (channelId) return 'members';
  return containerId === GENERAL_CONTAINER_ID ? 'public' : 'container';
}

function isClient(db: Queryable): db is PoolClient {
  return 'release' in db;
}

/** Run `fn` in a transaction, or inside the caller's when `db` already is a transaction client. */
function transactional<T>(db: Queryable, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return isClient(db) ? fn(db) : withTransaction(db, fn);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface ContainerFilter {
  kind?: ContainerKind;
  status?: ContainerStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface EntityFilter {
  containerId?: string;
  type?: EntityType;
  status?: string;
  ownerId?: string;
  channelId?: string;
  q?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditFilter {
  entityId?: string;
  containerId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export const EXPORT_TABLES = ['containers', 'channel_links', 'entities', 'entity_versions', 'links', 'chunks', 'audit_log', 'events', 'channels'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

export class BrainStore {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Create or upgrade the brain's tables. */
  async init(): Promise<void> {
    await migrate(this.pool, 'brain', BRAIN_MIGRATIONS_DIR);
  }

  // --- containers ---

  async createContainer(input: NewContainer, ctx: WriteContext): Promise<Container> {
    return withTransaction(this.pool, async (tx) => {
      const slug = await this.#freeSlug(tx, input.slug ? slugify(input.slug) : slugify(input.title));
      const r = await tx.query<ContainerRow>(
        `INSERT INTO brain.containers (kind, slug, title, owner_id, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CONTAINER_COLUMNS}`,
        [input.kind, slug, input.title.trim(), input.ownerId ?? null, JSON.stringify(input.data ?? {}), ctx.actor.id],
      );
      const container = toContainer(r.rows[0]!);
      await this.#audit(tx, { action: 'container.create', containerId: container.id, details: { kind: container.kind, title: container.title } }, ctx);
      await this.#event(tx, 'container.created', { containerId: container.id, kind: container.kind });
      return container;
    });
  }

  async #freeSlug(db: Queryable, base: string): Promise<string> {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const taken = await db.query('SELECT 1 FROM brain.containers WHERE slug = $1', [candidate]);
      if (taken.rowCount === 0) return candidate;
    }
  }

  async getContainer(idOrSlug: string, db: Queryable = this.pool): Promise<Container | undefined> {
    const r = await db.query<ContainerRow>(`SELECT ${CONTAINER_COLUMNS} FROM brain.containers WHERE id = $1 OR slug = $1 LIMIT 1`, [idOrSlug]);
    return r.rows[0] ? toContainer(r.rows[0]) : undefined;
  }

  async listContainers(filter: ContainerFilter = {}): Promise<Container[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.kind) where.push(`kind = $${params.push(filter.kind)}`);
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter.q) where.push(`title ILIKE $${params.push(`%${filter.q}%`)}`);
    const limit = params.push(Math.min(filter.limit ?? 100, 500));
    const offset = params.push(filter.offset ?? 0);
    const r = await this.pool.query<ContainerRow>(
      `SELECT ${CONTAINER_COLUMNS} FROM brain.containers ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (kind = 'general') DESC, updated_at DESC LIMIT $${limit} OFFSET $${offset}`,
      params,
    );
    return r.rows.map(toContainer);
  }

  async updateContainer(id: string, patch: { title?: string; ownerId?: string | null; data?: Record<string, unknown>; status?: ContainerStatus }, ctx: WriteContext): Promise<Container> {
    return withTransaction(this.pool, async (tx) => {
      const current = await tx.query<ContainerRow>(`SELECT ${CONTAINER_COLUMNS} FROM brain.containers WHERE id = $1 FOR UPDATE`, [id]);
      const before = current.rows[0];
      if (!before) throw new BrainStoreError('not_found', `No container ${id}`);
      if (before.kind === 'general' && (patch.status || patch.title)) throw new BrainStoreError('invalid', 'The General container cannot be renamed or archived');
      const next = {
        title: patch.title?.trim() ?? before.title,
        owner_id: patch.ownerId === undefined ? before.owner_id : patch.ownerId,
        data: patch.data ? { ...before.data, ...patch.data } : before.data,
        status: patch.status ?? before.status,
      };
      const changed = (['title', 'owner_id', 'data', 'status'] as const).filter((key) => !sameJson(next[key], before[key]));
      if (changed.length === 0) return toContainer(before);
      const r = await tx.query<ContainerRow>(
        `UPDATE brain.containers SET title = $2, owner_id = $3, data = $4, status = $5, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${CONTAINER_COLUMNS}`,
        [id, next.title, next.owner_id, JSON.stringify(next.data), next.status],
      );
      const container = toContainer(r.rows[0]!);
      await this.#audit(tx, { action: patch.status === 'archived' ? 'container.archive' : 'container.update', containerId: id, details: { changed, version: container.version } }, ctx);
      await this.#event(tx, 'container.updated', { containerId: id, changed });
      return container;
    });
  }

  // --- channels ---

  async linkChannel(containerId: string, mmChannelId: string, role: ChannelRole, ctx: WriteContext): Promise<ChannelLink> {
    return withTransaction(this.pool, async (tx) => {
      const container = await this.getContainer(containerId, tx);
      if (!container) throw new BrainStoreError('not_found', `No container ${containerId}`);
      const relayChannelId = relayChannelIdFor(mmChannelId);
      const r = await tx.query<ChannelLinkRow>(
        `INSERT INTO brain.channel_links (mm_channel_id, relay_channel_id, container_id, role, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (mm_channel_id) DO UPDATE SET container_id = EXCLUDED.container_id, role = EXCLUDED.role
         RETURNING mm_channel_id, relay_channel_id, container_id, role, created_by, created_at`,
        [mmChannelId, relayChannelId, container.id, role, ctx.actor.id],
      );
      await this.#reattribute(tx, relayChannelId, container.id);
      if (role === 'home' && !container.channelId) await tx.query('UPDATE brain.containers SET channel_id = $2, updated_at = now() WHERE id = $1 AND channel_id IS NULL', [container.id, mmChannelId]);
      await this.#audit(tx, { action: 'channel.link', containerId: container.id, details: { mmChannelId, role } }, ctx);
      await this.#event(tx, 'channel.linked', { containerId: container.id, mmChannelId, relayChannelId, role });
      return toChannelLink(r.rows[0]!);
    });
  }

  async unlinkChannel(mmChannelId: string, ctx: WriteContext): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query<ChannelLinkRow>('DELETE FROM brain.channel_links WHERE mm_channel_id = $1 RETURNING mm_channel_id, relay_channel_id, container_id, role, created_by, created_at', [mmChannelId]);
      const link = r.rows[0];
      if (!link) return false;
      await this.#reattribute(tx, link.relay_channel_id, GENERAL_CONTAINER_ID);
      await tx.query('UPDATE brain.containers SET channel_id = NULL, updated_at = now() WHERE id = $1 AND channel_id = $2', [link.container_id, mmChannelId]);
      await this.#audit(tx, { action: 'channel.unlink', containerId: link.container_id, details: { mmChannelId } }, ctx);
      await this.#event(tx, 'channel.unlinked', { containerId: link.container_id, mmChannelId });
      return true;
    });
  }

  /** Conversations of a channel follow the channel's container (FR-1.7: its threads are the Topic's conversations). */
  async #reattribute(tx: Queryable, relayChannelId: string, containerId: string): Promise<void> {
    await tx.query(`UPDATE brain.entities SET container_id = $2, updated_at = now() WHERE type = 'conversation' AND channel_id = $1 AND container_id <> $2`, [relayChannelId, containerId]);
    await tx.query(`UPDATE brain.chunks SET container_id = $2 WHERE entity_type = 'conversation' AND channel_id = $1 AND container_id <> $2`, [relayChannelId, containerId]);
  }

  async channelLinkByMm(mmChannelId: string): Promise<ChannelLink | undefined> {
    const r = await this.pool.query<ChannelLinkRow>('SELECT mm_channel_id, relay_channel_id, container_id, role, created_by, created_at FROM brain.channel_links WHERE mm_channel_id = $1', [mmChannelId]);
    return r.rows[0] ? toChannelLink(r.rows[0]) : undefined;
  }

  async channelLinkByRelay(relayChannelId: string, db: Queryable = this.pool): Promise<ChannelLink | undefined> {
    const r = await db.query<ChannelLinkRow>('SELECT mm_channel_id, relay_channel_id, container_id, role, created_by, created_at FROM brain.channel_links WHERE relay_channel_id = $1', [relayChannelId]);
    return r.rows[0] ? toChannelLink(r.rows[0]) : undefined;
  }

  async channelLinks(containerId: string): Promise<ChannelLink[]> {
    const r = await this.pool.query<ChannelLinkRow>('SELECT mm_channel_id, relay_channel_id, container_id, role, created_by, created_at FROM brain.channel_links WHERE container_id = $1 ORDER BY created_at', [containerId]);
    return r.rows.map(toChannelLink);
  }

  /** The containers whose channels include any of these Mattermost channels (a person's containers, plan section 5). */
  async containersOfChannels(mmChannelIds: string[]): Promise<string[]> {
    if (mmChannelIds.length === 0) return [];
    const r = await this.pool.query<{ container_id: string }>('SELECT DISTINCT container_id FROM brain.channel_links WHERE mm_channel_id = ANY($1::text[])', [mmChannelIds]);
    return r.rows.map((row) => row.container_id);
  }

  /** Name, visibility and active state of a relay channel, as ingestion keeps them (D36). */
  /** How many chunks hold each lexeme (Q24): rebuilt from the chunks' index in one statement, for the search's rare-terms tier. */
  async refreshLexemeStats(): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      await tx.query('TRUNCATE brain.lexeme_stats');
      const r = await tx.query("INSERT INTO brain.lexeme_stats (lexeme, chunks) SELECT word, ndoc FROM ts_stat('SELECT search FROM brain.chunks')");
      return r.rowCount ?? 0;
    });
  }

  /** Containers a person entity owns (the owner is always a member; plan section 4). */
  async containersOwnedBy(personId: string): Promise<string[]> {
    const r = await this.pool.query<{ id: string }>('SELECT id FROM brain.containers WHERE owner_id = $1', [personId]);
    return r.rows.map((row) => row.id);
  }

  async channelFacts(relayChannelId: string, db: Queryable = this.pool): Promise<{ name: string; visibility: 'open' | 'private'; active: boolean } | undefined> {
    const r = await db.query<{ name: string; visibility: 'open' | 'private'; active: boolean }>('SELECT name, visibility, active FROM brain.channels WHERE channel_id = $1', [relayChannelId]);
    return r.rows[0];
  }

  // --- entities ---

  async createEntity(input: NewEntity, ctx: WriteContext, db: Queryable = this.pool): Promise<Entity> {
    return transactional(db, async (tx) => {
      const container = await this.getContainer(input.containerId, tx);
      if (!container) throw new BrainStoreError('not_found', `No container ${input.containerId}`);
      const visibility = input.visibility ?? defaultVisibility(container.id, input.channelId);
      const r = await tx.query<EntityRow>(
        `INSERT INTO brain.entities (type, title, status, owner_id, container_id, external_key, channel_id, visibility, data, text, source_kind, source_ref, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${ENTITY_COLUMNS}`,
        [input.type, input.title.trim(), input.status ?? 'active', input.ownerId ?? null, container.id, input.externalKey ?? null, input.channelId ?? null, visibility, JSON.stringify(input.data ?? {}), input.text ?? '', ctx.source.kind, ctx.source.ref ?? null, ctx.actor.id],
      );
      const entity = toEntity(r.rows[0]!);
      await this.#insertVersion(tx, entity, ctx);
      await this.#writeChunks(tx, entity, input.chunks ?? chunkEntityText(entity.title, entity.text));
      await this.#audit(tx, { action: 'entity.create', entityId: entity.id, containerId: entity.containerId, details: { type: entity.type, title: entity.title } }, ctx);
      await this.#event(tx, 'entity.created', { entityId: entity.id, type: entity.type, containerId: entity.containerId, version: 1 });
      return entity;
    });
  }

  async updateEntity(id: string, patch: EntityPatch, ctx: WriteContext, db: Queryable = this.pool): Promise<Entity> {
    return transactional(db, async (tx) => {
      const current = await tx.query<EntityRow>(`SELECT ${ENTITY_COLUMNS} FROM brain.entities WHERE id = $1 FOR UPDATE`, [id]);
      const before = current.rows[0];
      if (!before) throw new BrainStoreError('not_found', `No entity ${id}`);
      if (patch.containerId && patch.containerId !== before.container_id && !(await this.getContainer(patch.containerId, tx))) throw new BrainStoreError('not_found', `No container ${patch.containerId}`);
      const next = {
        title: patch.title?.trim() ?? before.title,
        status: patch.status ?? before.status,
        owner_id: patch.ownerId === undefined ? before.owner_id : patch.ownerId,
        container_id: patch.containerId ?? before.container_id,
        visibility: patch.visibility ?? before.visibility,
        data: patch.data ? { ...before.data, ...patch.data } : before.data,
        text: patch.text ?? before.text,
      };
      const changed = (['title', 'status', 'owner_id', 'container_id', 'visibility', 'data', 'text'] as const).filter((key) => !sameJson(next[key], before[key]));
      if (changed.length === 0 && !patch.chunks && before.archived_at === null) return toEntity(before);
      const r = await tx.query<EntityRow>(
        `UPDATE brain.entities SET title = $2, status = $3, owner_id = $4, container_id = $5, visibility = $6, data = $7, text = $8,
                version = version + ${changed.length > 0 ? 1 : 0}, updated_at = now(), archived_at = NULL
         WHERE id = $1 RETURNING ${ENTITY_COLUMNS}`,
        [id, next.title, next.status, next.owner_id, next.container_id, next.visibility, JSON.stringify(next.data), next.text],
      );
      const entity = toEntity(r.rows[0]!);
      if (changed.length > 0) await this.#insertVersion(tx, entity, ctx);
      if (patch.chunks || changed.includes('text') || changed.includes('title')) {
        await this.#writeChunks(tx, entity, patch.chunks ?? chunkEntityText(entity.title, entity.text));
      } else if (changed.includes('container_id') || changed.includes('visibility')) {
        await tx.query('UPDATE brain.chunks SET container_id = $2, visibility = $3 WHERE entity_id = $1', [id, entity.containerId, entity.visibility]);
      }
      if (changed.length > 0) {
        await this.#audit(tx, { action: 'entity.update', entityId: id, containerId: entity.containerId, details: { changed, version: entity.version } }, ctx);
        await this.#event(tx, 'entity.updated', { entityId: id, type: entity.type, containerId: entity.containerId, version: entity.version, changed });
      }
      return entity;
    });
  }

  /** Create or update by external key (idempotent producers such as ingestion). Returns whether anything changed. */
  async upsertEntityByExternalKey(input: NewEntity & { externalKey: string }, ctx: WriteContext): Promise<{ entity: Entity; created: boolean; changed: boolean }> {
    return withTransaction(this.pool, async (tx) => {
      const existing = await tx.query<EntityRow>(`SELECT ${ENTITY_COLUMNS} FROM brain.entities WHERE external_key = $1 FOR UPDATE`, [input.externalKey]);
      const before = existing.rows[0];
      if (!before) return { entity: await this.createEntity(input, ctx, tx), created: true, changed: true };
      const patch: EntityPatch = { title: input.title, status: input.status, containerId: input.containerId, visibility: input.visibility, data: input.data, text: input.text, chunks: input.chunks };
      const entity = await this.updateEntity(before.id, patch, ctx, tx);
      return { entity, created: false, changed: entity.version !== before.version || before.archived_at !== null };
    });
  }

  async archiveEntity(id: string, ctx: WriteContext, db: Queryable = this.pool): Promise<Entity> {
    return transactional(db, async (tx) => {
      const r = await tx.query<EntityRow>(`UPDATE brain.entities SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE id = $1 RETURNING ${ENTITY_COLUMNS}`, [id]);
      const entity = r.rows[0];
      if (!entity) throw new BrainStoreError('not_found', `No entity ${id}`);
      await this.#audit(tx, { action: 'entity.archive', entityId: id, containerId: entity.container_id }, ctx);
      await this.#event(tx, 'entity.archived', { entityId: id, type: entity.type, containerId: entity.container_id });
      return toEntity(entity);
    });
  }

  async getEntity(id: string, db: Queryable = this.pool): Promise<Entity | undefined> {
    const r = await db.query<EntityRow>(`SELECT ${ENTITY_COLUMNS} FROM brain.entities WHERE id = $1`, [id]);
    return r.rows[0] ? toEntity(r.rows[0]) : undefined;
  }

  async getEntityByExternalKey(key: string, db: Queryable = this.pool): Promise<Entity | undefined> {
    const r = await db.query<EntityRow>(`SELECT ${ENTITY_COLUMNS} FROM brain.entities WHERE external_key = $1`, [key]);
    return r.rows[0] ? toEntity(r.rows[0]) : undefined;
  }

  async listEntities(filter: EntityFilter = {}): Promise<Entity[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.containerId) where.push(`container_id = $${params.push(filter.containerId)}`);
    if (filter.type) where.push(`type = $${params.push(filter.type)}`);
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter.ownerId) where.push(`owner_id = $${params.push(filter.ownerId)}`);
    if (filter.channelId) where.push(`channel_id = $${params.push(filter.channelId)}`);
    if (filter.q) where.push(`title ILIKE $${params.push(`%${filter.q}%`)}`);
    if (!filter.includeArchived) where.push('archived_at IS NULL');
    const limit = params.push(Math.min(filter.limit ?? 100, 500));
    const offset = params.push(filter.offset ?? 0);
    const r = await this.pool.query<EntityRow>(`SELECT ${ENTITY_COLUMNS} FROM brain.entities ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT $${limit} OFFSET $${offset}`, params);
    return r.rows.map(toEntity);
  }

  /** How many live entities of each type a container holds. */
  async entityCounts(containerId: string): Promise<Record<string, number>> {
    const r = await this.pool.query<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM brain.entities WHERE container_id = $1 AND archived_at IS NULL GROUP BY type', [containerId]);
    return Object.fromEntries(r.rows.map((row) => [row.type, row.n]));
  }

  async listVersions(entityId: string): Promise<EntityVersion[]> {
    const r = await this.pool.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM brain.entity_versions WHERE entity_id = $1 ORDER BY version DESC`, [entityId]);
    return r.rows.map(toVersion);
  }

  async getVersion(entityId: string, version: number): Promise<EntityVersion | undefined> {
    const r = await this.pool.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM brain.entity_versions WHERE entity_id = $1 AND version = $2`, [entityId, version]);
    return r.rows[0] ? toVersion(r.rows[0]) : undefined;
  }

  async #insertVersion(tx: Queryable, entity: Entity, ctx: WriteContext): Promise<void> {
    await tx.query(
      `INSERT INTO brain.entity_versions (${VERSION_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
      [entity.id, entity.version, entity.title, entity.status, entity.ownerId, entity.containerId, entity.visibility, JSON.stringify(entity.data), entity.text, ctx.actor.id, ctx.actor.kind, ctx.source.kind, ctx.source.ref ?? null],
    );
  }

  // --- chunks and embeddings ---

  /** Replace an entity's chunks; a chunk whose text is unchanged keeps its embedding. */
  async #writeChunks(tx: Queryable, entity: Entity, chunks: ChunkInput[]): Promise<void> {
    const ordinals: number[] = [];
    for (const chunk of chunks) {
      ordinals.push(chunk.ordinal);
      await tx.query(
        `INSERT INTO brain.chunks (id, entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, tokens, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           entity_type = EXCLUDED.entity_type, container_id = EXCLUDED.container_id, channel_id = EXCLUDED.channel_id, visibility = EXCLUDED.visibility,
           text = EXCLUDED.text, tokens = EXCLUDED.tokens, metadata = EXCLUDED.metadata,
           embedding = CASE WHEN brain.chunks.text = EXCLUDED.text THEN brain.chunks.embedding END,
           embedding_model = CASE WHEN brain.chunks.text = EXCLUDED.text THEN brain.chunks.embedding_model END,
           embedded_at = CASE WHEN brain.chunks.text = EXCLUDED.text THEN brain.chunks.embedded_at END,
           updated_at = CASE WHEN brain.chunks.text = EXCLUDED.text AND brain.chunks.metadata = EXCLUDED.metadata THEN brain.chunks.updated_at ELSE now() END`,
        [`${entity.id}:${chunk.ordinal}`, entity.id, entity.type, entity.containerId, entity.channelId, entity.visibility, chunk.ordinal, chunk.text, chunk.tokens ?? null, JSON.stringify(chunk.metadata ?? {})],
      );
    }
    await tx.query('DELETE FROM brain.chunks WHERE entity_id = $1 AND NOT (ordinal = ANY($2::int[]))', [entity.id, ordinals]);
  }

  async chunksOf(entityId: string): Promise<Chunk[]> {
    const r = await this.pool.query<ChunkRow>('SELECT id, entity_id, ordinal, text, metadata, embedded_at, updated_at FROM brain.chunks WHERE entity_id = $1 ORDER BY ordinal', [entityId]);
    return r.rows.map(toChunk);
  }

  async deleteChunk(id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM brain.chunks WHERE id = $1', [id]);
    return r.rowCount === 1;
  }

  /**
   * Chunks waiting for an embedding, oldest change first. `version` is the chunk's update time as Postgres
   * prints it (microseconds included), so `saveEmbedding` can tell whether the text changed meanwhile.
   */
  async chunksToEmbed(limit: number): Promise<(Chunk & { version: string })[]> {
    const r = await this.pool.query<ChunkRow & { version: string }>('SELECT id, entity_id, ordinal, text, metadata, embedded_at, updated_at, updated_at::text AS version FROM brain.chunks WHERE embedded_at IS NULL ORDER BY updated_at LIMIT $1', [limit]);
    return r.rows.map((row) => ({ ...toChunk(row), version: row.version }));
  }

  /** Store an embedding unless the chunk changed since it was read (then the next round embeds the new text). */
  async saveEmbedding(id: string, version: string, vector: number[], model: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE brain.chunks SET embedding = $3::vector, embedding_model = $4, embedded_at = now() WHERE id = $1 AND updated_at = $2::timestamptz', [id, version, `[${vector.join(',')}]`, model]);
    return r.rowCount === 1;
  }

  async pendingEmbeddings(): Promise<number> {
    const r = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM brain.chunks WHERE embedded_at IS NULL');
    return r.rows[0]?.n ?? 0;
  }

  // --- links ---

  async createLink(input: { fromId: string; toId: string; kind: LinkKind; data?: Record<string, unknown> }, ctx: WriteContext): Promise<Link> {
    return withTransaction(this.pool, async (tx) => {
      const known = await tx.query<{ id: string }>('SELECT id FROM brain.entities WHERE id = ANY($1::text[]) UNION SELECT id FROM brain.containers WHERE id = ANY($1::text[])', [[input.fromId, input.toId]]);
      const ids = new Set(known.rows.map((row) => row.id));
      for (const id of [input.fromId, input.toId]) if (!ids.has(id)) throw new BrainStoreError('not_found', `No entity or container ${id}`);
      const r = await tx.query<LinkRow>(
        `INSERT INTO brain.links (from_id, to_id, kind, data, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (from_id, to_id, kind) DO UPDATE SET data = EXCLUDED.data RETURNING ${LINK_COLUMNS}`,
        [input.fromId, input.toId, input.kind, JSON.stringify(input.data ?? {}), ctx.actor.id],
      );
      const link = toLink(r.rows[0]!);
      await this.#audit(tx, { action: 'link.create', entityId: input.fromId, details: { toId: input.toId, kind: input.kind } }, ctx);
      await this.#event(tx, 'link.created', { linkId: link.id, fromId: link.fromId, toId: link.toId, kind: link.kind });
      return link;
    });
  }

  async deleteLink(id: number, ctx: WriteContext): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      const r = await tx.query<LinkRow>(`DELETE FROM brain.links WHERE id = $1 RETURNING ${LINK_COLUMNS}`, [id]);
      const link = r.rows[0];
      if (!link) return false;
      await this.#audit(tx, { action: 'link.delete', entityId: link.from_id, details: { toId: link.to_id, kind: link.kind } }, ctx);
      return true;
    });
  }

  async getLink(id: number): Promise<Link | undefined> {
    const r = await this.pool.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM brain.links WHERE id = $1`, [id]);
    return r.rows[0] ? toLink(r.rows[0]) : undefined;
  }

  /** Links in both directions for an entity or container, optionally of one kind (spec: bidirectional in queries). */
  async linksOf(id: string, kind?: LinkKind): Promise<{ outgoing: Link[]; incoming: Link[] }> {
    const params: unknown[] = [id];
    const kindSql = kind ? ` AND kind = $${params.push(kind)}` : '';
    const out = await this.pool.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM brain.links WHERE from_id = $1${kindSql} ORDER BY created_at`, params);
    const inc = await this.pool.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM brain.links WHERE to_id = $1${kindSql} ORDER BY created_at`, params);
    return { outgoing: out.rows.map(toLink), incoming: inc.rows.map(toLink) };
  }

  /** Everything that points at an entity (FR-9.4): links, and texts the scope may see that name its title. */
  async backlinks(entity: Entity, scope: Scope): Promise<{ links: Link[]; mentions: SearchResult[] }> {
    const { incoming } = await this.linksOf(entity.id);
    const mentions =
      entity.title.trim().length >= 3
        ? (await hybridSearch(this.pool, { query: entity.title, scope, limit: 20 })).filter((result) => result.entityId !== entity.id && result.matched.includes('keyword'))
        : [];
    return { links: incoming, mentions };
  }

  // --- search ---

  search(params: SearchParams): Promise<SearchResult[]> {
    // pgvector returns at most ef_search rows from a plain HNSW scan and stops at dead or filtered-out rows, so the
    // vector half scans iteratively until it has its candidates (D62).
    return withTransaction(this.pool, async (client) => {
      await client.query('SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL hnsw.ef_search = 100');
      return hybridSearch(client, params);
    });
  }

  // --- audit and events ---

  async #audit(tx: Queryable, entry: { action: string; entityId?: string; containerId?: string; details?: Record<string, unknown> }, ctx: WriteContext): Promise<void> {
    await tx.query('INSERT INTO brain.audit_log (actor_id, actor_kind, action, entity_id, container_id, details, ip, request_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      ctx.actor.id,
      ctx.actor.kind,
      entry.action,
      entry.entityId ?? null,
      entry.containerId ?? null,
      JSON.stringify(entry.details ?? {}),
      ctx.ip ?? null,
      ctx.requestId ?? null,
    ]);
  }

  /** An audit row outside an entity write (searches, exports, reveals). */
  audit(entry: { action: string; entityId?: string; containerId?: string; details?: Record<string, unknown> }, ctx: WriteContext): Promise<void> {
    return this.#audit(this.pool, entry, ctx);
  }

  async listAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.entityId) where.push(`entity_id = $${params.push(filter.entityId)}`);
    if (filter.containerId) where.push(`container_id = $${params.push(filter.containerId)}`);
    if (filter.actorId) where.push(`actor_id = $${params.push(filter.actorId)}`);
    if (filter.from) where.push(`at >= $${params.push(filter.from)}`);
    if (filter.to) where.push(`at <= $${params.push(filter.to)}`);
    const limit = params.push(Math.min(filter.limit ?? 100, 1000));
    const r = await this.pool.query<AuditRow>(`SELECT id, at, actor_id, actor_kind, action, entity_id, container_id, details, ip, request_id FROM brain.audit_log ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${limit}`, params);
    return r.rows.map(toAudit);
  }

  async #event(tx: Queryable, name: string, payload: Record<string, unknown>): Promise<void> {
    await tx.query('INSERT INTO brain.events (name, payload) VALUES ($1, $2)', [name, JSON.stringify(payload)]);
  }

  appendEvent(name: string, payload: Record<string, unknown>): Promise<void> {
    return this.#event(this.pool, name, payload);
  }

  async pendingEvents(limit = 100): Promise<BrainEvent[]> {
    const r = await this.pool.query<EventRow>('SELECT id, name, payload, created_at, delivered_at FROM brain.events WHERE delivered_at IS NULL ORDER BY id LIMIT $1', [limit]);
    return r.rows.map(toEvent);
  }

  async markDelivered(ids: number[]): Promise<void> {
    if (ids.length > 0) await this.pool.query('UPDATE brain.events SET delivered_at = now() WHERE id = ANY($1::bigint[])', [ids]);
  }

  // --- settings (no secrets) ---

  async getSetting<T>(key: string): Promise<T | undefined> {
    const r = await this.pool.query<{ value: T }>('SELECT value FROM brain.settings WHERE key = $1', [key]);
    return r.rows[0]?.value;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.pool.query('INSERT INTO brain.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, JSON.stringify(value)]);
  }

  // --- export (NFR-9) ---

  /** Every row of a table, in batches, as plain objects; chunk embeddings only on request. */
  async *exportRows(table: ExportTable, options: { withEmbeddings?: boolean; batch?: number } = {}): AsyncGenerator<Record<string, unknown>> {
    const columns = table === 'chunks' && !options.withEmbeddings ? 'id, entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, tokens, metadata, embedding_model, embedded_at, updated_at' : table === 'chunks' ? 'id, entity_id, entity_type, container_id, channel_id, visibility, ordinal, text, tokens, metadata, embedding::text AS embedding, embedding_model, embedded_at, updated_at' : '*';
    const order = EXPORT_ORDER[table];
    const batch = options.batch ?? 1000;
    for (let offset = 0; ; offset += batch) {
      const r = await this.pool.query<Record<string, unknown>>(`SELECT ${columns} FROM brain.${table} ORDER BY ${order} LIMIT $1 OFFSET $2`, [batch, offset]);
      for (const row of r.rows) yield row;
      if (r.rows.length < batch) return;
    }
  }

  async counts(): Promise<Record<ExportTable, number>> {
    const out = {} as Record<ExportTable, number>;
    for (const table of EXPORT_TABLES) {
      const r = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM brain.${table}`);
      out[table] = r.rows[0]?.n ?? 0;
    }
    return out;
  }
}

const EXPORT_ORDER: Record<ExportTable, string> = {
  containers: 'created_at, id',
  channel_links: 'created_at, mm_channel_id',
  entities: 'created_at, id',
  entity_versions: 'entity_id, version',
  links: 'id',
  chunks: 'id',
  audit_log: 'id',
  events: 'id',
  channels: 'channel_id',
};
