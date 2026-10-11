// Identities for mirrored participants (docs/bridge-spec.md section 2): a custodial key per person,
// relay membership (kind 9030 by the bridge key) and a profile (kind 0 signed by the identity).
import { createHash } from 'node:crypto';
import { KeyedQueue, nowSeconds, type ChatClient, type Identity, type IdentityRepository, type KeyStore, type Logger, type MmUser, type RelayClient, type Signer } from '@brain/shared';
import { profileContent } from './events.ts';

export function displayNameOf(user: MmUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.nickname || user.username;
}

export interface IdentityServiceDeps {
  identities: IdentityRepository;
  keyStore: KeyStore;
  relay: RelayClient;
  chat: ChatClient;
  bridgeSigner: Signer;
  log: Logger;
}

export class IdentityService {
  readonly #deps: IdentityServiceDeps;
  readonly #ready = new Map<string, Identity>();
  readonly #queue = new KeyedQueue();

  constructor(deps: IdentityServiceDeps) {
    this.#deps = deps;
  }

  /** The identity for a Mattermost user, created (custodial key, relay membership, profile) if needed. */
  forUser(user: MmUser): Promise<Identity> {
    const ready = this.#ready.get(user.id);
    if (ready) return Promise.resolve(ready);
    return this.#queue.run(user.id, async () => {
      const again = this.#ready.get(user.id);
      if (again) return again;
      const { identities, keyStore } = this.#deps;
      let identity = await identities.get(user.id);
      if (!identity) {
        const ref = `person:${user.id}`;
        const pubkey = await keyStore.createNostrKey(ref, 'person');
        identity = await identities.insertIfAbsent({ mmUserId: user.id, kind: 'person', pubkey, secretRef: ref });
        this.#deps.log.info({ mmUserId: user.id, pubkey: identity.pubkey }, 'Created custodial identity');
      }
      identity = await this.ensureRelayMember(identity);
      identity = await this.ensureProfile(identity, user);
      this.#ready.set(user.id, identity);
      return identity;
    });
  }

  async forUserId(mmUserId: string): Promise<Identity | undefined> {
    const ready = this.#ready.get(mmUserId);
    if (ready) return ready;
    const user = await this.#deps.chat.getUser(mmUserId);
    return user ? this.forUser(user) : undefined;
  }

  /** Existing identities only (no creation), for example to resolve mentions. */
  mapped(mmUserIds: string[]): Promise<Map<string, Identity>> {
    return this.#deps.identities.getMany(mmUserIds);
  }

  signerFor(identity: Identity): Promise<Signer> {
    return this.#deps.keyStore.signerFor(identity.pubkey);
  }

  async ensureRelayMember(identity: Identity): Promise<Identity> {
    if (identity.relayMember) return identity;
    const { bridgeSigner, relay, identities } = this.#deps;
    const add = bridgeSigner.sign({ kind: 9030, tags: [['p', identity.pubkey], ['role', 'member']], content: '', created_at: nowSeconds() });
    await relay.publish(add, bridgeSigner);
    await identities.markRelayMember(identity.mmUserId);
    return { ...identity, relayMember: true };
  }

  async ensureProfile(identity: Identity, user: MmUser): Promise<Identity> {
    const content = profileContent({ username: user.username, displayName: displayNameOf(user), pictureUrl: `${this.#deps.chat.baseUrl}/api/v4/users/${user.id}/image` });
    const hash = createHash('sha256').update(content).digest('hex');
    if (identity.profileHash === hash) return identity;
    const signer = await this.signerFor(identity);
    await this.#deps.relay.publish(signer.sign({ kind: 0, tags: [], content, created_at: nowSeconds() }), signer);
    await this.#deps.identities.setProfileHash(identity.mmUserId, hash);
    return { ...identity, profileHash: hash };
  }

  /** Forget cached state for a user, so the next lookup re-checks membership and profile. */
  invalidate(mmUserId: string): void {
    this.#ready.delete(mmUserId);
  }
}
