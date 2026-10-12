// ChatClient: the only way our services talk to Mattermost (CLAUDE.md rule 6). REST v4 over fetch and
// the WebSocket event stream over Node's built-in WebSocket.
import { createHash } from 'node:crypto';
import { RateLimiter } from '../async.ts';
import type { Logger } from '../logger.ts';
import { metrics } from '../metrics.ts';
import { MattermostEventStream, type ChatEventHandlers, type ChatEventStream } from './events.ts';
import type { MmBot, MmChannel, MmCommand, MmDialog, MmFile, MmFileInfo, MmOAuthApp, MmOAuthTokens, MmPost, MmPostList, MmReaction, MmTeam, MmUser, NewChannel, NewCommand, NewOAuthApp, NewPost } from './types.ts';

export class ChatApiError extends Error {
  readonly status: number;
  readonly errorId: string | undefined;

  constructor(status: number, method: string, path: string, errorId?: string, message?: string) {
    super(`Mattermost ${method} ${path} returned ${status}${errorId ? ` (${errorId})` : ''}${message ? `: ${message}` : ''}`);
    this.status = status;
    this.errorId = errorId;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface ChatClient {
  readonly baseUrl: string;
  /** A client acting as another user or bot, with its access token. */
  withToken(token: string): ChatClient;
  getMe(): Promise<MmUser>;
  getUser(userId: string): Promise<MmUser | undefined>;
  getUsersByIds(userIds: string[]): Promise<MmUser[]>;
  getUsersByUsernames(usernames: string[]): Promise<MmUser[]>;
  getTeam(teamId: string): Promise<MmTeam>;
  getTeamByName(name: string): Promise<MmTeam | undefined>;
  getMyTeams(): Promise<MmTeam[]>;
  getMyChannels(teamId: string): Promise<MmChannel[]>;
  /** Channels another user belongs to in a team (needs the system admin role). */
  getUserChannels(userId: string, teamId: string): Promise<MmChannel[]>;
  getChannel(channelId: string): Promise<MmChannel | undefined>;
  getChannelMemberIds(channelId: string): Promise<string[]>;
  isChannelMember(channelId: string, userId: string): Promise<boolean>;
  addChannelMember(channelId: string, userId: string): Promise<void>;
  removeChannelMember(channelId: string, userId: string): Promise<void>;
  getPost(postId: string): Promise<MmPost | undefined>;
  /** Posts created, edited or deleted at or after `sinceMs`, oldest first. */
  getPostsSince(channelId: string, sinceMs: number): Promise<MmPost[]>;
  /** One page of a channel's posts, newest first (`perPage` at most 200). */
  getChannelPostsPage(channelId: string, page: number, perPage: number): Promise<MmPostList>;
  getThread(rootId: string): Promise<MmPost[]>;
  getFileInfos(postId: string): Promise<MmFileInfo[]>;
  createPost(post: NewPost): Promise<MmPost>;
  patchPost(postId: string, patch: { message: string }): Promise<MmPost>;
  deletePost(postId: string): Promise<void>;
  getReactions(postId: string): Promise<MmReaction[]>;
  addReaction(userId: string, postId: string, emojiName: string): Promise<MmReaction>;
  removeReaction(userId: string, postId: string, emojiName: string): Promise<void>;
  createBot(bot: { username: string; display_name: string; description?: string }): Promise<MmBot>;
  getBot(userId: string): Promise<MmBot | undefined>;
  disableBot(userId: string): Promise<void>;
  enableBot(userId: string): Promise<void>;
  createUserAccessToken(userId: string, description: string): Promise<string>;
  addTeamMember(teamId: string, userId: string): Promise<void>;
  /** Show "<user> is typing" in a channel (or thread) for a few seconds. */
  sendTyping(userId: string, channelId: string, parentId?: string): Promise<void>;
  permalink(teamName: string, postId: string): string;
  connectEvents(handlers: ChatEventHandlers, logger: Logger): ChatEventStream;

  // --- The brain's needs (docs/brain/01-phase0-plan.md section 10) ---

  /** A team's public channels, and with `includePrivate` its private ones too (system admin). */
  getTeamChannels(teamId: string, options?: { includePrivate?: boolean }): Promise<MmChannel[]>;
  getChannelByName(teamId: string, name: string): Promise<MmChannel | undefined>;
  createChannel(channel: NewChannel): Promise<MmChannel>;
  patchChannel(channelId: string, patch: { display_name?: string; header?: string; purpose?: string }): Promise<MmChannel>;
  createDirectChannel(userIdA: string, userIdB: string): Promise<MmChannel>;
  /** Download an attachment (spike B4). */
  getFile(fileId: string): Promise<MmFile>;
  /** A post only `userId` sees (system admins may send them; slash-command replies need no permission). */
  createEphemeralPost(userId: string, post: NewPost): Promise<MmPost>;
  pinPost(postId: string): Promise<void>;
  /** Custom slash commands of a team (spike B1). */
  listCommands(teamId: string): Promise<MmCommand[]>;
  createCommand(command: NewCommand): Promise<MmCommand>;
  updateCommand(id: string, command: NewCommand): Promise<MmCommand>;
  deleteCommand(id: string): Promise<void>;
  /** Open an interactive dialog for a fresh trigger id (valid for OutgoingIntegrationRequestsTimeout, spike B2). */
  openDialog(request: { trigger_id: string; url: string; dialog: MmDialog }): Promise<void>;
  /** OAuth 2.0 apps for which Mattermost is the provider (spike B3; system admin). */
  listOAuthApps(): Promise<MmOAuthApp[]>;
  createOAuthApp(app: NewOAuthApp): Promise<MmOAuthApp>;
  /** The authorization-code exchange at {MM_URL}/oauth/access_token (not under /api/v4). */
  exchangeOAuthCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<MmOAuthTokens>;
  /** Server configuration (system admin). */
  getConfig(): Promise<Record<string, unknown>>;
  patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MattermostChatClientOptions {
  timeoutMs?: number;
  /** Requests per second per token (each bot and the bridge get their own pace). */
  requestsPerSecond?: number;
  /** Shared by the clients `withToken` derives, so they pace together. */
  limiter?: RateLimiter;
}

export class MattermostChatClient implements ChatClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #limiter: RateLimiter;
  /** A token digest, so the limiter never holds the token itself. */
  readonly #limiterKey: string;

  constructor(baseUrl: string, token: string, options: MattermostChatClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.#token = token;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    const rate = options.requestsPerSecond ?? 20;
    this.#limiter = options.limiter ?? new RateLimiter(rate, Math.ceil(rate * 2));
    this.#limiterKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  withToken(token: string): ChatClient {
    return new MattermostChatClient(this.baseUrl, token, { timeoutMs: this.#timeoutMs, limiter: this.#limiter });
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const waitedMs = await this.#limiter.acquire(this.#limiterKey);
    if (waitedMs > 0) metrics.throttleWait.observe({ target: 'mattermost' }, waitedMs / 1000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'X-Requested-With': 'XMLHttpRequest',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      metrics.chatRequests.inc({ method, status: 'error' });
      throw new ChatApiError(0, method, path, undefined, error instanceof Error ? error.message : String(error));
    }
    metrics.chatRequests.inc({ method, status: String(response.status) });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const info = (parsed ?? {}) as { id?: string; message?: string };
      throw new ChatApiError(response.status, method, path, info.id, info.message);
    }
    return parsed as T;
  }

  async #find<T>(path: string): Promise<T | undefined> {
    try {
      return await this.#request<T>('GET', path);
    } catch (error) {
      if (error instanceof ChatApiError && (error.status === 404 || error.status === 403)) return undefined;
      throw error;
    }
  }

  getMe(): Promise<MmUser> {
    return this.#request('GET', '/users/me');
  }

  getUser(userId: string): Promise<MmUser | undefined> {
    return this.#find(`/users/${userId}`);
  }

  async getUsersByIds(userIds: string[]): Promise<MmUser[]> {
    return userIds.length === 0 ? [] : this.#request('POST', '/users/ids', userIds);
  }

  async getUsersByUsernames(usernames: string[]): Promise<MmUser[]> {
    return usernames.length === 0 ? [] : this.#request('POST', '/users/usernames', usernames);
  }

  getTeam(teamId: string): Promise<MmTeam> {
    return this.#request('GET', `/teams/${teamId}`);
  }

  getTeamByName(name: string): Promise<MmTeam | undefined> {
    return this.#find(`/teams/name/${encodeURIComponent(name)}`);
  }

  getMyTeams(): Promise<MmTeam[]> {
    return this.#request('GET', '/users/me/teams');
  }

  getMyChannels(teamId: string): Promise<MmChannel[]> {
    return this.#request('GET', `/users/me/teams/${teamId}/channels`);
  }

  getUserChannels(userId: string, teamId: string): Promise<MmChannel[]> {
    return this.#request('GET', `/users/${userId}/teams/${teamId}/channels`);
  }

  getChannel(channelId: string): Promise<MmChannel | undefined> {
    return this.#find(`/channels/${channelId}`);
  }

  async getChannelMemberIds(channelId: string): Promise<string[]> {
    const ids: string[] = [];
    const perPage = 200;
    for (let page = 0; ; page++) {
      const members = await this.#request<{ user_id: string }[]>('GET', `/channels/${channelId}/members?page=${page}&per_page=${perPage}`);
      ids.push(...members.map((member) => member.user_id));
      if (members.length < perPage) return ids;
    }
  }

  async isChannelMember(channelId: string, userId: string): Promise<boolean> {
    return (await this.#find(`/channels/${channelId}/members/${userId}`)) !== undefined;
  }

  async addChannelMember(channelId: string, userId: string): Promise<void> {
    await this.#request('POST', `/channels/${channelId}/members`, { user_id: userId });
  }

  async removeChannelMember(channelId: string, userId: string): Promise<void> {
    await this.#request('DELETE', `/channels/${channelId}/members/${userId}`);
  }

  getPost(postId: string): Promise<MmPost | undefined> {
    return this.#find(`/posts/${postId}?include_deleted=true`);
  }

  async getPostsSince(channelId: string, sinceMs: number): Promise<MmPost[]> {
    const result = await this.#request<{ order: string[]; posts: Record<string, MmPost> }>('GET', `/channels/${channelId}/posts?since=${sinceMs}`);
    return Object.values(result.posts ?? {}).sort((a, b) => a.create_at - b.create_at || a.update_at - b.update_at);
  }

  async getChannelPostsPage(channelId: string, page: number, perPage: number): Promise<MmPostList> {
    const result = await this.#request<Partial<MmPostList>>('GET', `/channels/${channelId}/posts?page=${page}&per_page=${perPage}`);
    return { order: result.order ?? [], posts: result.posts ?? {} };
  }

  async getFileInfos(postId: string): Promise<MmFileInfo[]> {
    return (await this.#request<MmFileInfo[] | null>('GET', `/posts/${postId}/files/info`)) ?? [];
  }

  async getThread(rootId: string): Promise<MmPost[]> {
    const result = await this.#request<{ order: string[]; posts: Record<string, MmPost> }>('GET', `/posts/${rootId}/thread`);
    return Object.values(result.posts ?? {}).sort((a, b) => a.create_at - b.create_at);
  }

  createPost(post: NewPost): Promise<MmPost> {
    return this.#request('POST', '/posts', post);
  }

  patchPost(postId: string, patch: { message: string }): Promise<MmPost> {
    return this.#request('PUT', `/posts/${postId}/patch`, patch);
  }

  async deletePost(postId: string): Promise<void> {
    await this.#request('DELETE', `/posts/${postId}`);
  }

  async getReactions(postId: string): Promise<MmReaction[]> {
    return (await this.#request<MmReaction[] | null>('GET', `/posts/${postId}/reactions`)) ?? [];
  }

  addReaction(userId: string, postId: string, emojiName: string): Promise<MmReaction> {
    return this.#request('POST', '/reactions', { user_id: userId, post_id: postId, emoji_name: emojiName });
  }

  async removeReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    await this.#request('DELETE', `/users/${userId}/posts/${postId}/reactions/${encodeURIComponent(emojiName)}`);
  }

  createBot(bot: { username: string; display_name: string; description?: string }): Promise<MmBot> {
    return this.#request('POST', '/bots', bot);
  }

  getBot(userId: string): Promise<MmBot | undefined> {
    return this.#find(`/bots/${userId}?include_deleted=true`);
  }

  async disableBot(userId: string): Promise<void> {
    await this.#request('POST', `/bots/${userId}/disable`);
  }

  async enableBot(userId: string): Promise<void> {
    await this.#request('POST', `/bots/${userId}/enable`);
  }

  async createUserAccessToken(userId: string, description: string): Promise<string> {
    return (await this.#request<{ token: string }>('POST', `/users/${userId}/tokens`, { description })).token;
  }

  async addTeamMember(teamId: string, userId: string): Promise<void> {
    await this.#request('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: userId });
  }

  async sendTyping(userId: string, channelId: string, parentId?: string): Promise<void> {
    await this.#request('POST', `/users/${userId}/typing`, { channel_id: channelId, ...(parentId ? { parent_id: parentId } : {}) });
  }

  permalink(teamName: string, postId: string): string {
    return `${this.baseUrl}/${teamName}/pl/${postId}`;
  }

  connectEvents(handlers: ChatEventHandlers, logger: Logger): ChatEventStream {
    return new MattermostEventStream(this.baseUrl, this.#token, handlers, logger);
  }

  async #pages<T>(path: string, perPage = 200): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; ; page++) {
      const items = (await this.#request<T[] | null>('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=${perPage}`)) ?? [];
      all.push(...items);
      if (items.length < perPage) return all;
    }
  }

  async getTeamChannels(teamId: string, options: { includePrivate?: boolean } = {}): Promise<MmChannel[]> {
    const channels = await this.#pages<MmChannel>(`/teams/${teamId}/channels`);
    if (options.includePrivate) channels.push(...(await this.#pages<MmChannel>(`/teams/${teamId}/channels/private`)));
    return channels;
  }

  getChannelByName(teamId: string, name: string): Promise<MmChannel | undefined> {
    return this.#find(`/teams/${teamId}/channels/name/${encodeURIComponent(name)}`);
  }

  createChannel(channel: NewChannel): Promise<MmChannel> {
    return this.#request('POST', '/channels', channel);
  }

  patchChannel(channelId: string, patch: { display_name?: string; header?: string; purpose?: string }): Promise<MmChannel> {
    return this.#request('PUT', `/channels/${channelId}/patch`, patch);
  }

  createDirectChannel(userIdA: string, userIdB: string): Promise<MmChannel> {
    return this.#request('POST', '/channels/direct', [userIdA, userIdB]);
  }

  async getFile(fileId: string): Promise<MmFile> {
    const waitedMs = await this.#limiter.acquire(this.#limiterKey);
    if (waitedMs > 0) metrics.throttleWait.observe({ target: 'mattermost' }, waitedMs / 1000);
    const response = await fetch(`${this.baseUrl}/api/v4/files/${fileId}`, { headers: { Authorization: `Bearer ${this.#token}`, 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(this.#timeoutMs) });
    metrics.chatRequests.inc({ method: 'GET', status: String(response.status) });
    if (!response.ok) throw new ChatApiError(response.status, 'GET', `/files/${fileId}`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
  }

  createEphemeralPost(userId: string, post: NewPost): Promise<MmPost> {
    return this.#request('POST', '/posts/ephemeral', { user_id: userId, post });
  }

  async pinPost(postId: string): Promise<void> {
    await this.#request('POST', `/posts/${postId}/pin`);
  }

  async listCommands(teamId: string): Promise<MmCommand[]> {
    return (await this.#request<MmCommand[] | null>('GET', `/commands?team_id=${teamId}&custom_only=true`)) ?? [];
  }

  createCommand(command: NewCommand): Promise<MmCommand> {
    return this.#request('POST', '/commands', command);
  }

  updateCommand(id: string, command: NewCommand): Promise<MmCommand> {
    return this.#request('PUT', `/commands/${id}`, { ...command, id });
  }

  async deleteCommand(id: string): Promise<void> {
    await this.#request('DELETE', `/commands/${id}`);
  }

  async openDialog(request: { trigger_id: string; url: string; dialog: MmDialog }): Promise<void> {
    await this.#request('POST', '/actions/dialogs/open', request);
  }

  listOAuthApps(): Promise<MmOAuthApp[]> {
    return this.#pages<MmOAuthApp>('/oauth/apps');
  }

  createOAuthApp(app: NewOAuthApp): Promise<MmOAuthApp> {
    return this.#request('POST', '/oauth/apps', app);
  }

  async exchangeOAuthCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<MmOAuthTokens> {
    const response = await fetch(`${this.baseUrl}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    metrics.chatRequests.inc({ method: 'POST', status: String(response.status) });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as MmOAuthTokens & { id?: string; message?: string };
    if (!response.ok) throw new ChatApiError(response.status, 'POST', '/oauth/access_token', parsed.id, parsed.message);
    return parsed;
  }

  getConfig(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/config');
  }

  patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#request('PUT', '/config/patch', patch);
  }
}
