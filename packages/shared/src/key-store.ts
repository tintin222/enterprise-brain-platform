// The shared key store (D19): every identity's secrets, encrypted with AES-256-GCM under the master
// key (KEY_ENCRYPTION_KEY). Secrets are decrypted in memory only, and never logged.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Queryable } from './db.ts';
import { generateSecretKeyBytes, pubkeyOfSecret, SecretKeySigner, type Signer } from './nostr.ts';

interface SecretRow {
  ref: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

export class KeyStoreError extends Error {}

export class KeyStore {
  readonly #db: Queryable;
  readonly #masterKey: Buffer;
  readonly #signers = new Map<string, Signer>();
  readonly #maxCachedSigners: number;

  constructor(db: Queryable, masterKeyHex: string, maxCachedSigners = 5000) {
    const key = Buffer.from(masterKeyHex, 'hex');
    if (key.length !== 32) throw new KeyStoreError('KEY_ENCRYPTION_KEY must be 32 bytes');
    this.#db = db;
    this.#masterKey = key;
    this.#maxCachedSigners = maxCachedSigners;
  }

  /** Encrypt with the ref as associated data, so a ciphertext cannot be moved to another ref. */
  encrypt(ref: string, plaintext: Uint8Array): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, nonce);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  decrypt(row: SecretRow): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, row.nonce);
    decipher.setAAD(Buffer.from(row.ref, 'utf8'));
    decipher.setAuthTag(row.auth_tag);
    try {
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    } catch {
      throw new KeyStoreError(`Cannot decrypt secret ${row.ref}: wrong master key or corrupted data`);
    }
  }

  /** Store a secret under `ref` unless one exists. Returns true if this call stored it. */
  async putSecret(ref: string, kind: string, value: Uint8Array | string, db: Queryable = this.#db, pubkey?: string): Promise<boolean> {
    const plaintext = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const { nonce, ciphertext, authTag } = this.encrypt(ref, plaintext);
    const result = await db.query(
      `INSERT INTO identity.secrets (ref, kind, pubkey, nonce, ciphertext, auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (ref) DO NOTHING`,
      [ref, kind, pubkey ?? null, nonce, ciphertext, authTag],
    );
    return result.rowCount === 1;
  }

  /** Replace the secret stored under `ref` (for example a rotated bot token). */
  async replaceSecret(ref: string, value: Uint8Array | string, db: Queryable = this.#db): Promise<void> {
    const plaintext = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const { nonce, ciphertext, authTag } = this.encrypt(ref, plaintext);
    const result = await db.query('UPDATE identity.secrets SET nonce = $2, ciphertext = $3, auth_tag = $4 WHERE ref = $1', [ref, nonce, ciphertext, authTag]);
    if (result.rowCount !== 1) throw new KeyStoreError(`No secret stored under ${ref}`);
  }

  async getSecret(ref: string, db: Queryable = this.#db): Promise<Buffer | undefined> {
    const result = await db.query<SecretRow>('SELECT ref, nonce, ciphertext, auth_tag FROM identity.secrets WHERE ref = $1', [ref]);
    const row = result.rows[0];
    return row ? this.decrypt(row) : undefined;
  }

  async getSecretText(ref: string, db: Queryable = this.#db): Promise<string | undefined> {
    return (await this.getSecret(ref, db))?.toString('utf8');
  }

  /** Generate a Nostr keypair and store the secret under `ref`. Returns the pubkey. */
  async createNostrKey(ref: string, kind: string, db: Queryable = this.#db): Promise<string> {
    const secretKey = generateSecretKeyBytes();
    const pubkey = pubkeyOfSecret(secretKey);
    const stored = await this.putSecret(ref, kind, secretKey, db, pubkey);
    if (!stored) {
      const existing = await db.query<{ pubkey: string | null }>('SELECT pubkey FROM identity.secrets WHERE ref = $1', [ref]);
      const existingPubkey = existing.rows[0]?.pubkey;
      if (!existingPubkey) throw new KeyStoreError(`Secret ${ref} exists but is not a Nostr key`);
      return existingPubkey;
    }
    return pubkey;
  }

  /** A signer for a stored Nostr key, looked up by pubkey. */
  async signerFor(pubkey: string): Promise<Signer> {
    const cached = this.#signers.get(pubkey);
    if (cached) return cached;
    const result = await this.#db.query<SecretRow>('SELECT ref, nonce, ciphertext, auth_tag FROM identity.secrets WHERE pubkey = $1', [pubkey]);
    const row = result.rows[0];
    if (!row) throw new KeyStoreError(`No secret key stored for pubkey ${pubkey}`);
    const signer = new SecretKeySigner(new Uint8Array(this.decrypt(row)));
    if (signer.pubkey !== pubkey) throw new KeyStoreError(`Stored key for ${pubkey} does not match its pubkey`);
    if (this.#signers.size >= this.#maxCachedSigners) {
      const oldest = this.#signers.keys().next().value;
      if (oldest !== undefined) this.#signers.delete(oldest);
    }
    this.#signers.set(pubkey, signer);
    return signer;
  }
}
