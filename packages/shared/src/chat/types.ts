// Mattermost REST v4 and WebSocket shapes used by our services (verified in Phase 0, spikes A10 and A11).

export interface MmUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  email?: string;
  position?: string;
  roles: string;
  is_bot?: boolean;
  delete_at: number;
}

export interface MmTeam {
  id: string;
  name: string;
  display_name: string;
}

/** O = open, P = private, D = direct message, G = group message. */
export type MmChannelType = 'O' | 'P' | 'D' | 'G';

export interface MmChannel {
  id: string;
  team_id: string;
  type: MmChannelType;
  name: string;
  display_name: string;
  header: string;
  purpose: string;
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
  file_ids?: string[];
  has_reactions?: boolean;
  /** Included in REST responses and in `posted` events (files only there). */
  metadata?: { files?: MmFileInfo[]; reactions?: MmReaction[] };
}

export interface MmFileInfo {
  id: string;
  name: string;
  mime_type?: string;
  size?: number;
}

/** One page of a channel's posts: `order` lists the page's posts newest first; `posts` may hold more (thread roots). */
export interface MmPostList {
  order: string[];
  posts: Record<string, MmPost>;
}

export interface NewPost {
  channel_id: string;
  message: string;
  root_id?: string;
  props?: Record<string, unknown>;
}

export interface MmReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
  delete_at?: number;
}

export interface MmBot {
  user_id: string;
  username: string;
  display_name: string;
  delete_at: number;
}

export interface NewChannel {
  team_id: string;
  name: string;
  display_name: string;
  type: 'O' | 'P';
  purpose?: string;
  header?: string;
}

/** A downloaded attachment. */
export interface MmFile {
  bytes: Uint8Array;
  contentType: string | null;
}

/** A custom slash command (Mattermost integrations; spike B1). The token authenticates Mattermost's calls to us. */
export interface MmCommand {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  method: string;
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  display_name?: string;
  description?: string;
  username?: string;
  icon_url?: string;
  delete_at?: number;
}

export interface NewCommand {
  team_id: string;
  trigger: string;
  method: 'P' | 'G';
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  display_name?: string;
  description?: string;
  username?: string;
  icon_url?: string;
}

/** An interactive dialog (a form Mattermost shows for a trigger id; spike B1). */
export interface MmDialogElement {
  display_name: string;
  name: string;
  type: 'text' | 'textarea' | 'select' | 'bool' | 'radio';
  subtype?: 'text' | 'email' | 'number' | 'password' | 'tel' | 'url';
  placeholder?: string;
  help_text?: string;
  optional?: boolean;
  min_length?: number;
  max_length?: number;
  default?: string | boolean;
  options?: { text: string; value: string }[];
  data_source?: 'users' | 'channels';
}

export interface MmDialog {
  callback_id: string;
  title: string;
  introduction_text?: string;
  elements: MmDialogElement[];
  submit_label?: string;
  notify_on_cancel?: boolean;
  state?: string;
}

/** An OAuth 2.0 app registered with Mattermost as the provider (spike B3). */
export interface MmOAuthApp {
  id: string;
  client_secret: string;
  name: string;
  description?: string;
  callback_urls: string[];
  homepage: string;
  is_trusted: boolean;
  delete_at?: number;
}

export interface NewOAuthApp {
  name: string;
  description?: string;
  callback_urls: string[];
  homepage: string;
  is_trusted: boolean;
}

export interface MmOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** One frame from the Mattermost WebSocket. */
export interface ChatEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: { channel_id?: string; user_id?: string; team_id?: string };
  seq: number;
}
