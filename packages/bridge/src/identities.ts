// Identities for mirrored participants (docs/bridge-spec.md section 2): a custodial key per person,
// relay membership (kind 9030 by the bridge key) and a profile (kind 0 signed by the identity).
// Agents are provisioned elsewhere (agent-runtime) but registered the same way (D19).
import {
  DistinctSigner,
  ensureProfile,
  ensureRelayMembership,
  KeyedQueue,
  secretRefs,
  type ChatClient,
  type Identity,
  type IdentityRepository,
  type KeyStore,
  type Logger,
  type MmUser,
  type RelayClient,
  type RecentEvents,
  type RelayIdentityContext,
  type Signer,
} from '@brain/shared';

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
  /** Shared with the bridge's other signers, so no two signed events are identical (DistinctSigner). */
  recentEvents: RecentEvents;
  log: Logger;
}

/**
 * How long a checked identity is trusted before it is read again: long enough to spare the database, short
 * enough that a re-mapped identity (agent provisioning) or a changed name reaches the relay within minutes.
 */
const READY_TTL_MS = 5 * 60 * 1000;

export class IdentityService {
  readonly #deps: IdentityServiceDeps;
  readonly #ctx: RelayIdentityContext;
  readonly #ready = new Map<string, { identity: Identity; at: number }>();
  readonly #queue = new KeyedQueue();

  constructor(deps: IdentityServiceDeps) {
    this.#deps = deps;
    this.#ctx = { relay: deps.relay, bridgeSigner: deps.bridgeSigner, identities: deps.identities, keyStore: deps.keyStore };
  }

  #fresh(mmUserId: string): Identity | undefined {
    const entry = this.#ready.get(mmUserId);
    return entry && Date.now() - entry.at < READY_TTL_MS ? entry.identity : undefined;
  }

  /** The identity for a Mattermost user, created (custodial key, relay membership, profile) if needed. */
  forUser(user: MmUser): Promise<Identity> {
    const ready = this.#fresh(user.id);
    if (ready) return Promise.resolve(ready);
    return this.#queue.run(user.id, async () => {
      const again = this.#fresh(user.id);
      if (again) return again;
      const { identities, keyStore } = this.#deps;
      let identity = await identities.get(user.id);
      if (!identity) {
        const ref = secretRefs.personKey(user.id);
        const pubkey = await keyStore.createNostrKey(ref, 'person');
        identity = await identities.insertIfAbsent({ mmUserId: user.id, kind: 'person', pubkey, secretRef: ref });
        this.#deps.log.info({ mmUserId: user.id, pubkey: identity.pubkey }, 'Created custodial identity');
      }
      identity = await ensureRelayMembership(this.#ctx, identity);
      identity = await ensureProfile(this.#ctx, identity, { username: user.username, displayName: displayNameOf(user), pictureUrl: `${this.#deps.chat.baseUrl}/api/v4/users/${user.id}/image` });
      this.#ready.set(user.id, { identity, at: Date.now() });
      return identity;
    });
  }

  async forUserId(mmUserId: string): Promise<Identity | undefined> {
    const ready = this.#fresh(mmUserId);
    if (ready) return ready;
    const user = await this.#deps.chat.getUser(mmUserId);
    return user ? this.forUser(user) : undefined;
  }

  /** Existing identities only (no creation), for example to resolve mentions. */
  mapped(mmUserIds: string[]): Promise<Map<string, Identity>> {
    return this.#deps.identities.getMany(mmUserIds);
  }

  existing(mmUserId: string): Promise<Identity | undefined> {
    return this.#deps.identities.get(mmUserId);
  }

  byPubkey(pubkey: string): Promise<Identity | undefined> {
    return this.#deps.identities.getByPubkey(pubkey);
  }

  async signerFor(identity: Identity): Promise<Signer> {
    return new DistinctSigner(await this.#deps.keyStore.signerFor(identity.pubkey), this.#deps.recentEvents);
  }

  /** Forget cached state for a user, so the next lookup re-checks membership and profile. */
  invalidate(mmUserId: string): void {
    this.#ready.delete(mmUserId);
  }
}
