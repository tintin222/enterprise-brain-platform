// The pages' client for the brain API: same-origin fetch with the header Mattermost-style CSRF needs, JSON in
// and out, and a sign-in redirect on 401.
export interface Me {
  principal: { kind: string; userId: string; username?: string; isAdmin?: boolean };
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
  search: (params: Record<string, string>) => api<{ results: SearchResult[]; semantic: boolean; tookMs: number }>(`/search?${new URLSearchParams(params)}`),
};

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  window.location.assign('/');
}
