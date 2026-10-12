// pnpm dev:seed: idempotent setup of the local stack after `pnpm dev:up`.
//   Mattermost: enable bot accounts and user access tokens, apply the Enterprise Brain name and logo, create
//   the dev team, the admin, two people (alice, bob) and the @brain bridge bot (system admin) with an access
//   token written to .env.
//   Brain: Mattermost's allow-list, the OAuth app for the pages and the /brain command (docs/brain/). `--skip-brain`
//   leaves it out, for a state database this machine cannot reach (staging runs it through the brain API).
//   Relay: check the bridge key is the relay owner and make the reader key a relay member. `--skip-relay` leaves
//   the relay out, for a relay this machine cannot reach (staging; the bridge grants the membership, D45).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BrainStore } from '@brain/brain';
import { ensureMattermostIntegration } from '@brain/brain-api';
import { createLogger, createPool, IDENTITY_MIGRATIONS_DIR, KeyStore, MattermostChatClient, migrate } from '@brain/shared';
import { MattermostApi, MattermostError, type MmUser } from '../lib/mattermost.ts';
import { identityFromHex } from '../lib/nostr.ts';
import { canAuthenticate, ensureRelayMember } from '../lib/relay-admin.ts';
import { waitForStack } from '../lib/stack.ts';
import { envPath, loadEnv, repoRoot, requireValue, updateEnvFile } from '../lib/env.ts';

const env = loadEnv();
const mmUrl = requireValue(env, 'MM_URL');
const teamName = requireValue(env, 'MM_TEAM_NAME');
const adminUsername = requireValue(env, 'MM_ADMIN_USERNAME');
const adminPassword = requireValue(env, 'MM_ADMIN_PASSWORD');
const personPassword = requireValue(env, 'MM_PERSON_PASSWORD');
const people = ['alice', 'bob'];
const botUsername = 'brain';
const skipRelay = process.argv.includes('--skip-relay');
const skipBrain = process.argv.includes('--skip-brain');
const envName = path.basename(envPath);

await waitForStack(env, 300_000, { relay: !skipRelay });
const anonymous = new MattermostApi(mmUrl);

// --- Mattermost admin ---
async function adminSession(): Promise<MattermostApi> {
  try {
    return await anonymous.login(adminUsername, adminPassword);
  } catch (error) {
    if (!(error instanceof MattermostError) || error.status !== 401) throw error;
  }
  // On a fresh server the first account may be created without auth and becomes system admin.
  try {
    await anonymous.post('/users', { username: adminUsername, email: `${adminUsername}@example.test`, password: adminPassword });
  } catch (error) {
    throw new Error(`Cannot log in as ${adminUsername} or create it. If the stack has other data, reset with \`pnpm dev:down --wipe\`.`, { cause: error });
  }
  console.log(`Created system admin @${adminUsername}`);
  return anonymous.login(adminUsername, adminPassword);
}

const admin = await adminSession();
const me = await admin.get<MmUser>('/users/me');
if (!me.roles.split(' ').includes('system_admin')) throw new Error(`@${adminUsername} is not a system admin`);

await admin.put('/config/patch', {
  // The desktop-app landing page offers Mattermost's own apps, so it stays off until we ship ours (D44).
  ServiceSettings: { EnableBotAccountCreation: true, EnableUserAccessTokens: true, EnableDesktopLandingPage: false },
  TeamSettings: {
    // Mattermost's default allows 50 members per team; a workspace at Q7 scale has 500 people in one team.
    MaxUsersPerTeam: 10000,
    // Mattermost's built-in branding (D44); its logo, edition badge and footer need our fork.
    SiteName: 'Enterprise Brain',
    EnableCustomBrand: true,
    CustomDescriptionText: 'Team chat with AI agents that know your company',
  },
  // Mattermost's own About, Help, Privacy and problem-report pages, hidden until the product has its own. Mattermost
  // restores its Terms link when it is empty, so that one stays until it is set to the product's terms.
  SupportSettings: { AboutLink: '', HelpLink: '', PrivacyPolicyLink: '', ReportAProblemLink: '' },
});
await admin.upload('/brand/image', 'image', readFileSync(path.join(repoRoot, 'branding/png/mark-512.png')), 'mark-512.png', 'image/png');
console.log('Enabled bot accounts and user access tokens; allowed 10,000 members per team; applied the Enterprise Brain name and logo');

// --- Team and people ---
let team = await admin.find<{ id: string }>(`/teams/name/${teamName}`);
if (!team) {
  team = await admin.post<{ id: string }>('/teams', { name: teamName, display_name: env.MM_TEAM_DISPLAY_NAME || 'Brain Dev', type: 'O' });
  console.log(`Created team ${teamName}`);
}
const teamId = team.id;

async function addToTeam(userId: string): Promise<void> {
  await admin.post(`/teams/${teamId}/members`, { team_id: teamId, user_id: userId });
}
await addToTeam(me.id);

for (const username of people) {
  let user = await admin.find<MmUser>(`/users/username/${username}`);
  if (!user) {
    user = await admin.post<MmUser>('/users', { username, email: `${username}@example.test`, password: personPassword });
    console.log(`Created @${username}`);
  } else {
    // Keep the account in step with .env so the documented password always works.
    await admin.put(`/users/${user.id}/password`, { new_password: personPassword });
  }
  await addToTeam(user.id);
}

// --- @brain bridge bot ---
let bot = await admin.find<MmUser>(`/users/username/${botUsername}`);
if (!bot) {
  const created = await admin.post<{ user_id: string }>('/bots', {
    username: botUsername,
    display_name: 'Brain',
    description: 'Bridge bot. Adding it to a channel makes the channel agent-enabled.',
  });
  bot = await admin.get<MmUser>(`/users/${created.user_id}`);
  console.log(`Created bot @${botUsername}`);
} else if (bot.delete_at !== 0) {
  await admin.post(`/bots/${bot.id}/enable`);
}
const botId = bot.id;
await admin.put(`/users/${botId}/roles`, { roles: 'system_user system_admin' });
await addToTeam(botId);

async function tokenBelongsToBot(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    return (await admin.withToken(token).get<MmUser>('/users/me')).id === botId;
  } catch {
    return false;
  }
}
if (!(await tokenBelongsToBot(env.MM_BRIDGE_TOKEN))) {
  const token = await admin.post<{ token: string }>(`/users/${botId}/tokens`, { description: 'bridge (pnpm dev:seed)' });
  updateEnvFile('MM_BRIDGE_TOKEN', token.token);
  console.log(`Created @brain access token (MM_BRIDGE_TOKEN in ${envName})`);
}

// Agent provisioning creates bots, which Mattermost refuses to bot accounts (even system admins), so it
// uses a personal access token of the admin user (D25).
async function tokenBelongsToAdmin(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    return (await admin.withToken(token).get<MmUser>('/users/me')).id === me.id;
  } catch {
    return false;
  }
}
if (!(await tokenBelongsToAdmin(env.MM_ADMIN_TOKEN))) {
  const token = await admin.post<{ token: string }>(`/users/${me.id}/tokens`, { description: 'agent provisioning (pnpm dev:seed)' });
  updateEnvFile('MM_ADMIN_TOKEN', token.token);
  console.log(`Created @${adminUsername} access token for agent provisioning (MM_ADMIN_TOKEN in ${envName})`);
}

// --- The brain (docs/brain/01-phase0-plan.md): Mattermost's allow-list, the OAuth app for the pages, the /brain command ---
if (!skipBrain) {
  const brainEnv = loadEnv();
  const pool = createPool(requireValue(brainEnv, 'STATE_DATABASE_URL'));
  try {
    const store = new BrainStore(pool);
    await store.init();
    // The key store's table is in the identity schema; on a fresh database no service has created it yet.
    await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
    const result = await ensureMattermostIntegration({
      adminChat: new MattermostChatClient(mmUrl, requireValue(brainEnv, 'MM_ADMIN_TOKEN')),
      store,
      keyStore: new KeyStore(pool, requireValue(brainEnv, 'KEY_ENCRYPTION_KEY')),
      publicUrl: brainEnv.BRAIN_PUBLIC_URL || 'http://localhost:9120',
      internalUrl: brainEnv.BRAIN_INTERNAL_URL || 'http://host.docker.internal:9120',
      log: createLogger('seed', 'warn'),
    });
    console.log(`Brain registered with Mattermost: /brain in ${result.commands.length} team(s), OAuth app ${result.oauthClientId}, allow-listed ${result.allowedHost}`);
  } finally {
    await pool.end();
  }
}

// --- Relay ---
if (!skipRelay) {
  const bridge = identityFromHex(requireValue(env, 'BRIDGE_SECRET_KEY'));
  const reader = identityFromHex(requireValue(env, 'READER_SECRET_KEY'));
  if (requireValue(env, 'RELAY_OWNER_PUBKEY') !== bridge.pubkey) {
    throw new Error('RELAY_OWNER_PUBKEY does not match BRIDGE_SECRET_KEY. Run `pnpm dev:up` to re-derive it, then restart the relay.');
  }
  if (!(await canAuthenticate(env, bridge))) throw new Error('The bridge key cannot authenticate to the relay; is it the relay owner?');
  if (!(await canAuthenticate(env, reader))) {
    await ensureRelayMember(env, bridge, reader.pubkey);
    if (!(await canAuthenticate(env, reader))) throw new Error('Reader key still cannot authenticate after being added as a relay member');
    console.log('Added the reader key as a relay member');
  }
}

console.log(
  `Seed complete. Team ${teamName}; people ${people.map((p) => `@${p}`).join(', ')}; bot @${botUsername}; ${skipRelay ? 'relay skipped' : 'reader key is a relay member'}.`,
);
console.log(`Passwords and tokens are in ${envName}.`);
