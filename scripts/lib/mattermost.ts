// Minimal Mattermost REST v4 and WebSocket helpers for scripts. Product code uses ChatClient (CLAUDE.md rule 6).

export class MattermostError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, method: string, path: string, body: unknown) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export interface MmUser {
  id: string;
  username: string;
  roles: string;
  is_bot?: boolean;
  delete_at: number;
}

export interface MmPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  type: string;
  create_at: number;
  update_at: number;
  edit_at: number;
  delete_at: number;
  props?: Record<string, unknown>;
}

export class MattermostApi {
  readonly baseUrl: string;
  readonly token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  withToken(token: string): MattermostApi {
    return new MattermostApi(this.baseUrl, token);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new MattermostError(response.status, method, path, parsed);
    return parsed as T;
  }

  raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body ?? {});
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** POST one file as multipart form data under `field` (for example the brand image). */
  async upload<T>(path: string, field: string, data: Uint8Array<ArrayBuffer>, filename: string, type: string): Promise<T> {
    const form = new FormData();
    form.append(field, new Blob([data], { type }), filename);
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}/api/v4${path}`, { method: 'POST', headers, body: form });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new MattermostError(response.status, 'POST', path, parsed);
    return parsed as T;
  }

  /** GET that maps 404 to undefined. */
  async find<T>(path: string): Promise<T | undefined> {
    try {
      return await this.get<T>(path);
    } catch (error) {
      if (error instanceof MattermostError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Log in with a password; returns an API client carrying the session token. */
  async login(loginId: string, password: string): Promise<MattermostApi> {
    const response = await this.raw('POST', '/users/login', { login_id: loginId, password });
    if (!response.ok) throw new MattermostError(response.status, 'POST', '/users/login', await response.json().catch(() => null));
    const token = response.headers.get('Token');
    if (!token) throw new Error('Mattermost login returned no Token header');
    return this.withToken(token);
  }
}

export interface MmSocketEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: Record<string, unknown>;
  seq: number;
}

/** A Mattermost WebSocket session that records every event it receives. */
export class MattermostSocket {
  readonly events: MmSocketEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (message: MessageEvent) => {
      const frame = JSON.parse(String(message.data)) as Partial<MmSocketEvent>;
      if (typeof frame.event === 'string') this.events.push(frame as MmSocketEvent);
      for (const wake of this.waiters) wake();
    });
  }

  static async connect(baseUrl: string, token: string, timeoutMs = 15_000): Promise<MattermostSocket> {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Mattermost WebSocket failed to open')), { once: true });
    });
    const session = new MattermostSocket(socket);
    socket.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }));
    await session.waitFor((event) => event.event === 'hello', timeoutMs);
    return session;
  }

  /** Resolve with the first recorded event (past or future) that matches. */
  waitFor(match: (event: MmSocketEvent) => boolean, timeoutMs: number): Promise<MmSocketEvent> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.events.find(match);
        if (!found) return false;
        cleanup();
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No matching Mattermost event within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      const wake = (): void => void check();
      this.waiters.add(wake);
      check();
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** The post object inside a `posted` / `post_edited` event (Mattermost sends it as a JSON string). */
export function eventPost(event: MmSocketEvent): MmPost {
  return JSON.parse(String(event.data.post)) as MmPost;
}
