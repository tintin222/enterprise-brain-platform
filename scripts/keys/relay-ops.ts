// Relay membership steps shared by the key rotation scripts.
import { BuzzRelayClient, nowSeconds, RelayError, tagValue, type Signer } from '@brain/shared';

export function relayClient(env: Record<string, string | undefined>): BuzzRelayClient {
  return new BuzzRelayClient(env.RELAY_HTTP_URL ?? '', { perKeyPerSecond: 15 });
}

/** Publish an admin event as `signer`; a refusal the relay will not change its mind on is reported, not thrown. */
export async function adminEvent(relay: BuzzRelayClient, signer: Signer, kind: number, tags: string[][]): Promise<string | undefined> {
  try {
    await relay.publish(signer.sign({ kind, tags, content: '', created_at: nowSeconds() }), signer);
    return undefined;
  } catch (error) {
    if (error instanceof RelayError && !error.retryable) return error.message;
    throw error;
  }
}

/** Relay channels whose member list (kind 39002) names `pubkey`, read as `reader`. */
export async function channelsOf(relay: BuzzRelayClient, reader: Signer, pubkey: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const list of relay.queryAll({ kinds: [39002], '#p': [pubkey] }, reader)) {
    const id = tagValue(list, 'd');
    if (id && list.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey)) ids.push(id);
  }
  return [...new Set(ids)];
}
