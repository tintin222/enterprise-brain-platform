// The installer, run inside the services image by ./install/brain (install/compose.yml, service `installer`):
//   init      complete config.env: generate every empty secret, derive the addresses (never overwrites a value)
//   seed      Mattermost admin, team and @brain bot, the two tokens into config.env, the brain's Mattermost setup
//   selftest  the clean-install check: an entity created through the API is searchable within 5 s
//   summary   addresses and where the credentials are
//   status    readiness of every service of ours
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrainStore } from '@brain/brain';
import { ensureMattermostIntegration } from '@brain/brain-api';
import { createLogger, createPool, IDENTITY_MIGRATIONS_DIR, KeyStore, MattermostChatClient, migrate } from '@brain/shared';
import { envPath, loadEnv, readEnvFile, renderEnv, requireValue, resolveEnv, type EnvValues } from '../lib/env.ts';
import { MattermostApi, MattermostError, type MmUser } from '../lib/mattermost.ts';

const step = process.argv[2] ?? 'help';
const installDir = path.dirname(envPath);
const templatePath = path.join(installDir, 'config.example.env');
const mmInternal = process.env.MM_API_URL ?? 'http://mattermost:8065';
const brainInternal = process.env.BRAIN_INTERNAL_URL ?? 'http://brain-api:9120';

function writeEnv(values: EnvValues): void {
  writeFileSync(envPath, renderEnv(readFileSync(templatePath, 'utf8'), values), { mode: 0o600 });
}

async function waitFor(name: string, probe: () => Promise<boolean>, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${name} did not become ready within ${timeoutMs / 1000} s`);
    await sleep(2000);
  }
}

const ping = (url: string): Promise<boolean> => fetch(`${url}/api/v4/system/ping`).then((r) => r.ok, () => false);

function init(): void {
  const template = readFileSync(templatePath, 'utf8');
  const existing = existsSync(envPath) ? readEnvFile() : {};
  const { values, generated } = resolveEnv(template, existing);
  const derived: string[] = [];
  const host = values.HOST_ADDRESS || 'localhost';
  if (!values.MM_URL) {
    values.MM_URL = values.DOMAIN_CHAT ? `https://${values.DOMAIN_CHAT}` : `http://${host}:8065`;
    derived.push('MM_URL');
  }
  if (!values.BRAIN_PUBLIC_URL) {
    values.BRAIN_PUBLIC_URL = values.DOMAIN_BRAIN ? `https://${values.DOMAIN_BRAIN}` : `http://${host}:9120`;
    derived.push('BRAIN_PUBLIC_URL');
  }
  writeEnv(values);
  console.log(`config.env ready${generated.length > 0 ? `; generated ${generated.join(', ')}` : ''}${derived.length > 0 ? `; derived ${derived.join(', ')}` : ''}.`);
  console.log(`Chat: ${values.MM_URL}  Brain: ${values.BRAIN_PUBLIC_URL}`);
}

async function seed(): Promise<void> {
  const env = loadEnv();
  const adminUsername = requireValue(env, 'MM_ADMIN_USERNAME');
  const adminPassword = requireValue(env, 'MM_ADMIN_PASSWORD');
  const teamName = requireValue(env, 'MM_TEAM_NAME');
  await waitFor('Mattermost', () => ping(mmInternal));
  const anonymous = new MattermostApi(mmInternal);
  let admin: MattermostApi;
  try {
    admin = await anonymous.login(adminUsername, adminPassword);
  } catch (error) {
    if (!(error instanceof MattermostError) || error.status !== 401) throw error;
    // On a fresh server the first account may be created without auth and becomes system admin.
    await anonymous.post('/users', { username: adminUsername, email: env.MM_ADMIN_EMAIL || `${adminUsername}@example.com`, password: adminPassword });
    admin = await anonymous.login(adminUsername, adminPassword);
    console.log(`Created the system admin @${adminUsername}`);
  }
  const me = await admin.get<MmUser>('/users/me');
  if (!me.roles.split(' ').includes('system_admin')) throw new Error(`@${adminUsername} exists but is not a system admin; use a fresh database or another MM_ADMIN_USERNAME`);
  await admin.put('/config/patch', {
    ServiceSettings: { EnableBotAccountCreation: true, EnableUserAccessTokens: true, EnableDesktopLandingPage: false },
    TeamSettings: { MaxUsersPerTeam: 10000, SiteName: 'Enterprise Brain', EnableCustomBrand: true, CustomDescriptionText: 'Team chat with AI agents that know your company' },
    SupportSettings: { AboutLink: '', HelpLink: '', PrivacyPolicyLink: '', ReportAProblemLink: '' },
  });
  const mark = path.resolve(import.meta.dirname, '../../branding/png/mark-512.png');
  if (existsSync(mark)) await admin.upload('/brand/image', 'image', readFileSync(mark), 'mark-512.png', 'image/png').catch(() => undefined);

  let team = await admin.find<{ id: string }>(`/teams/name/${teamName}`);
  if (!team) {
    team = await admin.post<{ id: string }>('/teams', { name: teamName, display_name: env.MM_TEAM_DISPLAY_NAME || teamName, type: 'O' });
    console.log(`Created the team ${teamName}`);
  }
  await admin.post(`/teams/${team.id}/members`, { team_id: team.id, user_id: me.id });

  let bot = await admin.find<MmUser>('/users/username/brain');
  if (!bot) {
    const created = await admin.post<{ user_id: string }>('/bots', { username: 'brain', display_name: 'Brain', description: 'The brain. It reads the channels it is in.' });
    bot = await admin.get<MmUser>(`/users/${created.user_id}`);
    console.log('Created the @brain bot');
  } else if (bot.delete_at !== 0) {
    await admin.post(`/bots/${bot.id}/enable`);
  }
  await admin.put(`/users/${bot.id}/roles`, { roles: 'system_user system_admin' });
  await admin.post(`/teams/${team.id}/members`, { team_id: team.id, user_id: bot.id });

  const values = readEnvFile();
  const tokenFor = async (userId: string, current: string | undefined, description: string): Promise<string> => {
    if (current && (await admin.withToken(current).get<MmUser>('/users/me').then((user) => user.id === userId, () => false))) return current;
    return (await admin.post<{ token: string }>(`/users/${userId}/tokens`, { description })).token;
  };
  values.MM_BRIDGE_TOKEN = await tokenFor(bot.id, values.MM_BRIDGE_TOKEN, 'bridge (installer)');
  values.MM_ADMIN_TOKEN = await tokenFor(me.id, values.MM_ADMIN_TOKEN, 'agent provisioning (installer)');
  writeEnv(values);

  // The brain's side of Mattermost: allow-list, OAuth app, /brain command (idempotent).
  const pool = createPool(requireValue(values, 'STATE_DATABASE_URL'));
  try {
    const store = new BrainStore(pool);
    await store.init();
    // The key store's table belongs to the identity schema, which no service has created yet on a fresh install.
    await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
    const result = await ensureMattermostIntegration({
      adminChat: new MattermostChatClient(mmInternal, values.MM_ADMIN_TOKEN),
      store,
      keyStore: new KeyStore(pool, requireValue(values, 'KEY_ENCRYPTION_KEY')),
      publicUrl: requireValue(values, 'BRAIN_PUBLIC_URL'),
      internalUrl: brainInternal,
      log: createLogger('installer', 'warn'),
    });
    console.log(`Seed complete: team ${teamName}, admin @${adminUsername}, @brain bot, /brain in ${result.commands.length} team(s), OAuth app ${result.oauthClientId}.`);
  } finally {
    await pool.end();
  }
}

async function selftest(): Promise<void> {
  const env = loadEnv();
  const token = requireValue(env, 'BRAIN_API_TOKEN');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const api = `${brainInternal}/api/v1/brain`;
  await waitFor('the brain API', () => fetch(`${brainInternal}/readyz`).then((r) => r.ok, () => false), 300_000);
  const word = `install${Date.now().toString(36)}`;
  const container = (await (await fetch(`${api}/containers`, { method: 'POST', headers, body: JSON.stringify({ kind: 'project', title: `Install test ${word}` }) })).json()) as { container?: { id: string } };
  if (!container.container) throw new Error(`Could not create a container: ${JSON.stringify(container)}`);
  const created = Date.now();
  const entity = (await (await fetch(`${api}/entities`, { method: 'POST', headers, body: JSON.stringify({ type: 'decision', title: `Decision ${word}`, containerId: container.container.id, text: `The ${word} decision proves the installation works.` }) })).json()) as { entity?: { id: string } };
  if (!entity.entity) throw new Error(`Could not create an entity: ${JSON.stringify(entity)}`);
  let foundAfterMs = -1;
  while (Date.now() - created < 5000) {
    const search = (await (await fetch(`${api}/search?q=${word}`, { headers })).json()) as { results?: { entityId: string }[] };
    if (search.results?.some((hit) => hit.entityId === entity.entity?.id)) {
      foundAfterMs = Date.now() - created;
      break;
    }
    await sleep(200);
  }
  if (foundAfterMs < 0) throw new Error('The new entity was not searchable within 5 s');
  const setup = (await (await fetch(`${api}/setup/mattermost`, { method: 'POST', headers: { Authorization: headers.Authorization } })).json()) as { commands?: unknown[] };
  if (!setup.commands || setup.commands.length === 0) throw new Error('The /brain command is not registered');
  const manifest = (await (await fetch(`${api}/export/manifest`, { headers })).json()) as { tables?: Record<string, number> };
  if (!manifest.tables || manifest.tables.entities === undefined) throw new Error('The export manifest is missing');
  const services = await Promise.all(
    ['bridge:9101', 'agent-runtime:9102', 'ingestion:9103'].map(async (target) => [target.split(':')[0] ?? target, await fetch(`http://${target}/readyz`).then((r) => r.ok, () => false)] as const),
  );
  console.log(JSON.stringify({ ok: true, searchableAfterMs: foundAfterMs, commands: setup.commands.length, tables: manifest.tables, services: Object.fromEntries(services) }));
  if (services.some(([, ready]) => !ready)) throw new Error('A service is not ready; see ./install/brain status');
}

async function status(): Promise<void> {
  for (const target of ['bridge:9101', 'agent-runtime:9102', 'ingestion:9103', 'brain-api:9120']) {
    const result = await fetch(`http://${target}/readyz`).then((r) => r.text(), (error: unknown) => `unreachable (${error instanceof Error ? error.message : String(error)})`);
    console.log(`${target.split(':')[0]}: ${result.trim().slice(0, 200)}`);
  }
}

function summary(): void {
  const env = readEnvFile();
  console.log('');
  console.log(`Chat:   ${env.MM_URL}  (sign in as @${env.MM_ADMIN_USERNAME}; the password is MM_ADMIN_PASSWORD in install/config.env)`);
  console.log(`Brain:  ${env.BRAIN_PUBLIC_URL}  (sign in with the chat account)`);
  console.log('In any channel, type /brain help. Create people from the System Console or with the team invite link.');
  console.log('Keep install/config.env safe: it holds every key of this installation. Back it up with the volumes.');
}

switch (step) {
  case 'init':
    init();
    break;
  case 'seed':
    await seed();
    break;
  case 'selftest':
    await selftest();
    break;
  case 'status':
    await status();
    break;
  case 'summary':
    summary();
    break;
  default:
    console.error('Usage: run.ts init | seed | selftest | status | summary');
    process.exit(2);
}
