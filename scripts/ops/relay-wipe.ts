// pnpm relay:wipe --yes: delete everything the local relay stores (events, channels, members) and start it
// again empty. For the relay rebuild drill (docs/operations.md); never run against data you need.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { compose, composeProject } from '../lib/compose.ts';
import { loadEnv } from '../lib/env.ts';
import { waitForStack } from '../lib/stack.ts';

const { values } = parseArgs({ options: { yes: { type: 'boolean' } } });
if (!values.yes) {
  console.error('This deletes all relay data (events, channels, members). Run `pnpm relay:wipe --yes` to confirm.');
  process.exit(2);
}
const services = ['relay', 'buzz-postgres', 'buzz-redis'];
await compose(['stop', ...services]);
await compose(['rm', '--force', ...services]);
for (const volume of ['buzz-postgres-data', 'buzz-redis-data', 'buzz-git-data']) {
  execFileSync('docker', ['volume', 'rm', '--force', `${composeProject}_${volume}`], { stdio: 'ignore' });
}
await compose(['up', '--detach', '--wait', ...services]);
await waitForStack(loadEnv());
console.log('The relay is empty and running. Run `pnpm relay:rebuild` with the services stopped, then start them.');
