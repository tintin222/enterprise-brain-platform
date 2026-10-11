// Channel lifecycle (docs/bridge-spec.md section 4): a channel is agent-enabled while @brain is a member.
// Pausing or archiving removes the reader key from the relay channel, which tells agent-runtime and
// ingestion (through the reader's membership notifications) to stop using it (D28).
import {
  errorFields,
  nowSeconds,
  RelayError,
  relayChannelIdFor,
  type ChatClient,
  type Logger,
  type MmChannel,
  type PublishResult,
  type RelayClient,
  type Signer,
  type UnsignedEvent,
} from '@brain/shared';
import { buildArchiveEvent, buildChannelMetadataEvent, buildCreateChannelEvent, channelMetadata, metadataHash } from './events.ts';
import type { IdentityService } from './identities.ts';
import type { BridgeStore, ChannelRow } from './store.ts';

export function cursorStream(mmChannelId: string): string {
  return `mm:${mmChannelId}`;
}

/** Marks the enablement (its enabled_at, ms) whose backfill has finished. */
export function backfillStream(mmChannelId: string): string {
  return `backfill:${mmChannelId}`;
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

export interface MemberDiff {
  added: string[];
  removed: string[];
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
    const { chat, store, log } = this.#deps;
    const channel = await chat.getChannel(mmChannelId);
    if (!channel || channel.delete_at !== 0 || (channel.type !== 'O' && channel.type !== 'P')) {
      log.info({ mmChannelId, type: channel?.type }, 'Not enabling: not an open or private channel');
      return undefined;
    }
    const previous = await store.getChannel(mmChannelId);
    const relayChannelId = previous?.relayChannelId ?? relayChannelIdFor(mmChannelId);
    const metadata = channelMetadata(channel);
    // An archived relay channel refuses every event, the create included.
    if (previous?.state === 'archived') await this.#publish(buildArchiveEvent(relayChannelId, false, Date.now()));
    const created = await this.#publish(buildCreateChannelEvent({ relayChannelId, ...metadata, nowMs: Date.now() }));
    const hash = metadataHash(metadata);
    // A relay channel that already existed may carry an older name, about text or visibility.
    if ((previous || created.duplicate) && previous?.metadataHash !== hash) await this.#publish(buildChannelMetadataEvent({ relayChannelId, ...metadata, nowMs: Date.now() }));

    const row = await store.activateChannel({ mmChannelId, mmTeamId: channel.team_id, relayChannelId, visibility: metadata.visibility, metadataHash: hash });
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
    log.info({ mmChannelId, relayChannelId, visibility: metadata.visibility, members: memberIds.length }, previous?.state === 'active' ? 'Channel re-synced' : 'Channel enabled');
    return row;
  }

  #publish(unsigned: UnsignedEvent): Promise<PublishResult> {
    const { bridgeSigner, relay } = this.#deps;
    return relay.publish(bridgeSigner.sign(unsigned), bridgeSigner);
  }

  /** Publish the channel's current name, about text and visibility if they changed (kind 9002). */
  async syncMetadata(row: ChannelRow, channel: MmChannel): Promise<boolean> {
    if (row.state !== 'active' || (channel.type !== 'O' && channel.type !== 'P')) return false;
    const metadata = channelMetadata(channel);
    const hash = metadataHash(metadata);
    if (hash === row.metadataHash) return false;
    await this.#publish(buildChannelMetadataEvent({ relayChannelId: row.relayChannelId, ...metadata, nowMs: Date.now() }));
    await this.#deps.store.setChannelMetadata(row.mmChannelId, metadata.visibility, hash);
    this.#deps.log.info({ mmChannelId: row.mmChannelId, relayChannelId: row.relayChannelId, visibility: metadata.visibility }, 'Channel metadata updated');
    return true;
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

  /**
   * Make the relay channel's members match `desired` (plus the reader). `actual` is the relay's member list
   * (kind 39002); the bridge itself, the channel owner, is never removed. With `allowRemovals` false (some
   * members could not be resolved) only additions are made.
   */
  async reconcileMembers(channel: ChannelRow, desired: Set<string>, actual: Set<string>, allowRemovals = true): Promise<MemberDiff> {
    const want = new Set([...desired, this.#deps.readerPubkey]);
    want.delete(this.#deps.bridgeSigner.pubkey);
    const added = [...want].filter((pubkey) => !actual.has(pubkey));
    const removed = allowRemovals ? [...actual].filter((pubkey) => !want.has(pubkey) && pubkey !== this.#deps.bridgeSigner.pubkey) : [];
    // The relay's list is the truth: forget cached additions it does not show.
    this.#members.set(channel.relayChannelId, new Set([...actual].filter((pubkey) => want.has(pubkey))));
    for (const pubkey of added) await this.ensureMember(channel, pubkey);
    for (const pubkey of removed) await this.removeMember(channel, pubkey);
    if (added.length > 0 || removed.length > 0) {
      this.#deps.log.info({ mmChannelId: channel.mmChannelId, relayChannelId: channel.relayChannelId, added: added.length, removed: removed.length }, 'Reconciled channel members');
    }
    return { added, removed };
  }

  /** @brain left the channel: stop mirroring, keep the relay history (Q4). */
  async pause(mmChannelId: string): Promise<void> {
    const row = await this.#deps.store.getChannel(mmChannelId);
    if (row?.state !== 'active') return;
    await this.removeMember(row, this.#deps.readerPubkey);
    await this.#deps.store.setChannelState(mmChannelId, 'paused');
    this.#deps.log.info({ mmChannelId }, 'Channel paused: @brain is no longer a member');
  }

  /** The channel was archived in Mattermost: stop mirroring and archive the relay channel. */
  async archive(mmChannelId: string): Promise<void> {
    const row = await this.#deps.store.getChannel(mmChannelId);
    if (!row || row.state === 'archived') return;
    // Membership changes are refused once the relay channel is archived, so remove the reader first.
    if (row.state === 'active') await this.removeMember(row, this.#deps.readerPubkey);
    try {
      await this.#publish(buildArchiveEvent(row.relayChannelId, true, Date.now()));
    } catch (error) {
      if (!(error instanceof RelayError) || error.retryable) throw error;
      this.#deps.log.warn({ mmChannelId, ...errorFields(error) }, 'Relay refused to archive the channel');
    }
    await this.#deps.store.setChannelState(mmChannelId, 'archived');
    this.#deps.log.info({ mmChannelId }, 'Channel archived');
  }
}
