// The pages' client for the brain API: same-origin fetch with the header Mattermost-style CSRF needs, JSON in
// and out, and a sign-in redirect on 401.
export interface Me {
  principal: { kind: string; userId: string; username?: string; isAdmin?: boolean; personId?: string };
  features: Record<string, boolean>;
  publicUrl: string;
  chatUrl: string;
  timezone: string;
}

export interface Container {
  id: string;
  kind: 'project' | 'topic' | 'general';
  slug: string;
  title: string;
  status: 'active' | 'archived';
  ownerId: string | null;
  channelId: string | null;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ChannelLink {
  mmChannelId: string;
  relayChannelId: string;
  containerId: string;
  role: string;
  createdAt: string;
}

export interface EntitySummary {
  id: string;
  type: string;
  title: string;
  status: string;
  ownerId: string | null;
  containerId: string;
  channelId: string | null;
  visibility: string;
  data: Record<string, unknown>;
  version: number;
  sourceKind: string;
  sourceRef: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  url: string;
}

export interface Entity extends EntitySummary {
  text: string;
}

export interface Version {
  entityId: string;
  version: number;
  title: string;
  status: string;
  ownerId: string | null;
  containerId: string;
  visibility: string;
  data: Record<string, unknown>;
  text: string;
  actorId: string;
  actorKind: string;
  sourceKind: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface Link {
  id: number;
  fromId: string;
  toId: string;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface SearchResult {
  entityId: string;
  entityType: string;
  title: string;
  containerId: string;
  channelId: string | null;
  version: number;
  updatedAt: string;
  chunkId: string;
  docId: string;
  snippet: string;
  score: number;
  matched: ('keyword' | 'semantic')[];
  citation: { kind: 'post' | 'entity'; url?: string; postId?: string; entityUrl: string };
  url: string;
}

export interface Member {
  person: EntitySummary;
  role: string;
  linkId: number;
}

export interface WhoKnows {
  person: EntitySummary;
  score: number;
  evidence: { entityId: string; title: string; type: string; why: string; url: string }[];
}

export interface PersonDetail {
  person: Entity;
  memberships: { containerId: string; role: string; title: string; kind: string }[];
  suggestions: { kind: string; value: string; by: string; at: string; reason?: string }[];
}

export interface Milestone {
  title: string;
  date: string;
  kind: 'milestone' | 'phase';
  done?: boolean;
}

export interface Home {
  container: Container;
  owner: EntitySummary | null;
  channels: { mmChannelId: string; role: string }[];
  people: { person: EntitySummary; role: string }[];
  systems: EntitySummary[];
  requirements: { open: number; recent: EntitySummary[] };
  tasks: { open: number; recent: EntitySummary[] };
  decisions: EntitySummary[];
  documents: EntitySummary[];
  conversations: EntitySummary[];
  milestones: Milestone[];
  package: { status: string; note: string };
  stale: boolean;
  spawnedFrom: Container | null;
}

export interface MyChannel {
  id: string;
  name: string;
  display_name: string;
  type: string;
  containerId: string | null;
}

export interface SystemView {
  system: Entity;
  artifacts: EntitySummary[];
  integrations: { link: Link; other: EntitySummary; direction: 'outgoing' | 'incoming' }[];
  containers: Container[];
}

export interface Diff {
  from: number;
  to: number;
  title: { before: string; after: string } | null;
  fields: { field: string; before: unknown; after: unknown }[];
  text: { changed: boolean; hunks: { kind: 'same' | 'added' | 'removed'; text: string }[][] };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE = '/api/v1/brain';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-Requested-With': 'XMLHttpRequest', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    window.location.assign(`/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(401, 'Sign in first');
  }
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = body as { error?: string } | null;
    throw new ApiError(response.status, error?.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export const brain = {
  me: () => api<Me>('/me'),
  containers: (params: Record<string, string> = {}) => api<{ containers: Container[] }>(`/containers?${new URLSearchParams(params)}`),
  container: (id: string) => api<{ container: Container; channels: ChannelLink[]; counts: Record<string, number> }>(`/containers/${encodeURIComponent(id)}`),
  createContainer: (body: { kind: 'project' | 'topic'; title: string }) => api<{ container: Container }>('/containers', { method: 'POST', body: JSON.stringify(body) }),
  archiveContainer: (id: string) => api<{ container: Container }>(`/containers/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  containerEntities: (id: string, params: Record<string, string> = {}) => api<{ entities: EntitySummary[] }>(`/containers/${encodeURIComponent(id)}/entities?${new URLSearchParams(params)}`),
  entities: (params: Record<string, string> = {}) => api<{ entities: EntitySummary[] }>(`/entities?${new URLSearchParams(params)}`),
  entity: (id: string) => api<{ entity: Entity; container: Container }>(`/entities/${encodeURIComponent(id)}`),
  createEntity: (body: { type: string; title: string; containerId: string; text?: string }) => api<{ entity: Entity }>('/entities', { method: 'POST', body: JSON.stringify(body) }),
  updateEntity: (id: string, body: { title?: string; status?: string; text?: string }) => api<{ entity: Entity }>(`/entities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveEntity: (id: string) => api<{ entity: Entity }>(`/entities/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  versions: (id: string) => api<{ versions: Version[] }>(`/entities/${encodeURIComponent(id)}/versions`),
  links: (id: string) => api<{ outgoing: Link[]; incoming: Link[] }>(`/entities/${encodeURIComponent(id)}/links`),
  backlinks: (id: string) => api<{ links: Link[]; mentions: SearchResult[] }>(`/entities/${encodeURIComponent(id)}/backlinks`),
  search: (params: Record<string, string>) => api<{ results: SearchResult[]; semantic: boolean; tookMs: number; facets: { types: Record<string, number>; containers: Record<string, number> } }>(`/search?${new URLSearchParams(params)}`),
  // Projects and Topics (FR-1)
  home: (id: string) => api<Home>(`/containers/${encodeURIComponent(id)}/home`),
  createProject: (body: Record<string, unknown>) => api<{ container: Container; channels: { id: string; name: string }[] }>('/projects', { method: 'POST', body: JSON.stringify(body) }),
  spawnProject: (topicId: string, body: Record<string, unknown>) => api<{ container: Container; channels: { id: string; name: string }[] }>(`/projects/from-topic/${encodeURIComponent(topicId)}`, { method: 'POST', body: JSON.stringify(body) }),
  createTopic: (body: Record<string, unknown>) => api<{ container: Container; channel: { id: string; name: string } }>('/topics', { method: 'POST', body: JSON.stringify(body) }),
  moveItems: (topicId: string, body: { projectId: string; entityIds: string[]; mode: 'move' | 'link' }) => api<{ moved: string[]; linked: string[]; skipped: string[] }>(`/topics/${encodeURIComponent(topicId)}/move-items`, { method: 'POST', body: JSON.stringify(body) }),
  setTimeline: (id: string, milestones: Milestone[]) => api<{ container: Container }>(`/containers/${encodeURIComponent(id)}/timeline`, { method: 'PATCH', body: JSON.stringify({ milestones }) }),
  myChannels: () => api<{ channels: MyChannel[] }>('/me/channels'),
  // Systems (FR-3)
  systems: (params: Record<string, string> = {}) => api<{ systems: EntitySummary[] }>(`/systems?${new URLSearchParams(params)}`),
  system: (id: string) => api<SystemView>(`/systems/${encodeURIComponent(id)}`),
  createSystem: (body: Record<string, unknown>) => api<{ system: Entity }>('/systems', { method: 'POST', body: JSON.stringify(body) }),
  updateSystem: (id: string, body: Record<string, unknown>) => api<{ system: Entity }>(`/systems/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  linkSystem: (id: string, containerId: string) => api<{ link: Link }>(`/systems/${encodeURIComponent(id)}/containers`, { method: 'POST', body: JSON.stringify({ containerId }) }),
  addIntegration: (id: string, body: Record<string, unknown>) => api<{ link: Link }>(`/systems/${encodeURIComponent(id)}/integrations`, { method: 'POST', body: JSON.stringify(body) }),
  diff: (id: string, a: number, b: number) => api<Diff>(`/entities/${encodeURIComponent(id)}/versions/${a}/diff/${b}`),
  // Tasks (FR-11)
  containerTasks: (containerId: string) => api<{ tasks: EntitySummary[] }>(`/containers/${encodeURIComponent(containerId)}/tasks`),
  myTasks: (includeClosed = false) => api<{ tasks: EntitySummary[] }>(`/tasks/mine?includeClosed=${includeClosed}`),
  createTask: (body: Record<string, unknown>) => api<{ task: Entity }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTask: (id: string, body: Record<string, unknown>) => api<{ task: Entity }>(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  commentTask: (id: string, text: string) => api<{ task: Entity }>(`/tasks/${encodeURIComponent(id)}/comments`, { method: 'POST', body: JSON.stringify({ text }) }),
  decideTask: (id: string, decision: 'accept' | 'edit' | 'dismiss', body?: Record<string, unknown>) => api<{ task: Entity }>(`/tasks/${encodeURIComponent(id)}/${decision}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
  // Documents (FR-5)
  documents: (params: Record<string, string> = {}) => api<{ documents: EntitySummary[] }>(`/documents?${new URLSearchParams(params)}`),
  uploadDocument: async (file: File, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', file, file.name);
    const response = await fetch(`${BASE}/documents`, { method: 'POST', body: form, headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' });
    const body = (await response.json().catch(() => null)) as { document?: Entity; error?: string } | null;
    if (!response.ok) throw new ApiError(response.status, body?.error ?? `HTTP ${response.status}`);
    return body as { document: Entity; created: boolean };
  },
  documentText: (id: string) => api<{ text: string; extracted: Record<string, unknown> }>(`/documents/${encodeURIComponent(id)}/text`),
  documentFileUrl: (id: string) => `${BASE}/documents/${encodeURIComponent(id)}/file`,
  setDocumentFlags: (id: string, body: Record<string, unknown>) => api<{ document: Entity }>(`/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  extractDocument: (id: string) => api<{ extracted: Record<string, unknown> }>(`/documents/${encodeURIComponent(id)}/extract`, { method: 'POST' }),
  // People (FR-2)
  people: (params: Record<string, string> = {}) => api<{ people: EntitySummary[] }>(`/people?${new URLSearchParams(params)}`),
  person: (id: string) => api<PersonDetail>(`/people/${encodeURIComponent(id)}`),
  createExternalContact: (body: { name: string; emails?: string[]; organisation?: string; role?: string; notes?: string }) => api<{ person: Entity }>('/people', { method: 'POST', body: JSON.stringify(body) }),
  updateProfile: (id: string, body: Record<string, unknown>) => api<{ person: Entity }>(`/people/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  decideSuggestion: (id: string, n: number, decision: 'confirm' | 'dismiss') => api<{ person: Entity }>(`/people/${encodeURIComponent(id)}/suggestions/${n}/${decision}`, { method: 'POST' }),
  whoKnows: (q: string) => api<{ people: WhoKnows[]; semantic: boolean }>(`/people/search?q=${encodeURIComponent(q)}`),
  members: (containerId: string) => api<{ members: Member[] }>(`/containers/${encodeURIComponent(containerId)}/members`),
  addMember: (containerId: string, body: { personId: string; role: string }) => api<{ link: Link }>(`/containers/${encodeURIComponent(containerId)}/members`, { method: 'POST', body: JSON.stringify(body) }),
  removeMember: (containerId: string, personId: string) => api<{ removed: boolean }>(`/containers/${encodeURIComponent(containerId)}/members/${encodeURIComponent(personId)}`, { method: 'DELETE' }),
};

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  window.location.assign('/');
}
