// Context assembly (docs/agents-and-ingestion.md, A.4): the thread up to the triggering message, channel
// background, and names, read from the relay with the reader key.
import { messageTimeSeconds, tagValue, type NostrEvent, type RelayClient, type Signer } from '@brain/shared';
import type { ConversationTurn } from './llm/types.ts';

const PROFILE_TTL_MS = 10 * 60 * 1000;

/** Display names from kind 0 profiles, cached. */
export class ProfileNames {
  readonly #relay: RelayClient;
  readonly #reader: Signer;
  readonly #cache = new Map<string, { name: string; expires: number }>();

  constructor(relay: RelayClient, reader: Signer) {
    this.#relay = relay;
    this.#reader = reader;
  }

  async names(pubkeys: string[]): Promise<Map<string, string>> {
    const now = Date.now();
    const missing = [...new Set(pubkeys)].filter((pubkey) => (this.#cache.get(pubkey)?.expires ?? 0) < now);
    if (missing.length > 0) {
      const profiles = await this.#relay.query([{ kinds: [0], authors: missing }], this.#reader);
      for (const pubkey of missing) {
        const profile = profiles.find((event) => event.pubkey === pubkey);
        let name = 'someone';
        if (profile) {
          try {
            const content = JSON.parse(profile.content) as { display_name?: string; name?: string };
            name = content.display_name || content.name || name;
          } catch {
            // keep the fallback
          }
        }
        this.#cache.set(pubkey, { name, expires: now + PROFILE_TTL_MS });
      }
    }
    return new Map(pubkeys.map((pubkey) => [pubkey, this.#cache.get(pubkey)?.name ?? 'someone']));
  }
}

export interface ChannelInfo {
  name: string;
  about: string;
}

export async function channelInfo(relay: RelayClient, reader: Signer, channelId: string): Promise<ChannelInfo> {
  const [metadata] = await relay.query([{ kinds: [39000], '#d': [channelId], limit: 1 }], reader);
  return { name: (metadata && tagValue(metadata, 'name')) ?? 'channel', about: (metadata && tagValue(metadata, 'about')) ?? '' };
}

/**
 * The thread root and its replies up to the trigger, oldest first, with the trigger last. When the thread is
 * short, the few channel messages before it are added as background.
 */
export async function threadEvents(relay: RelayClient, reader: Signer, channelId: string, rootId: string, trigger: NostrEvent): Promise<NostrEvent[]> {
  const found = await relay.query([{ ids: [rootId] }, { kinds: [9], '#h': [channelId], '#e': [rootId], limit: 500 }], reader);
  const byId = new Map(found.filter((event) => event.kind === 9).map((event) => [event.id, event]));
  byId.delete(trigger.id);
  const thread = [...byId.values()].filter((event) => event.created_at <= trigger.created_at).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  thread.push(trigger);
  if (thread.length < 3) {
    const root = thread[0] ?? trigger;
    const before = await relay.query([{ kinds: [9], '#h': [channelId], until: root.created_at - 1, limit: 5 }], reader);
    thread.unshift(...before.filter((event) => !byId.has(event.id) && event.id !== trigger.id).sort((a, b) => a.created_at - b.created_at));
  }
  return thread;
}

/** Turn events into conversation turns within a character budget, keeping the first and the most recent. */
export function toConversation(events: NostrEvent[], names: Map<string, string>, agentPubkeys: ReadonlySet<string>, selfPubkey: string, budgetChars: number): ConversationTurn[] {
  const turns = events.map(
    (event): ConversationTurn => ({
      author: names.get(event.pubkey) ?? 'someone',
      role: agentPubkeys.has(event.pubkey) ? 'agent' : 'person',
      time: new Date(messageTimeSeconds(event) * 1000).toISOString(),
      text: event.content,
      ...(event.pubkey === selfPubkey ? { self: true } : {}),
    }),
  );
  if (turns.length <= 2) return turns;
  const size = (turn: ConversationTurn): number => turn.text.length + turn.author.length + 40;
  const first = turns[0]!;
  let used = size(first);
  const recent: ConversationTurn[] = [];
  for (let i = turns.length - 1; i >= 1; i--) {
    const turn = turns[i]!;
    if (recent.length > 0 && used + size(turn) > budgetChars) break;
    recent.unshift(turn);
    used += size(turn);
  }
  return recent.length === turns.length - 1 ? turns : [first, { author: 'system', role: 'person', time: first.time, text: '[earlier messages omitted]' }, ...recent];
}
