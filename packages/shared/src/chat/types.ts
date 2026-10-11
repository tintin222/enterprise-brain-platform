// Mattermost REST v4 and WebSocket shapes used by our services (verified in Phase 0, spikes A10 and A11).

export interface MmUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  email?: string;
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
  metadata?: { files?: { id: string; name: string }[] };
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
}

export interface MmBot {
  user_id: string;
  username: string;
  display_name: string;
  delete_at: number;
}

/** One frame from the Mattermost WebSocket. */
export interface ChatEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: { channel_id?: string; user_id?: string; team_id?: string };
  seq: number;
}
