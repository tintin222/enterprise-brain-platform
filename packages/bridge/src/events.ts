// Building relay events from Mattermost data (docs/bridge-spec.md section 5). Pure functions.
import type { MmPost, UnsignedEvent } from '@brain/shared';

/** The relay accepts created_at within ±900 s of its clock (spike A5); stay well inside that. */
export const ORIGINAL_TIMESTAMP_WINDOW_MS = 10 * 60 * 1000;

/** Mattermost's create time when it is recent enough for the relay, otherwise now (seconds). */
export function chooseCreatedAt(createAtMs: number, nowMs: number): number {
  const ms = Math.abs(nowMs - createAtMs) <= ORIGINAL_TIMESTAMP_WINDOW_MS ? createAtMs : nowMs;
  return Math.floor(ms / 1000);
}

export interface PostEventInput {
  relayChannelId: string;
  post: Pick<MmPost, 'id' | 'message' | 'create_at'>;
  /** Relay event id of the thread root, for replies. Mattermost threads are flat. */
  rootEventId?: string | undefined;
  mentionPubkeys: string[];
  /** Mirrored as history (backfill, or an old root fetched for a reply): agents must never answer it. */
  backfill?: boolean;
  nowMs: number;
}

export function buildPostEvent(input: PostEventInput): UnsignedEvent {
  const tags: string[][] = [['h', input.relayChannelId]];
  if (input.rootEventId) tags.push(['e', input.rootEventId, '', 'reply']);
  tags.push(['mm', input.post.id], ['mm_ts', String(input.post.create_at)]);
  for (const pubkey of new Set(input.mentionPubkeys)) tags.push(['p', pubkey]);
  if (input.backfill) tags.push(['backfill', '1']);
  return { kind: 9, tags, content: input.post.message, created_at: chooseCreatedAt(input.post.create_at, input.nowMs) };
}

export interface ChannelEventInput {
  relayChannelId: string;
  name: string;
  visibility: 'open' | 'private';
  about?: string | undefined;
  nowMs: number;
}

/** Kind 9007 with a client-chosen channel id (D18). */
export function buildCreateChannelEvent(input: ChannelEventInput): UnsignedEvent {
  const tags = [
    ['h', input.relayChannelId],
    ['name', input.name.trim() || input.relayChannelId],
    ['visibility', input.visibility],
  ];
  if (input.about) tags.push(['about', input.about]);
  return { kind: 9007, tags, content: '', created_at: Math.floor(input.nowMs / 1000) };
}

export interface ProfileInput {
  username: string;
  displayName: string;
  pictureUrl: string;
}

/** Kind 0 content for a mirrored identity (spike A8). */
export function profileContent(input: ProfileInput): string {
  return JSON.stringify({ name: input.username, display_name: input.displayName, picture: input.pictureUrl });
}
