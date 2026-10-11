// pnpm dev:down: stop the local stack and keep its data.
// pnpm dev:down --wipe: also delete every volume and the generated .env (back to a clean machine).
import { existsSync, rmSync } from 'node:fs';
import { compose, composeProject, dockerOutput } from '../lib/compose.ts';
import { envPath } from '../lib/env.ts';

const wipe = process.argv.includes('--wipe');

if (existsSync(envPath)) {
  await compose(['down', '--remove-orphans', ...(wipe ? ['--volumes'] : [])]);
} else {
  // Without .env the compose file cannot be interpolated; act on the project label instead.
  const ids = (await dockerOutput(['ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProject}`])).split('\n').filter(Boolean);
  if (ids.length > 0) await dockerOutput(['rm', '-f', ...ids]);
}

if (wipe) {
  const volumes = (await dockerOutput(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${composeProject}`])).split('\n').filter(Boolean);
  if (volumes.length > 0) await dockerOutput(['volume', 'rm', ...volumes]);
  rmSync(envPath, { force: true });
  console.log('Stack removed, volumes deleted, .env deleted.');
} else {
  console.log('Stack stopped. Data kept; use --wipe to delete it.');
}
