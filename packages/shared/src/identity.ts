// The identity map: Mattermost user <-> Nostr key, for people, agents and service bots (D19).
import path from 'node:path';
import type { Queryable } from './db.ts';

export const IDENTITY_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations/identity');

export type IdentityKind = 'person' | 'agent' | 'service';

export interface Identity {
  mmUserId: string;
  kind: IdentityKind;
  pubkey: string;
  secretRef: string | null;
  relayMember: boolean;
  profileHash: string | null;
}

interface IdentityRow {
  mm_user_id: string;
  kind: IdentityKind;
  nostr_pubkey: string;
  secret_ref: string | null;
  relay_member: boolean;
  profile_hash: string | null;
}

const COLUMNS = 'mm_user_id, kind, nostr_pubkey, secret_ref, relay_member, profile_hash';

function toIdentity(row: IdentityRow): Identity {
  return {
    mmUserId: row.mm_user_id,
    kind: row.kind,
    pubkey: row.nostr_pubkey,
    secretRef: row.secret_ref,
    relayMember: row.relay_member,
    profileHash: row.profile_hash,
  };
}

export class IdentityRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(mmUserId: string, db: Queryable = this.#db): Promise<Identity | undefined> {
    const result = await db.query<IdentityRow>(`SELECT ${COLUMNS} FROM identity.identities WHERE mm_user_id = $1`, [mmUserId]);
    return result.rows[0] ? toIdentity(result.rows[0]) : undefined;
  }

  async getByPubkey(pubkey: string, db: Queryable = this.#db): Promise<Identity | undefined> {
    const result = await db.query<IdentityRow>(`SELECT ${COLUMNS} FROM identity.identities WHERE nostr_pubkey = $1`, [pubkey]);
    return result.rows[0] ? toIdentity(result.rows[0]) : undefined;
  }

  async getMany(mmUserIds: string[]): Promise<Map<string, Identity>> {
    if (mmUserIds.length === 0) return new Map();
    const result = await this.#db.query<IdentityRow>(`SELECT ${COLUMNS} FROM identity.identities WHERE mm_user_id = ANY($1)`, [mmUserIds]);
    return new Map(result.rows.map((row) => [row.mm_user_id, toIdentity(row)]));
  }

  async listByKind(kind: IdentityKind): Promise<Identity[]> {
    const result = await this.#db.query<IdentityRow>(`SELECT ${COLUMNS} FROM identity.identities WHERE kind = $1`, [kind]);
    return result.rows.map(toIdentity);
  }

  /** Insert unless the Mattermost user already has an identity; returns the stored identity either way. */
  async insertIfAbsent(identity: Pick<Identity, 'mmUserId' | 'kind' | 'pubkey' | 'secretRef'>, db: Queryable = this.#db): Promise<Identity> {
    await db.query(
      `INSERT INTO identity.identities (mm_user_id, kind, nostr_pubkey, secret_ref) VALUES ($1, $2, $3, $4)
       ON CONFLICT (mm_user_id) DO NOTHING`,
      [identity.mmUserId, identity.kind, identity.pubkey, identity.secretRef],
    );
    const stored = await this.get(identity.mmUserId, db);
    if (!stored) throw new Error(`Identity for ${identity.mmUserId} vanished after insert`);
    return stored;
  }

  async markRelayMember(mmUserId: string, member = true): Promise<void> {
    await this.#db.query('UPDATE identity.identities SET relay_member = $2 WHERE mm_user_id = $1', [mmUserId, member]);
  }

  async setProfileHash(mmUserId: string, hash: string): Promise<void> {
    await this.#db.query('UPDATE identity.identities SET profile_hash = $2 WHERE mm_user_id = $1', [mmUserId, hash]);
  }
}
