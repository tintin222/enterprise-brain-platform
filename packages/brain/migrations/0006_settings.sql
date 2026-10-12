-- Installation settings the brain API keeps for itself (no secrets: those live in the key store): the OAuth
-- client id Mattermost issued, the slash commands registered per team, the version of the Mattermost setup.
CREATE TABLE brain.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
