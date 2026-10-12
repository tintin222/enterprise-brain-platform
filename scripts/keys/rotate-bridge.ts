// pnpm keys:rotate-bridge [--finish]: replace the bridge key, which is the relay owner and owns every mirrored
// channel (docs/operations.md).
// Step 1: the new key becomes a relay owner (9030, then 9032) and an owner of every channel the old key owns
// (9000 with role owner; archived channels refuse changes and are skipped). .env gets it as
// BRIDGE_SECRET_KEY (RELAY_OWNER_PUBKEY follows) and keeps the old one as BRIDGE_SECRET_KEY_PREVIOUS.
// Then `pnpm dev:up` recreates the relay with the new owner; restart the bridge.
// Step 2 (--finish): the old key steps down (9032 to member) and leaves every channel and the relay.
import { parseArgs } from 'node:util';
import { signerFromHex } from '@brain/shared';
import { loadEnv, removeFromEnvFile, requireValue, updateEnvFile } from '../lib/env.ts';
import { newSecretKeyHex } from '../lib/nostr.ts';
import { adminEvent, channelsOf, relayClient } from './relay-ops.ts';

const { values } = parseArgs({ options: { finish: { type: 'boolean' } } });
const env = loadEnv();
const relay = relayClient(env);
const reader = signerFromHex(requireValue(env, 'READER_SECRET_KEY'));
const problems: string[] = [];
const note = (problem: string | undefined): void => void (problem && problems.push(problem));

if (!values.finish) {
  if (env.BRIDGE_SECRET_KEY_PREVIOUS) throw new Error('A rotation is already in progress: run `pnpm keys:rotate-bridge --finish` first.');
  const old = signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY'));
  const nextHex = newSecretKeyHex();
  const next = signerFromHex(nextHex);
  note(await adminEvent(relay, old, 9030, [['p', next.pubkey], ['role', 'admin']]));
  note(await adminEvent(relay, old, 9032, [['p', next.pubkey], ['role', 'owner']]));
  const channels = await channelsOf(relay, reader, old.pubkey);
  for (const channel of channels) note(await adminEvent(relay, old, 9000, [['h', channel], ['p', next.pubkey], ['role', 'owner']]));
  updateEnvFile('BRIDGE_SECRET_KEY_PREVIOUS', requireValue(env, 'BRIDGE_SECRET_KEY'));
  updateEnvFile('BRIDGE_SECRET_KEY', nextHex);
  console.log(`New bridge key ${next.pubkey} is a relay owner and owns ${channels.length} channels; .env updated.`);
  console.log('Run `pnpm dev:up` (the relay restarts with the new RELAY_OWNER_PUBKEY), restart the bridge, then run `pnpm keys:rotate-bridge --finish`.');
} else {
  const old = signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY_PREVIOUS'));
  const next = signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY'));
  const channels = await channelsOf(relay, reader, old.pubkey);
  for (const channel of channels) note(await adminEvent(relay, next, 9001, [['h', channel], ['p', old.pubkey]]));
  note(await adminEvent(relay, old, 9032, [['p', old.pubkey], ['role', 'member']]));
  note(await adminEvent(relay, next, 9031, [['p', old.pubkey]]));
  removeFromEnvFile('BRIDGE_SECRET_KEY_PREVIOUS');
  console.log(`Old bridge key ${old.pubkey} removed from ${channels.length} channels and the relay.`);
}
for (const problem of problems) console.log(`relay refused: ${problem}`);
