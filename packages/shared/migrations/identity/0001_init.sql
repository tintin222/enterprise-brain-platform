-- Shared identity schema (D19): the key store and the identity map (Mattermost user <-> Nostr key).

CREATE TABLE identity.secrets (
  ref         text PRIMARY KEY,
  kind        text NOT NULL,
  pubkey      text UNIQUE,
  nonce       bytea NOT NULL,
  ciphertext  bytea NOT NULL,
  auth_tag    bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.identities (
  mm_user_id    text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('person', 'agent', 'service')),
  nostr_pubkey  text NOT NULL UNIQUE,
  secret_ref    text REFERENCES identity.secrets (ref),
  relay_member  boolean NOT NULL DEFAULT false,
  profile_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
