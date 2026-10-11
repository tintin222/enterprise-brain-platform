// Building relay events from Mattermost data (docs/bridge-spec.md sections 4 and 5). Pure functions.
import { createHash } from 'node:crypto';
import type { MmChannel, MmPost, UnsignedEvent } from '@brain/shared';

/** The relay accepts created_at within ±900 s of its clock (spike A5); stay well inside that. */
export const ORIGINAL_TIMESTAMP_WINDOW_MS = 10 * 60 * 1000;

/** Mattermost's create time when it is recent enough for the relay, otherwise now (seconds). */
export function chooseCreatedAt(createAtMs: number, nowMs: number): number {
  const ms = Math.abs(nowMs - createAtMs) <= ORIGINAL_TIMESTAMP_WINDOW_MS ? createAtMs : nowMs;
  return Math.floor(ms / 1000);
}

/**
 * The text mirrored for a post: its message plus, when it has attachments, their names and the post's
 * permalink. Relay media cannot be shown to Mattermost clients (spike A12), so files stay in Mattermost.
 */
export function postContent(message: string, attachmentNames: string[], permalink: string): string {
  if (attachmentNames.length === 0) return message;
  const line = `📎 Attachments: ${attachmentNames.join(', ')} (${permalink})`;
  return message ? `${message}\n\n${line}` : line;
}

export interface PostEventInput {
  relayChannelId: string;
  post: Pick<MmPost, 'id' | 'message' | 'create_at'>;
  /** The mirrored text, when it differs from the message (attachments). */
  content?: string | undefined;
  /** Relay event id of the thread root, for replies. Mattermost threads are flat. */
  rootEventId?: string | undefined;
  mentionPubkeys: string[];
  /** Mirrored as history (backfill, or an old root fetched for a reply): agents must never answer it. */
  backfill?: boolean | undefined;
  nowMs: number;
}

export function buildPostEvent(input: PostEventInput): UnsignedEvent {
  const tags: string[][] = [['h', input.relayChannelId]];
  if (input.rootEventId) tags.push(['e', input.rootEventId, '', 'reply']);
  tags.push(['mm', input.post.id], ['mm_ts', String(input.post.create_at)]);
  for (const pubkey of new Set(input.mentionPubkeys)) tags.push(['p', pubkey]);
  if (input.backfill) tags.push(['backfill', '1']);
  return { kind: 9, tags, content: input.content ?? input.post.message, created_at: chooseCreatedAt(input.post.create_at, input.nowMs) };
}

export interface EditEventInput {
  relayChannelId: string;
  targetEventId: string;
  postId: string;
  content: string;
  /** Mattermost edit_at (ms): the message time of this version. */
  editAtMs: number;
  mentionPubkeys: string[];
  nowMs: number;
}

/** Kind 40003: the full new text of the target, signed by the target's author (spike A4). */
export function buildEditEvent(input: EditEventInput): UnsignedEvent {
  const tags: string[][] = [
    ['h', input.relayChannelId],
    ['e', input.targetEventId],
    ['mm', input.postId],
    ['mm_ts', String(input.editAtMs)],
  ];
  for (const pubkey of new Set(input.mentionPubkeys)) tags.push(['p', pubkey]);
  return { kind: 40003, tags, content: input.content, created_at: chooseCreatedAt(input.editAtMs, input.nowMs) };
}

/**
 * Deletion of one event. Kind 5 must be signed by the target's author; kind 9005 is the channel owner's
 * (the bridge's) moderation delete. The h tag lets channel subscriptions see the deletion.
 */
export function buildDeletionEvent(kind: 5 | 9005, relayChannelId: string, targetEventId: string, nowMs: number): UnsignedEvent {
  return { kind, tags: [['h', relayChannelId], ['e', targetEventId]], content: '', created_at: Math.floor(nowMs / 1000) };
}

export interface ReactionEventInput {
  relayChannelId: string;
  targetEventId: string;
  targetAuthorPubkey: string;
  /** An emoji character, or `:name:` for a custom emoji. */
  emoji: string;
  nowMs: number;
}

/** Kind 7 (NIP-25). The relay keeps one active reaction per author, target and emoji. */
export function buildReactionEvent(input: ReactionEventInput): UnsignedEvent {
  return {
    kind: 7,
    tags: [
      ['h', input.relayChannelId],
      ['e', input.targetEventId],
      ['p', input.targetAuthorPubkey],
    ],
    content: input.emoji,
    created_at: Math.floor(input.nowMs / 1000),
  };
}

export interface ChannelMetadata {
  name: string;
  /** The channel purpose and header, which agents read as channel background. */
  about: string;
  visibility: 'open' | 'private';
}

export function channelMetadata(channel: Pick<MmChannel, 'name' | 'display_name' | 'purpose' | 'header' | 'type'>): ChannelMetadata {
  return {
    name: channel.display_name.trim() || channel.name,
    about: [channel.purpose, channel.header]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n\n'),
    visibility: channel.type === 'P' ? 'private' : 'open',
  };
}

export function metadataHash(metadata: ChannelMetadata): string {
  return createHash('sha256').update(JSON.stringify([metadata.name, metadata.about, metadata.visibility])).digest('hex');
}

export interface ChannelEventInput extends ChannelMetadata {
  relayChannelId: string;
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

/** Kind 9002 with the current name, about text (an empty value clears it) and visibility. */
export function buildChannelMetadataEvent(input: ChannelEventInput): UnsignedEvent {
  return {
    kind: 9002,
    tags: [
      ['h', input.relayChannelId],
      ['name', input.name.trim() || input.relayChannelId],
      ['about', input.about],
      ['visibility', input.visibility],
    ],
    content: '',
    created_at: Math.floor(input.nowMs / 1000),
  };
}

/** Kind 9002 archiving or unarchiving a channel. An archived relay channel refuses every other event. */
export function buildArchiveEvent(relayChannelId: string, archived: boolean, nowMs: number): UnsignedEvent {
  return { kind: 9002, tags: [['h', relayChannelId], ['archived', String(archived)]], content: '', created_at: Math.floor(nowMs / 1000) };
}
