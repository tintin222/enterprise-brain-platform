// The knowledge model (spec section 3; docs/brain/01-phase0-plan.md section 4).

export type ContainerKind = 'project' | 'topic' | 'general';
export type ContainerStatus = 'active' | 'archived';
export const GENERAL_CONTAINER_ID = 'general';

export const ENTITY_TYPES = ['person', 'system', 'requirement', 'document', 'credential_ref', 'task', 'decision', 'conversation', 'meeting', 'package', 'agent', 'agent_note'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const LINK_KINDS = ['belongs_to', 'raised_by', 'implements', 'depends_on', 'supersedes', 'mentioned_in', 'owns', 'member_of', 'attached_to', 'spawned_from'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const CHANNEL_ROLES = ['home', 'requirements', 'agent', 'linked'] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/** public: everyone signed in; members: current members of channel_id; container: members of container_id. */
export type Visibility = 'public' | 'members' | 'container';
export type ActorKind = 'person' | 'agent' | 'system';
export type SourceKind = 'api' | 'web' | 'chat' | 'upload' | 'mail' | 'meeting' | 'migration' | 'system';

export interface Actor {
  kind: ActorKind;
  /** A Mattermost user id for people, an agent handle, or 'system'. */
  id: string;
}

/** Who did a write, from what source, so every version and audit row says so (spec section 3 rules). */
export interface WriteContext {
  actor: Actor;
  source: { kind: SourceKind; ref?: string };
  ip?: string;
  requestId?: string;
}

export const SYSTEM_WRITE: WriteContext = { actor: { kind: 'system', id: 'system' }, source: { kind: 'system' } };

export interface Container {
  id: string;
  kind: ContainerKind;
  slug: string;
  title: string;
  status: ContainerStatus;
  ownerId: string | null;
  channelId: string | null;
  data: Record<string, unknown>;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewContainer {
  kind: 'project' | 'topic';
  title: string;
  slug?: string;
  ownerId?: string;
  data?: Record<string, unknown>;
}

export interface ChannelLink {
  mmChannelId: string;
  relayChannelId: string;
  containerId: string;
  role: ChannelRole;
  createdBy: string;
  createdAt: Date;
}

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  status: string;
  ownerId: string | null;
  containerId: string;
  externalKey: string | null;
  /** For conversations: the relay channel id (D18). */
  channelId: string | null;
  visibility: Visibility;
  data: Record<string, unknown>;
  text: string;
  version: number;
  sourceKind: SourceKind;
  sourceRef: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface NewEntity {
  type: EntityType;
  title: string;
  status?: string;
  ownerId?: string;
  containerId: string;
  externalKey?: string;
  channelId?: string;
  visibility?: Visibility;
  data?: Record<string, unknown>;
  text?: string;
  /** Pre-chunked text (conversations from ingestion); otherwise `text` is chunked. */
  chunks?: ChunkInput[];
}

export interface EntityPatch {
  title?: string;
  status?: string;
  ownerId?: string | null;
  containerId?: string;
  visibility?: Visibility;
  data?: Record<string, unknown>;
  text?: string;
  chunks?: ChunkInput[];
}

export interface EntityVersion {
  entityId: string;
  version: number;
  title: string;
  status: string;
  ownerId: string | null;
  containerId: string;
  visibility: Visibility;
  data: Record<string, unknown>;
  text: string;
  actorId: string;
  actorKind: ActorKind;
  sourceKind: SourceKind;
  sourceRef: string | null;
  createdAt: Date;
}

export interface Link {
  id: number;
  fromId: string;
  toId: string;
  kind: LinkKind;
  data: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
}

export interface ChunkInput {
  ordinal: number;
  text: string;
  tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  entityId: string;
  ordinal: number;
  text: string;
  metadata: Record<string, unknown>;
  embeddedAt: Date | null;
}

export interface AuditEntry {
  id: number;
  at: Date;
  actorId: string;
  actorKind: ActorKind;
  action: string;
  entityId: string | null;
  containerId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
}

export interface BrainEvent {
  id: number;
  name: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  deliveredAt: Date | null;
}

/**
 * Who may see what (FR-9.5, plan section 5). `all` is an admin or the service; `person` carries the relay ids of
 * the channels the person is in and the containers they belong to; `channel` is an agent answering in a channel
 * (D35: that channel, active public channels, and the channel's own container).
 */
export type Scope = { kind: 'all' } | { kind: 'person'; channelIds: string[]; containerIds: string[] } | { kind: 'channel'; channelId: string; containerId?: string };

export interface SearchFilters {
  containerId?: string;
  types?: EntityType[];
  /** Entities owned by this person entity id, or conversations with this author (pubkey). */
  personId?: string;
  from?: Date;
  to?: Date;
  includeArchived?: boolean;
}

export interface SearchParams {
  query: string;
  /** The query's embedding; without it the search is keyword only. */
  embedding?: number[];
  /** Semantic hits farther than this (cosine distance) are noise and dropped; default 0.5. */
  maxDistance?: number;
  scope: Scope;
  filters?: SearchFilters;
  limit?: number;
}

export interface Citation {
  kind: 'post' | 'entity';
  url?: string;
  postId?: string;
  eventId?: string;
}

export interface SearchResult {
  entityId: string;
  entityType: EntityType;
  title: string;
  containerId: string;
  channelId: string | null;
  version: number;
  updatedAt: Date;
  chunkId: string;
  /** The chunk's document id for conversations (ingestion's id), else the chunk id. */
  docId: string;
  snippet: string;
  text: string;
  score: number;
  matched: ('keyword' | 'semantic')[];
  citation: Citation;
  metadata: Record<string, unknown>;
}
