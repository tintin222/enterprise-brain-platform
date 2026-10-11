// Bridge state tables (docs/bridge-spec.md section 3).
import path from 'node:path';
import type { NostrEvent, Queryable } from '@brain/shared';

export const BRIDGE_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

export type ChannelState = 'active' | 'paused' | 'archived';
export type Visibility = 'open' | 'private';
export type Origin = 'mm' | 'relay';

export interface ChannelRow {
  mmChannelId: string;
  mmTeamId: string;
  relayChannelId: string;
  visibility: Visibility;
  state: ChannelState;
  enabledAt: Date;
  metadataHash: string | null;
}

export interface MessageRow {
  relayEventId: string;
  mmPostId: string | null;
  origin: Origin;
  mmChannelId: string;
  authorMmUserId: string;
}

export interface MessageState extends MessageRow {
  mmEditAt: number;
  relayEditAt: number;
  relayEditId: string | null;
  deletedAt: Date | null;
}

export interface ReactionRow {
  mmPostId: string;
  mmUserId: string;
  emoji: string;
  emojiName: string;
  relayEventId: string;
  origin: Origin;
  mmChannelId: string;
}

export interface OutboxRow {
  relayEventId: string;
  purpose: string;
  mmPostId: string | null;
  mmChannelId: string;
  authorMmUserId: string;
  signedEvent: NostrEvent;
  attempts: number;
  meta: Record<string, unknown>;
}

interface ChannelDbRow {
  mm_channel_id: string;
  mm_team_id: string;
  relay_channel_id: string;
  visibility: Visibility;
  state: ChannelState;
  enabled_at: Date;
  metadata_hash: string | null;
}

interface MessageDbRow {
  relay_event_id: string;
  mm_post_id: string | null;
  origin: Origin;
  mm_channel_id: string;
  author_mm_user_id: string;
  mm_edit_at: string;
  relay_edit_at: string;
  relay_edit_id: string | null;
  deleted_at: Date | null;
}

interface ReactionDbRow {
  mm_post_id: string;
  mm_user_id: string;
  emoji: string;
  emoji_name: string;
  relay_event_id: string;
  origin: Origin;
  mm_channel_id: string;
}

interface OutboxDbRow {
  relay_event_id: string;
  purpose: string;
  mm_post_id: string | null;
  mm_channel_id: string;
  author_mm_user_id: string;
  signed_event: NostrEvent;
  attempts: number;
  meta: Record<string, unknown>;
}

const toChannel = (r: ChannelDbRow): ChannelRow => ({
  mmChannelId: r.mm_channel_id,
  mmTeamId: r.mm_team_id,
  relayChannelId: r.relay_channel_id,
  visibility: r.visibility,
  state: r.state,
  enabledAt: r.enabled_at,
  metadataHash: r.metadata_hash,
});

const toMessage = (r: MessageDbRow): MessageState => ({
  relayEventId: r.relay_event_id,
  mmPostId: r.mm_post_id,
  origin: r.origin,
  mmChannelId: r.mm_channel_id,
  authorMmUserId: r.author_mm_user_id,
  mmEditAt: Number(r.mm_edit_at),
  relayEditAt: Number(r.relay_edit_at),
  relayEditId: r.relay_edit_id,
  deletedAt: r.deleted_at,
});

const toReaction = (r: ReactionDbRow): ReactionRow => ({
  mmPostId: r.mm_post_id,
  mmUserId: r.mm_user_id,
  emoji: r.emoji,
  emojiName: r.emoji_name,
  relayEventId: r.relay_event_id,
  origin: r.origin,
  mmChannelId: r.mm_channel_id,
});

const toOutbox = (r: OutboxDbRow): OutboxRow => ({
  relayEventId: r.relay_event_id,
  purpose: r.purpose,
  mmPostId: r.mm_post_id,
  mmChannelId: r.mm_channel_id,
  authorMmUserId: r.author_mm_user_id,
  signedEvent: r.signed_event,
  attempts: r.attempts,
  meta: r.meta,
});

const CHANNEL_COLUMNS = 'mm_channel_id, mm_team_id, relay_channel_id, visibility, state, enabled_at, metadata_hash';
const MESSAGE_COLUMNS = 'relay_event_id, mm_post_id, origin, mm_channel_id, author_mm_user_id, mm_edit_at, relay_edit_at, relay_edit_id, deleted_at';
const REACTION_COLUMNS = 'mm_post_id, mm_user_id, emoji, emoji_name, relay_event_id, origin, mm_channel_id';
const OUTBOX_COLUMNS = 'relay_event_id, purpose, mm_post_id, mm_channel_id, author_mm_user_id, signed_event, attempts, meta';

export class BridgeStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  // --- channels ---

  async getChannel(mmChannelId: string): Promise<ChannelRow | undefined> {
    const r = await this.#db.query<ChannelDbRow>(`SELECT ${CHANNEL_COLUMNS} FROM bridge.channel_map WHERE mm_channel_id = $1`, [mmChannelId]);
    return r.rows[0] ? toChannel(r.rows[0]) : undefined;
  }

  async getChannelByRelayId(relayChannelId: string): Promise<ChannelRow | undefined> {
    const r = await this.#db.query<ChannelDbRow>(`SELECT ${CHANNEL_COLUMNS} FROM bridge.channel_map WHERE relay_channel_id = $1`, [relayChannelId]);
    return r.rows[0] ? toChannel(r.rows[0]) : undefined;
  }

  async listChannels(state?: ChannelState): Promise<ChannelRow[]> {
    const r = state
      ? await this.#db.query<ChannelDbRow>(`SELECT ${CHANNEL_COLUMNS} FROM bridge.channel_map WHERE state = $1`, [state])
      : await this.#db.query<ChannelDbRow>(`SELECT ${CHANNEL_COLUMNS} FROM bridge.channel_map`);
    return r.rows.map(toChannel);
  }

  /** Insert or re-activate a channel. `enabled_at` is reset when the channel was not already active. */
  async activateChannel(row: Pick<ChannelRow, 'mmChannelId' | 'mmTeamId' | 'relayChannelId' | 'visibility' | 'metadataHash'>, db: Queryable = this.#db): Promise<ChannelRow> {
    const r = await db.query<ChannelDbRow>(
      `INSERT INTO bridge.channel_map (mm_channel_id, mm_team_id, relay_channel_id, visibility, state, metadata_hash)
       VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (mm_channel_id) DO UPDATE SET
         state = 'active',
         visibility = EXCLUDED.visibility,
         metadata_hash = EXCLUDED.metadata_hash,
         enabled_at = CASE WHEN bridge.channel_map.state = 'active' THEN bridge.channel_map.enabled_at ELSE now() END,
         updated_at = now()
       RETURNING ${CHANNEL_COLUMNS}`,
      [row.mmChannelId, row.mmTeamId, row.relayChannelId, row.visibility, row.metadataHash],
    );
    return toChannel(r.rows[0]!);
  }

  async setChannelState(mmChannelId: string, state: ChannelState): Promise<void> {
    await this.#db.query('UPDATE bridge.channel_map SET state = $2, updated_at = now() WHERE mm_channel_id = $1', [mmChannelId, state]);
  }

  async setChannelMetadata(mmChannelId: string, visibility: Visibility, metadataHash: string): Promise<void> {
    await this.#db.query('UPDATE bridge.channel_map SET visibility = $2, metadata_hash = $3, updated_at = now() WHERE mm_channel_id = $1', [mmChannelId, visibility, metadataHash]);
  }

  // --- messages ---

  async getMessageByPost(mmPostId: string): Promise<MessageState | undefined> {
    const r = await this.#db.query<MessageDbRow>(`SELECT ${MESSAGE_COLUMNS} FROM bridge.message_map WHERE mm_post_id = $1`, [mmPostId]);
    return r.rows[0] ? toMessage(r.rows[0]) : undefined;
  }

  async getMessageByEvent(relayEventId: string): Promise<MessageState | undefined> {
    const r = await this.#db.query<MessageDbRow>(`SELECT ${MESSAGE_COLUMNS} FROM bridge.message_map WHERE relay_event_id = $1`, [relayEventId]);
    return r.rows[0] ? toMessage(r.rows[0]) : undefined;
  }

  /** Returns false when the event or post is already mapped (unique constraint). */
  async insertMessage(row: MessageRow & { mmEditAt?: number }, db: Queryable = this.#db): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO bridge.message_map (relay_event_id, mm_post_id, origin, mm_channel_id, author_mm_user_id, mm_edit_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [row.relayEventId, row.mmPostId, row.origin, row.mmChannelId, row.authorMmUserId, row.mmEditAt ?? 0],
    );
    return r.rowCount === 1;
  }

  async setMessagePost(relayEventId: string, mmPostId: string, db: Queryable = this.#db): Promise<void> {
    await db.query('UPDATE bridge.message_map SET mm_post_id = $2 WHERE relay_event_id = $1', [relayEventId, mmPostId]);
  }

  /** Record that the relay has the Mattermost text as of `editAt` (never moves backwards). */
  async setMessageEditedInMm(relayEventId: string, editAt: number, db: Queryable = this.#db): Promise<void> {
    await db.query('UPDATE bridge.message_map SET mm_edit_at = GREATEST(mm_edit_at, $2) WHERE relay_event_id = $1', [relayEventId, editAt]);
  }

  /** Record an agent edit applied in Mattermost. */
  async setMessageEditedOnRelay(relayEventId: string, editCreatedAt: number, editEventId: string, db: Queryable = this.#db): Promise<void> {
    await db.query('UPDATE bridge.message_map SET relay_edit_at = $2, relay_edit_id = $3 WHERE relay_event_id = $1', [relayEventId, editCreatedAt, editEventId]);
  }

  async markMessageDeleted(relayEventId: string, db: Queryable = this.#db): Promise<void> {
    await db.query('UPDATE bridge.message_map SET deleted_at = COALESCE(deleted_at, now()) WHERE relay_event_id = $1', [relayEventId]);
  }

  // --- reactions ---

  async listReactions(mmPostId: string, origin: Origin): Promise<ReactionRow[]> {
    const r = await this.#db.query<ReactionDbRow>(`SELECT ${REACTION_COLUMNS} FROM bridge.reaction_map WHERE mm_post_id = $1 AND origin = $2`, [mmPostId, origin]);
    return r.rows.map(toReaction);
  }

  async getReactionByEvent(relayEventId: string): Promise<ReactionRow | undefined> {
    const r = await this.#db.query<ReactionDbRow>(`SELECT ${REACTION_COLUMNS} FROM bridge.reaction_map WHERE relay_event_id = $1`, [relayEventId]);
    return r.rows[0] ? toReaction(r.rows[0]) : undefined;
  }

  /** Returns false when the reaction is already mapped. */
  async insertReaction(row: ReactionRow, db: Queryable = this.#db): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO bridge.reaction_map (mm_post_id, mm_user_id, emoji, emoji_name, relay_event_id, origin, mm_channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [row.mmPostId, row.mmUserId, row.emoji, row.emojiName, row.relayEventId, row.origin, row.mmChannelId],
    );
    return r.rowCount === 1;
  }

  async deleteReaction(key: Pick<ReactionRow, 'mmPostId' | 'mmUserId' | 'emoji'>, db: Queryable = this.#db): Promise<void> {
    await db.query('DELETE FROM bridge.reaction_map WHERE mm_post_id = $1 AND mm_user_id = $2 AND emoji = $3', [key.mmPostId, key.mmUserId, key.emoji]);
  }

  // --- outbox ---

  async insertOutbox(row: Omit<OutboxRow, 'attempts' | 'meta'> & { meta?: Record<string, unknown> }, db: Queryable = this.#db): Promise<void> {
    await db.query(
      `INSERT INTO bridge.relay_outbox (relay_event_id, purpose, mm_post_id, mm_channel_id, author_mm_user_id, signed_event, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [row.relayEventId, row.purpose, row.mmPostId, row.mmChannelId, row.authorMmUserId, JSON.stringify(row.signedEvent), JSON.stringify(row.meta ?? {})],
    );
  }

  async getOutboxForPost(mmPostId: string, purpose: string): Promise<OutboxRow | undefined> {
    const r = await this.#db.query<OutboxDbRow>(`SELECT ${OUTBOX_COLUMNS} FROM bridge.relay_outbox WHERE mm_post_id = $1 AND purpose = $2 ORDER BY created_at LIMIT 1`, [mmPostId, purpose]);
    return r.rows[0] ? toOutbox(r.rows[0]) : undefined;
  }

  async listOutbox(): Promise<OutboxRow[]> {
    const r = await this.#db.query<OutboxDbRow>(`SELECT ${OUTBOX_COLUMNS} FROM bridge.relay_outbox ORDER BY created_at`);
    return r.rows.map(toOutbox);
  }

  async recordOutboxAttempt(relayEventId: string, error: string): Promise<void> {
    await this.#db.query('UPDATE bridge.relay_outbox SET attempts = attempts + 1, last_error = $2 WHERE relay_event_id = $1', [relayEventId, error]);
  }

  async deleteOutbox(relayEventId: string, db: Queryable = this.#db): Promise<void> {
    await db.query('DELETE FROM bridge.relay_outbox WHERE relay_event_id = $1', [relayEventId]);
  }

  // --- cursors ---

  async getCursor(stream: string): Promise<number | undefined> {
    const r = await this.#db.query<{ position: string }>('SELECT position FROM bridge.cursors WHERE stream = $1', [stream]);
    return r.rows[0] ? Number(r.rows[0].position) : undefined;
  }

  async initCursor(stream: string, position: number, db: Queryable = this.#db): Promise<void> {
    await db.query('INSERT INTO bridge.cursors (stream, position) VALUES ($1, $2) ON CONFLICT (stream) DO NOTHING', [stream, position]);
  }

  async setCursor(stream: string, position: number, db: Queryable = this.#db): Promise<void> {
    await db.query(
      `INSERT INTO bridge.cursors (stream, position) VALUES ($1, $2)
       ON CONFLICT (stream) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
      [stream, position],
    );
  }

  // --- dead letters ---

  async deadLetter(direction: 'mm_to_relay' | 'relay_to_mm', payload: unknown, error: string, attempts: number, db: Queryable = this.#db): Promise<void> {
    await db.query('INSERT INTO bridge.dead_letter (direction, payload, error, attempts) VALUES ($1, $2, $3, $4)', [direction, JSON.stringify(payload), error, attempts]);
  }
}
