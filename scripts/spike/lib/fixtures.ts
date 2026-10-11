// Shared setup for spikes: relay members, channels and messages; Mattermost users and channels.
// Everything is created fresh with unique names, so spikes can be re-run against the same stack.
import { randomBytes, randomUUID } from 'node:crypto';
import { requireValue } from '../../lib/env.ts';
import { MattermostApi, type MmUser } from '../../lib/mattermost.ts';
import { newIdentity, sign, type Event, type Identity } from '../../lib/nostr.ts';
import { ensureRelayMember } from '../../lib/relay-admin.ts';
import { RelaySocket, type HttpResult } from '../../lib/relay.ts';
import type { SpikeContext } from './spike.ts';

export function uniqueName(ctx: SpikeContext, label: string): string {
  return `${label}-${ctx.runId}-${randomBytes(2).toString('hex')}`;
}

/** A fresh keypair added as a relay member by the bridge (relay owner). */
export async function newMember(ctx: SpikeContext): Promise<Identity> {
  const identity = newIdentity();
  await ensureRelayMember(ctx.env, ctx.bridge, identity.pubkey);
  return identity;
}

export function accepted(result: HttpResult): boolean {
  const body = result.body as { accepted?: boolean } | null;
  return result.status === 200 && body?.accepted === true;
}

export function resultMessage(result: HttpResult): string {
  const body = result.body as { message?: string; error?: string } | null;
  const text = body?.message ?? body?.error ?? JSON.stringify(result.body);
  return `HTTP ${result.status}${text ? ` "${text}"` : ''}`;
}

/** Publish over HTTP and throw unless the relay accepted the event. */
export async function publishOk(ctx: SpikeContext, identity: Identity, event: Event): Promise<Event> {
  const result = await ctx.relayHttp.publish(identity, event);
  if (!accepted(result)) throw new Error(`kind ${event.kind} rejected: ${resultMessage(result)}`);
  return event;
}

/** Create a channel with a client-chosen UUID (the relay's OK for 9007 does not return the id). */
export async function createChannel(ctx: SpikeContext, owner: Identity, visibility: 'open' | 'private', name = uniqueName(ctx, 'spike')): Promise<string> {
  const channelId = randomUUID();
  await publishOk(ctx, owner, sign(owner, 9007, [['h', channelId], ['name', name], ['visibility', visibility]]));
  return channelId;
}

export function addToChannel(ctx: SpikeContext, actor: Identity, channelId: string, pubkey: string): Promise<HttpResult> {
  return ctx.relayHttp.publish(actor, sign(actor, 9000, [['h', channelId], ['p', pubkey]]));
}

export async function addToChannelOk(ctx: SpikeContext, actor: Identity, channelId: string, pubkey: string): Promise<void> {
  const result = await addToChannel(ctx, actor, channelId, pubkey);
  if (!accepted(result)) throw new Error(`9000 add failed: ${resultMessage(result)}`);
}

export function chatMessage(author: Identity, channelId: string, content: string, extraTags: string[][] = []): Event {
  return sign(author, 9, [['h', channelId], ...extraTags], content);
}

export function connect(ctx: SpikeContext, identity: Identity): Promise<RelaySocket> {
  return RelaySocket.connect(ctx.relayWsUrl, identity);
}

export function newChannelId(): string {
  return randomUUID();
}

// --- Mattermost ---

export async function mmLogin(ctx: SpikeContext, username: string): Promise<{ api: MattermostApi; user: MmUser }> {
  const api = await new MattermostApi(requireValue(ctx.env, 'MM_URL')).login(username, requireValue(ctx.env, 'MM_PERSON_PASSWORD'));
  return { api, user: await api.get<MmUser>('/users/me') };
}

export async function mmTeamId(ctx: SpikeContext): Promise<string> {
  return (await ctx.mmAdmin.get<{ id: string }>(`/teams/name/${requireValue(ctx.env, 'MM_TEAM_NAME')}`)).id;
}

export function mmCreateChannel(api: MattermostApi, teamId: string, type: 'O' | 'P', name: string): Promise<{ id: string; name: string }> {
  return api.post('/channels', { team_id: teamId, name, display_name: name, type });
}

export async function mmAddMember(api: MattermostApi, channelId: string, userId: string): Promise<void> {
  await api.post(`/channels/${channelId}/members`, { user_id: userId });
}
