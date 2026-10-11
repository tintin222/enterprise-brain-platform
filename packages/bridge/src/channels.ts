// Channel lifecycle (docs/bridge-spec.md section 4): a channel is agent-enabled while @brain is a member.
import { errorFields, nowSeconds, RelayError, relayChannelIdFor, type ChatClient, type Logger, type RelayClient, type Signer } from '@brain/shared';
import { buildCreateChannelEvent } from './events.ts';
import type { IdentityService } from './identities.ts';
import type { BridgeStore, ChannelRow } from './store.ts';

export function cursorStream(mmChannelId: string): string {
  return `mm:${mmChannelId}`;
}

export interface ChannelServiceDeps {
  chat: ChatClient;
  relay: RelayClient;
  store: BridgeStore;
  identities: IdentityService;
  bridgeSigner: Signer;
  readerPubkey: string;
  botUserId: string;
  log: Logger;
}

export class ChannelService {
  readonly #deps: ChannelServiceDeps;
  /** Relay channel id -> pubkeys this process has already added (kind 9000 is idempotent, this saves calls). */
  readonly #members = new Map<string, Set<string>>();

  constructor(deps: ChannelServiceDeps) {
    this.#deps = deps;
  }

  /** Enable mirroring for a Mattermost channel: relay channel, mapping, reader and member keys. */
  async enable(mmChannelId: string): Promise<ChannelRow | undefined> {
    const { chat, relay, store, bridgeSigner, log } = this.#deps;
    const channel = await chat.getChannel(mmChannelId);
    if (!channel || channel.delete_at !== 0 || (channel.type !== 'O' && channel.type !== 'P')) {
      log.info({ mmChannelId, type: channel?.type }, 'Not enabling: not an open or private channel');
      return undefined;
    }
    const previous = await store.getChannel(mmChannelId);
    const relayChannelId = previous?.relayChannelId ?? relayChannelIdFor(mmChannelId);
    const visibility = channel.type === 'P' ? 'private' : 'open';
    const create = bridgeSigner.sign(buildCreateChannelEvent({ relayChannelId, name: channel.display_name || channel.name, visibility, about: channel.purpose, nowMs: Date.now() }));
    await relay.publish(create, bridgeSigner);

    const row = await store.activateChannel({ mmChannelId, mmTeamId: channel.team_id, relayChannelId, visibility });
    if (previous?.state !== 'active') await store.setCursor(cursorStream(mmChannelId), row.enabledAt.getTime());

    await this.ensureMember(row, this.#deps.readerPubkey);
    const memberIds = (await chat.getChannelMemberIds(mmChannelId)).filter((id) => id !== this.#deps.botUserId);
    for (const user of await chat.getUsersByIds(memberIds)) {
      if (user.delete_at !== 0) continue;
      try {
        const identity = await this.#deps.identities.forUser(user);
        await this.ensureMember(row, identity.pubkey);
      } catch (error) {
        log.error({ mmChannelId, mmUserId: user.id, ...errorFields(error) }, 'Could not mirror channel member');
      }
    }
    log.info({ mmChannelId, relayChannelId, visibility, members: memberIds.length }, previous?.state === 'active' ? 'Channel re-synced' : 'Channel enabled');
    return row;
  }

  /** Add a key to the relay channel (kind 9000 by the bridge, the channel owner). */
  async ensureMember(channel: ChannelRow, pubkey: string): Promise<void> {
    const known = this.#members.get(channel.relayChannelId) ?? new Set<string>();
    if (known.has(pubkey)) return;
    const { bridgeSigner, relay, log } = this.#deps;
    const add = bridgeSigner.sign({ kind: 9000, tags: [['h', channel.relayChannelId], ['p', pubkey]], content: '', created_at: nowSeconds() });
    try {
      await relay.publish(add, bridgeSigner);
    } catch (error) {
      // An agent can refuse additions with its own channel_add_policy (spike A6); report, don't retry.
      if (error instanceof RelayError && !error.retryable) {
        log.warn({ relayChannelId: channel.relayChannelId, pubkey, ...errorFields(error) }, 'Relay refused channel membership');
        return;
      }
      throw error;
    }
    known.add(pubkey);
    this.#members.set(channel.relayChannelId, known);
  }

  /** Remove a key from the relay channel (kind 9001 by the bridge). */
  async removeMember(channel: ChannelRow, pubkey: string): Promise<void> {
    const { bridgeSigner, relay, log } = this.#deps;
    const remove = bridgeSigner.sign({ kind: 9001, tags: [['h', channel.relayChannelId], ['p', pubkey]], content: '', created_at: nowSeconds() });
    try {
      await relay.publish(remove, bridgeSigner);
    } catch (error) {
      if (error instanceof RelayError && !error.retryable) {
        log.warn({ relayChannelId: channel.relayChannelId, pubkey, ...errorFields(error) }, 'Relay refused channel removal');
      } else throw error;
    }
    this.#members.get(channel.relayChannelId)?.delete(pubkey);
  }

  async pause(mmChannelId: string): Promise<void> {
    const row = await this.#deps.store.getChannel(mmChannelId);
    if (row?.state !== 'active') return;
    await this.#deps.store.setChannelState(mmChannelId, 'paused');
    this.#deps.log.info({ mmChannelId }, 'Channel paused: @brain is no longer a member');
  }
}
