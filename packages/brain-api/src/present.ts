// API shapes (what clients see) from store rows: dates as ISO strings, page links for the UI.
import type { AuditEntry, ChannelLink, Container, Entity, EntityVersion, Link, SearchResult } from '@brain/brain';

export interface Urls {
  publicUrl: string;
}

export const entityUrl = (urls: Urls, id: string): string => `${urls.publicUrl}/entities/${id}`;
export const containerUrl = (urls: Urls, id: string): string => `${urls.publicUrl}/containers/${id}`;

export function presentContainer(container: Container, urls: Urls) {
  return {
    id: container.id,
    kind: container.kind,
    slug: container.slug,
    title: container.title,
    status: container.status,
    ownerId: container.ownerId,
    channelId: container.channelId,
    data: container.data,
    version: container.version,
    createdBy: container.createdBy,
    createdAt: container.createdAt.toISOString(),
    updatedAt: container.updatedAt.toISOString(),
    url: containerUrl(urls, container.id),
  };
}

export function presentChannelLink(link: ChannelLink) {
  return { mmChannelId: link.mmChannelId, relayChannelId: link.relayChannelId, containerId: link.containerId, role: link.role, createdBy: link.createdBy, createdAt: link.createdAt.toISOString() };
}

export function presentEntity(entity: Entity, urls: Urls) {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    status: entity.status,
    ownerId: entity.ownerId,
    containerId: entity.containerId,
    externalKey: entity.externalKey,
    channelId: entity.channelId,
    visibility: entity.visibility,
    data: entity.data,
    text: entity.text,
    version: entity.version,
    sourceKind: entity.sourceKind,
    sourceRef: entity.sourceRef,
    createdBy: entity.createdBy,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    archivedAt: entity.archivedAt ? entity.archivedAt.toISOString() : null,
    url: entityUrl(urls, entity.id),
  };
}

/** An entity without its text, for lists. */
export function presentEntitySummary(entity: Entity, urls: Urls) {
  const { text, ...rest } = presentEntity(entity, urls);
  void text;
  return rest;
}

export function presentVersion(version: EntityVersion) {
  return {
    entityId: version.entityId,
    version: version.version,
    title: version.title,
    status: version.status,
    ownerId: version.ownerId,
    containerId: version.containerId,
    visibility: version.visibility,
    data: version.data,
    text: version.text,
    actorId: version.actorId,
    actorKind: version.actorKind,
    sourceKind: version.sourceKind,
    sourceRef: version.sourceRef,
    createdAt: version.createdAt.toISOString(),
  };
}

export function presentLink(link: Link) {
  return { id: link.id, fromId: link.fromId, toId: link.toId, kind: link.kind, data: link.data, createdBy: link.createdBy, createdAt: link.createdAt.toISOString() };
}

export function presentSearchResult(result: SearchResult, urls: Urls) {
  return {
    entityId: result.entityId,
    entityType: result.entityType,
    title: result.title,
    containerId: result.containerId,
    channelId: result.channelId,
    version: result.version,
    updatedAt: result.updatedAt.toISOString(),
    chunkId: result.chunkId,
    docId: result.docId,
    snippet: result.snippet,
    score: result.score,
    matched: result.matched,
    citation: { ...result.citation, entityUrl: entityUrl(urls, result.entityId) },
    url: result.citation.url ?? entityUrl(urls, result.entityId),
  };
}

export function presentAudit(entry: AuditEntry) {
  return { id: entry.id, at: entry.at.toISOString(), actorId: entry.actorId, actorKind: entry.actorKind, action: entry.action, entityId: entry.entityId, containerId: entry.containerId, details: entry.details, ip: entry.ip, requestId: entry.requestId };
}
