// pnpm dev:up [--mostlymatter | --team-edition]: create or complete .env (service keys, secrets), then start
// the local stack and wait until every service is healthy. `--mostlymatter` runs Mostlymatter (no user cap)
// instead of Team Edition, on the same data, until `--team-edition` switches back. Other arguments are passed
// to `docker compose up`.
import { compose } from '../lib/compose.ts';
import { ensureEnvFile, updateEnvFile } from '../lib/env.ts';

const args = process.argv.slice(2);
const { created, generated } = ensureEnvFile();
console.log(`${created ? 'Created' : 'Checked'} .env${generated.length > 0 ? `; generated ${generated.join(', ')}` : ''}`);
if (args.includes('--mostlymatter')) updateEnvFile('MATTERMOST_EDITION', 'mostlymatter');
if (args.includes('--team-edition')) updateEnvFile('MATTERMOST_EDITION', 'team');

await compose(['up', '--detach', '--wait', '--wait-timeout', '600', ...args.filter((arg) => arg !== '--mostlymatter' && arg !== '--team-edition')]);
console.log('Local stack is up. Mattermost: http://localhost:8065  Relay: ws://localhost:3000');
