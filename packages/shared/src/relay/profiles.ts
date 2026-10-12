// Display names from kind 0 profiles (the bridge publishes one per mirrored person and agent, spike A8).
import type { RelayClient } from './client.ts';
import type { Signer } from '../nostr.ts';

const PROFILE_TTL_MS = 10 * 60 * 1000;

/** Display names from kind 0 profiles, cached for ten minutes. */
export class ProfileNames {
  readonly #relay: RelayClient;
  readonly #reader: Signer;
  readonly #cache = new Map<string, { name: string; expires: number }>();

  constructor(relay: RelayClient, reader: Signer) {
    this.#relay = relay;
    this.#reader = reader;
  }

  async names(pubkeys: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    const missing = [...new Set(pubkeys)].filter((pubkey) => (this.#cache.get(pubkey)?.expires ?? 0) < now);
    if (missing.length > 0) {
      const profiles = await this.#relay.query([{ kinds: [0], authors: missing }], this.#reader);
      for (const pubkey of missing) {
        const profile = profiles.find((event) => event.pubkey === pubkey);
        let name = 'someone';
        if (profile) {
          try {
            const content = JSON.parse(profile.content) as { display_name?: string; name?: string };
            name = content.display_name || content.name || name;
          } catch {
            // keep the fallback
          }
        }
        this.#cache.set(pubkey, { name, expires: now + PROFILE_TTL_MS });
      }
    }
    return new Map(pubkeys.map((pubkey) => [pubkey, this.#cache.get(pubkey)?.name ?? 'someone']));
  }
}
