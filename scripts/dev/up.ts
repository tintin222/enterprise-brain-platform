// pnpm dev:up [--enterprise-brain | --mostlymatter | --team-edition]: create or complete .env (service keys,
// secrets), then start the local stack and wait until every service is healthy. `--enterprise-brain` runs our own
// Mattermost build (no user cap, our branding; D48) and `--mostlymatter` Framasoft's, instead of Team Edition, on the
// same data, until `--team-edition` switches back. Other arguments are passed to `docker compose up`.
import { compose } from '../lib/compose.ts';
import { ensureEnvFile, updateEnvFile } from '../lib/env.ts';

const args = process.argv.slice(2);
const { created, generated } = ensureEnvFile();
console.log(`${created ? 'Created' : 'Checked'} .env${generated.length > 0 ? `; generated ${generated.join(', ')}` : ''}`);
const editions: Record<string, string> = { '--enterprise-brain': 'enterprise-brain', '--mostlymatter': 'mostlymatter', '--team-edition': 'team' };
for (const [flag, edition] of Object.entries(editions)) if (args.includes(flag)) updateEnvFile('MATTERMOST_EDITION', edition);

await compose(['up', '--detach', '--wait', '--wait-timeout', '600', ...args.filter((arg) => !(arg in editions))]);
console.log('Local stack is up. Mattermost: http://localhost:8065  Relay: ws://localhost:3000');
