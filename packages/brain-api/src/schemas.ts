// Request and response schemas of the brain API (zod; they also produce docs/brain/API.md through OpenAPI).
import { CHANNEL_ROLES, ENTITY_TYPES, LINK_KINDS } from '@brain/brain';
import { z } from 'zod';

export const id = z.string().min(1).max(200);
export const mmId = z.string().regex(/^[a-z0-9]{26}$/, 'a Mattermost id');
export const isoDate = z.iso.datetime();
export const jsonObject = z.record(z.string(), z.unknown());
export const entityType = z.enum(ENTITY_TYPES);
export const linkKind = z.enum(LINK_KINDS);
export const channelRole = z.enum(CHANNEL_ROLES);
export const visibility = z.enum(['public', 'members', 'container']);
export const paging = { limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() };

export const errorResponse = z.object({ error: z.string(), code: z.string().optional() });

export const containerOut = z.object({
  id: z.string(),
  kind: z.enum(['project', 'topic', 'general']),
  slug: z.string(),
  title: z.string(),
  status: z.enum(['active', 'archived']),
  ownerId: z.string().nullable(),
  channelId: z.string().nullable(),
  data: jsonObject,
  version: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});

export const channelLinkOut = z.object({ mmChannelId: z.string(), relayChannelId: z.string(), containerId: z.string(), role: channelRole, createdBy: z.string(), createdAt: z.string() });

export const entitySummaryOut = z.object({
  id: z.string(),
  type: entityType,
  title: z.string(),
  status: z.string(),
  ownerId: z.string().nullable(),
  containerId: z.string(),
  externalKey: z.string().nullable(),
  channelId: z.string().nullable(),
  visibility,
  data: jsonObject,
  version: z.number(),
  sourceKind: z.string(),
  sourceRef: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  url: z.string(),
});
export const entityOut = entitySummaryOut.extend({ text: z.string() });

export const versionOut = z.object({
  entityId: z.string(),
  version: z.number(),
  title: z.string(),
  status: z.string(),
  ownerId: z.string().nullable(),
  containerId: z.string(),
  visibility,
  data: jsonObject,
  text: z.string(),
  actorId: z.string(),
  actorKind: z.enum(['person', 'agent', 'system']),
  sourceKind: z.string(),
  sourceRef: z.string().nullable(),
  createdAt: z.string(),
});

export const linkOut = z.object({ id: z.number(), fromId: z.string(), toId: z.string(), kind: linkKind, data: jsonObject, createdBy: z.string(), createdAt: z.string() });

export const searchResultOut = z.object({
  entityId: z.string(),
  entityType,
  title: z.string(),
  containerId: z.string(),
  channelId: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
  chunkId: z.string(),
  docId: z.string(),
  snippet: z.string(),
  score: z.number(),
  matched: z.array(z.enum(['keyword', 'semantic'])),
  citation: z.object({ kind: z.enum(['post', 'entity']), url: z.string().optional(), postId: z.string().optional(), eventId: z.string().optional(), entityUrl: z.string() }),
  url: z.string(),
});

export const auditOut = z.object({
  id: z.number(),
  at: z.string(),
  actorId: z.string(),
  actorKind: z.enum(['person', 'agent', 'system']),
  action: z.string(),
  entityId: z.string().nullable(),
  containerId: z.string().nullable(),
  details: jsonObject,
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
});

// --- inputs ---

export const newContainerIn = z.object({
  kind: z.enum(['project', 'topic']),
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(48).optional(),
  ownerId: id.optional(),
  data: jsonObject.optional(),
  /** Link a Mattermost channel at once (its threads become the container's conversations). */
  channel: z.object({ mmChannelId: mmId, role: channelRole.default('home') }).optional(),
});

export const patchContainerIn = z.object({ title: z.string().trim().min(1).max(200).optional(), ownerId: id.nullable().optional(), data: jsonObject.optional() });

export const linkChannelIn = z.object({ mmChannelId: mmId, role: channelRole.default('linked') });

export const newEntityIn = z.object({
  type: entityType,
  title: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(50).optional(),
  ownerId: id.optional(),
  containerId: id,
  externalKey: z.string().min(1).max(500).optional(),
  visibility: visibility.optional(),
  data: jsonObject.optional(),
  text: z.string().max(500_000).optional(),
});

export const patchEntityIn = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  status: z.string().trim().min(1).max(50).optional(),
  ownerId: id.nullable().optional(),
  containerId: id.optional(),
  visibility: visibility.optional(),
  data: jsonObject.optional(),
  text: z.string().max(500_000).optional(),
});

export const newLinkIn = z.object({ fromId: id, toId: id, kind: linkKind, data: jsonObject.optional() });

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(1000),
  container: id.optional(),
  type: z.string().optional(),
  person: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// --- people (FR-2) ---

export const containerRole = z.enum(['sponsor', 'product_owner', 'end_user', 'developer', 'fde', 'reviewer', 'member', 'contact']);
const tags = z.array(z.string().trim().min(1).max(80)).max(50);
export const profilePatchIn = z.object({
  role: z.string().trim().max(120).optional(),
  organisation: z.string().trim().max(200).optional(),
  expertise: tags.optional(),
  responsibilities: tags.optional(),
  workingHours: z.string().trim().max(200).optional(),
  preferredChannel: z.string().trim().max(120).optional(),
  managerId: id.nullable().optional(),
});
export const externalContactIn = z.object({
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.email()).max(10).optional(),
  organisation: z.string().trim().max(200).optional(),
  role: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(5000).optional(),
});
export const memberIn = z.object({ personId: id, role: containerRole.default('member') });
export const memberOut = z.object({ person: entitySummaryOut, role: z.string(), linkId: z.number() });
export const whoKnowsOut = z.object({ person: entitySummaryOut, score: z.number(), evidence: z.array(z.object({ entityId: z.string(), title: z.string(), type: z.string(), why: z.string(), url: z.string() })) });

// --- projects and topics (FR-1) ---

export const milestoneIn = z.object({ title: z.string().trim().min(1).max(200), date: z.iso.date(), kind: z.enum(['milestone', 'phase']).default('milestone'), done: z.boolean().optional() });
export const projectIn = z.object({
  title: z.string().trim().min(1).max(200),
  client: z.string().trim().max(200).optional(),
  goal: z.string().trim().max(5000).optional(),
  scope: z.string().trim().max(5000).optional(),
  stage: z.string().trim().max(60).optional(),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().optional(),
  budget: z.string().trim().max(200).optional(),
  stakeholderIds: z.array(id).max(50).optional(),
  parentTopicId: id.optional(),
  channels: z.boolean().optional(),
  private: z.boolean().optional(),
  linkChannelIds: z.array(mmId).max(20).optional(),
});
export const topicIn = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['internal', 'external']).default('internal'),
  organisation: z.string().trim().max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  ownerId: id.optional(),
  contactIds: z.array(id).max(50).optional(),
  systemIds: z.array(id).max(50).optional(),
  channel: z.union([z.object({ mmChannelId: mmId }), z.object({ create: z.literal(true), name: z.string().trim().min(1).max(60).optional(), private: z.boolean().optional() })]),
});
export const homeOut = z.object({
  container: containerOut,
  owner: entitySummaryOut.nullable(),
  channels: z.array(z.object({ mmChannelId: z.string(), role: z.string() })),
  people: z.array(z.object({ person: entitySummaryOut, role: z.string() })),
  systems: z.array(entitySummaryOut),
  requirements: z.object({ open: z.number(), recent: z.array(entitySummaryOut) }),
  tasks: z.object({ open: z.number(), recent: z.array(entitySummaryOut) }),
  decisions: z.array(entitySummaryOut),
  documents: z.array(entitySummaryOut),
  conversations: z.array(entitySummaryOut),
  milestones: z.array(milestoneIn),
  package: z.object({ status: z.string(), note: z.string() }),
  stale: z.boolean(),
  spawnedFrom: containerOut.nullable(),
});

export const createAgentIn = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9._-]{2,21}$/, '3-22 characters: lowercase letters, digits, ".", "-", "_"'),
  name: z.string().trim().min(1).max(64),
  provider: z.enum(['anthropic', 'google', 'echo']).optional(),
  model: z.string().max(100).optional(),
  instructions: z.string().max(20_000).optional(),
  description: z.string().max(1024).optional(),
});

export const agentOut = z.object({ handle: z.string(), displayName: z.string(), provider: z.string(), model: z.string(), status: z.string(), mmBotUserId: z.string(), nostrPubkey: z.string() });

/** What Mattermost posts for a slash command (application/x-www-form-urlencoded; spike B1). */
export const commandBody = z.object({
  token: z.string(),
  team_id: z.string(),
  team_domain: z.string().optional(),
  channel_id: z.string(),
  channel_name: z.string().optional(),
  user_id: z.string(),
  user_name: z.string().optional(),
  command: z.string(),
  text: z.string().optional().default(''),
  trigger_id: z.string().optional(),
  response_url: z.string().optional(),
});

/** A dialog submission (JSON; spike B1). */
export const dialogBody = z.object({
  type: z.literal('dialog_submission').optional(),
  callback_id: z.string().optional(),
  state: z.string().optional().default(''),
  user_id: z.string(),
  channel_id: z.string(),
  team_id: z.string(),
  submission: z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])).default({}),
  cancelled: z.boolean().optional(),
});

/** A post action (button) call (JSON; spike B1). */
export const actionBody = z.object({
  user_id: z.string(),
  channel_id: z.string(),
  team_id: z.string(),
  post_id: z.string(),
  trigger_id: z.string().optional(),
  type: z.string().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
});
