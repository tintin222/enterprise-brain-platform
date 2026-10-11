// Relay membership management for scripts: kind 9030 signed by the relay owner (the bridge key).
import { requireValue, type EnvValues } from './env.ts';
import { sign, type Identity } from './nostr.ts';
import { RelayHttp, RelaySocket } from './relay.ts';

/** Add `pubkey` as a relay member (kind 9030 by the owner). Safe to repeat. */
export async function ensureRelayMember(env: EnvValues, owner: Identity, pubkey: string, role: 'member' | 'admin' = 'member'): Promise<void> {
  const http = new RelayHttp(requireValue(env, 'RELAY_HTTP_URL'));
  const result = await http.publish(owner, sign(owner, 9030, [['p', pubkey], ['role', role]]));
  const body = result.body as { accepted?: boolean; message?: string } | null;
  if (result.status !== 200 || body?.accepted !== true) {
    throw new Error(`Adding relay member ${pubkey} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
}

/** Members listed in the relay-signed roster (kind 13534), with their roles. */
export async function listRelayMembers(env: EnvValues, asIdentity: Identity): Promise<Map<string, string>> {
  const http = new RelayHttp(requireValue(env, 'RELAY_HTTP_URL'));
  const { events } = await http.query(asIdentity, [{ kinds: [13534], limit: 1 }]);
  const roster = new Map<string, string>();
  for (const tag of events[0]?.tags ?? []) {
    if (tag[0] === 'member' && tag[1]) roster.set(tag[1], tag[2] ?? 'member');
  }
  return roster;
}

/** True when `identity` can complete NIP-42 auth, which only relay members can. */
export async function canAuthenticate(env: EnvValues, identity: Identity): Promise<boolean> {
  try {
    const socket = await RelaySocket.connect(requireValue(env, 'RELAY_WS_URL'), identity);
    socket.close();
    return true;
  } catch {
    return false;
  }
}
