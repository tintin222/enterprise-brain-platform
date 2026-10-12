// Agent provisioning (docs/agents-and-ingestion.md, A.2). One operation, safe to re-run: Nostr key and
// bot token in the shared key store (D19), Mattermost bot in the team, identity registered on the relay
// (membership and profile, like the bridge does for people), registry record.
import {
  ensureProfile,
  ensureRelayMembership,
  IDENTITY_MIGRATIONS_DIR,
  IdentityRepository,
  migrate,
  secretRefs,
  type ChatClient,
  type KeyStore,
  type Logger,
  type MmUser,
  type Pool,
  type RelayClient,
  type Signer,
} from '@brain/shared';
import { AgentRepository, RUNTIME_MIGRATIONS_DIR, type AgentRecord } from './registry.ts';

export interface ProvisionInput {
  /** Mattermost username of the agent's bot: 3-22 characters, lowercase letters, digits, ".", "-", "_". */
  handle: string;
  displayName: string;
  description?: string;
  instructions?: string;
  model?: string;
  tools?: string[];
  knowledgeScope?: string[];
}

export interface ProvisionDeps {
  pool: Pool;
  /** A Mattermost client acting as an admin user: bots cannot create bots, even as system admins (D25). */
  chat: ChatClient;
  relay: RelayClient;
  keyStore: KeyStore;
  /** The relay owner (bridge) key, which adds relay members. */
  bridgeSigner: Signer;
  teamName: string;
  log: Logger;
}

const HANDLE = /^[a-z][a-z0-9._-]{2,21}$/;

async function tokenWorks(chat: ChatClient, token: string, userId: string): Promise<boolean> {
  try {
    return (await chat.withToken(token).getMe()).id === userId;
  } catch {
    return false;
  }
}

export async function provisionAgent(deps: ProvisionDeps, input: ProvisionInput): Promise<AgentRecord> {
  const { pool, chat, relay, keyStore, bridgeSigner, log } = deps;
  if (!HANDLE.test(input.handle)) throw new Error(`Invalid agent handle "${input.handle}"`);
  await migrate(pool, 'identity', IDENTITY_MIGRATIONS_DIR);
  await migrate(pool, 'runtime', RUNTIME_MIGRATIONS_DIR);

  const keyRef = secretRefs.agentKey(input.handle);
  const pubkey = await keyStore.createNostrKey(keyRef, 'agent');

  let [user]: (MmUser | undefined)[] = await chat.getUsersByUsernames([input.handle]);
  if (user && !user.is_bot) throw new Error(`@${input.handle} already exists and is not a bot`);
  if (!user) {
    const bot = await chat.createBot({ username: input.handle, display_name: input.displayName, description: input.description ?? `Agent ${input.displayName}` });
    user = await chat.getUser(bot.user_id);
    if (!user) throw new Error(`Bot @${input.handle} was created but cannot be read back`);
    log.info({ handle: input.handle, mmUserId: user.id }, 'Created agent bot');
  } else if (user.delete_at !== 0) {
    await chat.enableBot(user.id);
  }

  // Register the identity before the bot joins the team: Mattermost then adds it to the default channels, and
  // a running bridge that saw an unknown bot there would register it as a person.
  const identities = new IdentityRepository(pool);
  let identity = await identities.insertIfAbsent({ mmUserId: user.id, kind: 'agent', pubkey, secretRef: keyRef });
  if (identity.kind === 'person' && user.is_bot) {
    // That race, from before this order: the bot is being provisioned as an agent, so it is one.
    identity = (await identities.convertToAgent(user.id, pubkey, keyRef)) ?? identity;
    log.warn({ handle: input.handle, mmUserId: user.id }, 'The bot had been registered as a person; it is now registered as the agent');
  }
  if (identity.kind !== 'agent' || identity.pubkey !== pubkey) {
    throw new Error(`Mattermost user @${input.handle} is already mapped to another identity (${identity.kind})`);
  }

  const team = await chat.getTeamByName(deps.teamName);
  if (!team) throw new Error(`Team ${deps.teamName} not found`);
  await chat.addTeamMember(team.id, user.id);

  const tokenRef = secretRefs.agentToken(user.id);
  const storedToken = await keyStore.getSecretText(tokenRef);
  if (!storedToken || !(await tokenWorks(chat, storedToken, user.id))) {
    const token = await chat.createUserAccessToken(user.id, 'agent (provisioning)');
    if (storedToken) await keyStore.replaceSecret(tokenRef, token);
    else await keyStore.putSecret(tokenRef, 'agent-token', token);
  }

  const ctx = { relay, bridgeSigner, identities, keyStore };
  identity = await ensureRelayMembership(ctx, identity);
  await ensureProfile(ctx, identity, { username: input.handle, displayName: input.displayName, pictureUrl: `${chat.baseUrl}/api/v4/users/${user.id}/image` });

  const agents = new AgentRepository(pool);
  const previous = await agents.getByHandle(input.handle);
  return agents.upsert({
    agentId: input.handle,
    handle: input.handle,
    displayName: input.displayName,
    avatarUrl: previous?.avatarUrl ?? null,
    instructions: input.instructions ?? previous?.instructions ?? '',
    model: input.model ?? previous?.model ?? '',
    tools: input.tools ?? previous?.tools ?? [],
    knowledgeScope: input.knowledgeScope ?? previous?.knowledgeScope ?? [],
    nostrPubkey: pubkey,
    mmBotUserId: user.id,
    status: 'active',
  });
}
