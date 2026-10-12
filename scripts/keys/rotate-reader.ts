// pnpm keys:rotate-reader [--finish]: replace the shared reader key (docs/operations.md).
// Step 1: a new key joins the relay and every channel the old reader is in; .env gets it as
// READER_SECRET_KEY and keeps the old one as READER_SECRET_KEY_PREVIOUS. Restart the bridge, agent-runtime
// and ingestion. Step 2 (--finish): the old key leaves every channel and the relay (its open sockets are cut
// only when the relay restarts or the services reconnect; spike A6).
import { parseArgs } from 'node:util';
import { signerFromHex } from '@brain/shared';
import { loadEnv, removeFromEnvFile, requireValue, updateEnvFile } from '../lib/env.ts';
import { newSecretKeyHex } from '../lib/nostr.ts';
import { adminEvent, channelsOf, relayClient } from './relay-ops.ts';

const { values } = parseArgs({ options: { finish: { type: 'boolean' } } });
const env = loadEnv();
const relay = relayClient(env);
const bridge = signerFromHex(requireValue(env, 'BRIDGE_SECRET_KEY'));
const problems: string[] = [];
const note = (problem: string | undefined): void => void (problem && problems.push(problem));

if (!values.finish) {
  if (env.READER_SECRET_KEY_PREVIOUS) throw new Error('A rotation is already in progress: run `pnpm keys:rotate-reader --finish` first.');
  const old = signerFromHex(requireValue(env, 'READER_SECRET_KEY'));
  const nextHex = newSecretKeyHex();
  const next = signerFromHex(nextHex);
  note(await adminEvent(relay, bridge, 9030, [['p', next.pubkey], ['role', 'member']]));
  const channels = await channelsOf(relay, old, old.pubkey);
  for (const channel of channels) note(await adminEvent(relay, bridge, 9000, [['h', channel], ['p', next.pubkey]]));
  updateEnvFile('READER_SECRET_KEY_PREVIOUS', requireValue(env, 'READER_SECRET_KEY'));
  updateEnvFile('READER_SECRET_KEY', nextHex);
  console.log(`New reader key ${next.pubkey} added to the relay and ${channels.length} channels; .env updated.`);
  console.log('Restart the bridge, agent-runtime and ingestion, then run `pnpm keys:rotate-reader --finish`.');
} else {
  const old = signerFromHex(requireValue(env, 'READER_SECRET_KEY_PREVIOUS'));
  const channels = await channelsOf(relay, bridge, old.pubkey);
  for (const channel of channels) note(await adminEvent(relay, bridge, 9001, [['h', channel], ['p', old.pubkey]]));
  note(await adminEvent(relay, bridge, 9031, [['p', old.pubkey]]));
  removeFromEnvFile('READER_SECRET_KEY_PREVIOUS');
  console.log(`Old reader key ${old.pubkey} removed from ${channels.length} channels and the relay.`);
}
for (const problem of problems) console.log(`relay refused: ${problem}`);
