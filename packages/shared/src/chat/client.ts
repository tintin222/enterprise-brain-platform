// ChatClient: the only way our services talk to Mattermost (CLAUDE.md rule 6). REST v4 over fetch and
// the WebSocket event stream over Node's built-in WebSocket.
import type { Logger } from '../logger.ts';
import { MattermostEventStream, type ChatEventHandlers, type ChatEventStream } from './events.ts';
import type { MmBot, MmChannel, MmFileInfo, MmPost, MmPostList, MmReaction, MmTeam, MmUser, NewPost } from './types.ts';

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
}

export class MattermostChatClient implements ChatClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, token: string, timeoutMs = 15_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  withToken(token: string): ChatClient {
    return new MattermostChatClient(this.baseUrl, token, this.#timeoutMs);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      throw new ChatApiError(0, method, path, undefined, error instanceof Error ? error.message : String(error));
    }
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
}
