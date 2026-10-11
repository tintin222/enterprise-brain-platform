// Trigger rules (docs/agents-and-ingestion.md, A.3): which agents should answer a relay event. Pure.
import { isBackfill, messageTimeSeconds, tagValues, type NostrEvent } from '@brain/shared';
import type { AgentRecord } from './registry.ts';

export type EventSkip = 'not a chat message' | 'history (backfill)' | 'too old';
export type AgentSkip = 'own message' | 'agent author without an explicit mention' | 'membership unknown' | 'not a channel member';

export interface TriggerInput {
  event: NostrEvent;
  /** Agents that may answer. */
  activeAgents: AgentRecord[];
  /** Pubkeys of every registered agent, active or not (to recognise agent authors). */
  agentPubkeys: ReadonlySet<string>;
  /** Current channel members (kind 39002), or undefined if not known yet. */
  members: ReadonlySet<string> | undefined;
  nowSeconds: number;
  maxEventAgeSeconds: number;
}

export interface TriggerResult {
  triggered: AgentRecord[];
  eventSkip?: EventSkip;
  skipped: { agent: AgentRecord; reason: AgentSkip }[];
}

/** An agent-authored message must name the agent in its text, not only in a p tag. */
export function mentionsExplicitly(content: string, agent: Pick<AgentRecord, 'handle' | 'displayName'>): boolean {
  const text = content.toLowerCase();
  return text.includes(`@${agent.handle.toLowerCase()}`) || text.includes(`@${agent.displayName.toLowerCase()}`);
}

export function evaluateTriggers(input: TriggerInput): TriggerResult {
  const { event } = input;
  if (event.kind !== 9) return { triggered: [], skipped: [], eventSkip: 'not a chat message' };
  if (isBackfill(event)) return { triggered: [], skipped: [], eventSkip: 'history (backfill)' };
  if (input.nowSeconds - messageTimeSeconds(event) > input.maxEventAgeSeconds) return { triggered: [], skipped: [], eventSkip: 'too old' };

  const mentioned = new Set(tagValues(event, 'p'));
  const authorIsAgent = input.agentPubkeys.has(event.pubkey);
  const result: TriggerResult = { triggered: [], skipped: [] };
  for (const agent of input.activeAgents) {
    if (!mentioned.has(agent.nostrPubkey)) continue;
    let reason: AgentSkip | undefined;
    if (agent.nostrPubkey === event.pubkey) reason = 'own message';
    else if (authorIsAgent && !mentionsExplicitly(event.content, agent)) reason = 'agent author without an explicit mention';
    else if (!input.members) reason = 'membership unknown';
    else if (!input.members.has(agent.nostrPubkey)) reason = 'not a channel member';
    if (reason) result.skipped.push({ agent, reason });
    else result.triggered.push(agent);
  }
  return result;
}

/** Member pubkeys from a kind 39002 list (`["p", hex, "", role]` tags). */
export function membersOf(list: Pick<NostrEvent, 'tags'>): Set<string> {
  return new Set(tagValues(list, 'p'));
}
