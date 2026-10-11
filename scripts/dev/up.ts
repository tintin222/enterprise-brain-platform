// pnpm dev:up: create or complete .env (service keys, secrets), then start the local stack and wait
// until every service is healthy. Extra arguments are passed to `docker compose up`.
import { compose } from '../lib/compose.ts';
import { ensureEnvFile } from '../lib/env.ts';

const { created, generated } = ensureEnvFile();
console.log(`${created ? 'Created' : 'Checked'} .env${generated.length > 0 ? `; generated ${generated.join(', ')}` : ''}`);

await compose(['up', '--detach', '--wait', '--wait-timeout', '600', ...process.argv.slice(2)]);
console.log('Local stack is up. Mattermost: http://localhost:8065  Relay: ws://localhost:3000');
