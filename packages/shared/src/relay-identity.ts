// Registering an identity on the relay (docs/bridge-spec.md section 2): relay membership by the relay
// owner (the bridge key, kind 9030) and a profile signed by the identity itself (kind 0). Used by the
// bridge for people and by agent provisioning for agents (D19).
import { createHash } from 'node:crypto';
import type { Identity, IdentityRepository } from './identity.ts';
import type { KeyStore } from './key-store.ts';
import { nowSeconds, type Signer } from './nostr.ts';
import type { RelayClient } from './relay/client.ts';

export interface ProfileInput {
  username: string;
  displayName: string;
  pictureUrl: string;
}

/** Kind 0 content for a mirrored identity (spike A8). */
export function profileContent(input: ProfileInput): string {
  return JSON.stringify({ name: input.username, display_name: input.displayName, picture: input.pictureUrl });
}

export interface RelayIdentityContext {
  relay: RelayClient;
  /** The relay owner (bridge) key, which may add relay members. */
  bridgeSigner: Signer;
  identities: IdentityRepository;
  keyStore: KeyStore;
}

export async function ensureRelayMembership(ctx: RelayIdentityContext, identity: Identity): Promise<Identity> {
  if (identity.relayMember) return identity;
  const add = ctx.bridgeSigner.sign({ kind: 9030, tags: [['p', identity.pubkey], ['role', 'member']], content: '', created_at: nowSeconds() });
  await ctx.relay.publish(add, ctx.bridgeSigner);
  await ctx.identities.markRelayMember(identity.mmUserId);
  return { ...identity, relayMember: true };
}

/** Publish the profile if it changed since the last publish (tracked by hash). */
export async function ensureProfile(ctx: RelayIdentityContext, identity: Identity, profile: ProfileInput): Promise<Identity> {
  const content = profileContent(profile);
  const hash = createHash('sha256').update(content).digest('hex');
  if (identity.profileHash === hash) return identity;
  const signer = await ctx.keyStore.signerFor(identity.pubkey);
  await ctx.relay.publish(signer.sign({ kind: 0, tags: [], content, created_at: nowSeconds() }), signer);
  await ctx.identities.setProfileHash(identity.mmUserId, hash);
  return { ...identity, profileHash: hash };
}
