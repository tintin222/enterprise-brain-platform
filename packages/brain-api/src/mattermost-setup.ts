// What Mattermost must know about the brain (spikes B1-B3; plan sections 8 and 12), applied by the seed, the
// installer and `POST /api/v1/brain/setup/mattermost`, all idempotent: the brain's address on the server's
// allow-list, a trusted OAuth app for the pages, and the /brain slash command in every team.
import type { BrainStore } from '@brain/brain';
import type { ChatClient, KeyStore, Logger } from '@brain/shared';

export const SETTING_OAUTH_CLIENT = 'mattermost.oauth_client_id';
export const SETTING_COMMANDS = 'mattermost.commands';
export const SECRET_OAUTH_CLIENT = 'brain:oauth:client-secret';
export const secretCommandToken = (teamId: string, trigger: string): string => `brain:command:${teamId}:${trigger}`;

export const COMMAND_TRIGGER = 'brain';

export interface MattermostSetupDeps {
  /** A client acting as a system admin user (D25). */
  adminChat: ChatClient;
  store: BrainStore;
  keyStore: KeyStore;
  publicUrl: string;
  internalUrl: string;
  log: Logger;
}

export interface MattermostSetupResult {
  allowedHost: string;
  oauthClientId: string;
  commands: { teamId: string; commandId: string; created: boolean }[];
}

export async function ensureMattermostIntegration(deps: MattermostSetupDeps): Promise<MattermostSetupResult> {
  const { adminChat, store, keyStore, log } = deps;
  const allowedHost = new URL(deps.internalUrl).hostname;

  // 1. Mattermost refuses to call private addresses unless they are listed (spike B1).
  const config = await adminChat.getConfig();
  const service = (config.ServiceSettings ?? {}) as { AllowedUntrustedInternalConnections?: string; EnableCommands?: boolean; EnableOAuthServiceProvider?: boolean };
  const allowed = new Set((service.AllowedUntrustedInternalConnections ?? '').split(/\s+/).filter(Boolean));
  const patch: Record<string, unknown> = {};
  if (!allowed.has(allowedHost)) {
    allowed.add(allowedHost);
    patch.AllowedUntrustedInternalConnections = [...allowed].join(' ');
  }
  if (service.EnableCommands === false) patch.EnableCommands = true;
  if (service.EnableOAuthServiceProvider === false) patch.EnableOAuthServiceProvider = true;
  if (Object.keys(patch).length > 0) {
    await adminChat.patchConfig({ ServiceSettings: patch });
    log.info({ patch: Object.keys(patch) }, 'Mattermost settings updated for the brain');
  }

  // 2. A trusted OAuth app: the pages sign people in with their chat account (spike B3).
  const callback = `${deps.publicUrl.replace(/\/$/, '')}/auth/callback`;
  let clientId = await store.getSetting<string>(SETTING_OAUTH_CLIENT);
  const apps = await adminChat.listOAuthApps();
  const existing = clientId ? apps.find((app) => app.id === clientId && !app.delete_at) : undefined;
  if (!existing || !existing.callback_urls.includes(callback)) {
    const app = await adminChat.createOAuthApp({ name: 'Enterprise Brain', description: 'The brain pages (sign in with your chat account)', callback_urls: [callback], homepage: deps.publicUrl, is_trusted: true });
    clientId = app.id;
    await store.setSetting(SETTING_OAUTH_CLIENT, clientId);
    if (!(await keyStore.putSecret(SECRET_OAUTH_CLIENT, 'oauth-client-secret', app.client_secret))) await keyStore.replaceSecret(SECRET_OAUTH_CLIENT, app.client_secret);
    log.info({ clientId, callback }, existing ? 'OAuth app recreated for the new callback address' : 'OAuth app created');
  }

  // 3. The /brain slash command in every team the admin belongs to (spike B1).
  const url = `${deps.internalUrl.replace(/\/$/, '')}/mm/commands/${COMMAND_TRIGGER}`;
  const commands: MattermostSetupResult['commands'] = [];
  for (const team of await adminChat.getMyTeams()) {
    const wanted = {
      team_id: team.id,
      trigger: COMMAND_TRIGGER,
      method: 'P' as const,
      url,
      auto_complete: true,
      auto_complete_desc: 'Search the brain, or link this channel to a project or topic',
      auto_complete_hint: 'search <words> | link | help',
      display_name: 'Enterprise Brain',
      description: 'The company brain',
      username: 'brain',
    };
    const current = (await adminChat.listCommands(team.id)).find((command) => command.trigger === COMMAND_TRIGGER && !command.delete_at);
    let command = current;
    let created = false;
    if (!current) {
      command = await adminChat.createCommand(wanted);
      created = true;
    } else if (current.url !== url || current.auto_complete_hint !== wanted.auto_complete_hint || current.display_name !== wanted.display_name) {
      command = await adminChat.updateCommand(current.id, wanted);
    }
    if (!command) continue;
    const ref = secretCommandToken(team.id, COMMAND_TRIGGER);
    const stored = await keyStore.getSecretText(ref);
    if (stored !== command.token) {
      if (stored === undefined) await keyStore.putSecret(ref, 'command-token', command.token);
      else await keyStore.replaceSecret(ref, command.token);
    }
    commands.push({ teamId: team.id, commandId: command.id, created });
    if (created) log.info({ teamId: team.id, commandId: command.id }, 'Registered the /brain command');
  }
  await store.setSetting(SETTING_COMMANDS, commands.map(({ teamId, commandId }) => ({ teamId, commandId })));
  return { allowedHost, oauthClientId: clientId ?? '', commands };
}
