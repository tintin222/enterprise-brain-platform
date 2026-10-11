-- Phase 4: edits, deletions, reactions, channel metadata (docs/bridge-spec.md sections 3 to 6).

-- mm_edit_at: the Mattermost edit_at (ms) whose text the relay has, for Mattermost-origin messages.
-- relay_edit_at / relay_edit_id: the newest agent edit (kind 40003) applied in Mattermost, by created_at then id.
-- deleted_at: set once the deletion is mirrored, in either direction; it also stops the echo of that deletion.
ALTER TABLE bridge.message_map
  ADD COLUMN mm_edit_at     bigint NOT NULL DEFAULT 0,
  ADD COLUMN relay_edit_at  bigint NOT NULL DEFAULT 0,
  ADD COLUMN relay_edit_id  text,
  ADD COLUMN deleted_at     timestamptz;

-- One row per mirrored reaction. `emoji` is the relay content (an emoji character, or :name: for custom
-- emoji), so two Mattermost names for one character (+1 and thumbsup) are one relay reaction.
CREATE TABLE bridge.reaction_map (
  mm_post_id      text NOT NULL,
  mm_user_id      text NOT NULL,
  emoji           text NOT NULL,
  emoji_name      text NOT NULL,
  relay_event_id  text NOT NULL UNIQUE,
  origin          text NOT NULL CHECK (origin IN ('mm', 'relay')),
  mm_channel_id   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mm_post_id, mm_user_id, emoji)
);

-- Hash of the name, about text and visibility last published with kind 9007 or 9002.
ALTER TABLE bridge.channel_map ADD COLUMN metadata_hash text;

-- Data a completion needs that is not in the signed event (for example the Mattermost edit time).
ALTER TABLE bridge.relay_outbox ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';

-- Only a post's first mirroring must be unique; edits and reactions may queue several rows per post.
DROP INDEX bridge.relay_outbox_post_purpose;
CREATE UNIQUE INDEX relay_outbox_post_purpose ON bridge.relay_outbox (mm_post_id, purpose) WHERE mm_post_id IS NOT NULL AND purpose = 'post';
