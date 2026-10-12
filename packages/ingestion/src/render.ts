// Thread documents (docs/agents-and-ingestion.md B.2): a thread rendered as "Author: message" lines in time
// order, split into overlapping chunks when long. Pure functions.
import { messageTimeMs, tagValue, threadDocId, threadOrder, type BrainDocument, type MessageAnchor, type NostrEvent } from '@brain/shared';

export type ThreadMessage = Pick<NostrEvent, 'id' | 'pubkey' | 'content' | 'created_at' | 'tags'>;

/**
 * Group consecutive items into chunks of at most `maxChars` (joined by newlines), each chunk repeating the
 * last `overlap` items of the previous one. An item longer than `maxChars` becomes a chunk of its own.
 */
export function chunk(items: string[], maxChars: number, overlap = 1): number[][] {
  const chunks: number[][] = [];
  let start = 0;
  while (start < items.length) {
    const current: number[] = [];
    let size = 0;
    for (let i = start; i < items.length; i++) {
      const cost = items[i]!.length + (current.length > 0 ? 1 : 0);
      if (current.length > 0 && size + cost > maxChars) break;
      current.push(i);
      size += cost;
    }
    chunks.push(current);
    const end = current.at(-1)!;
    if (end >= items.length - 1) break;
    // Step forward, keeping the overlap but always making progress.
    start = Math.max(end + 1 - overlap, current[0]! + 1);
  }
  return chunks;
}

export interface ThreadDocumentInput {
  channelId: string;
  channelName: string;
  rootId: string;
  /** The thread's messages with edits applied, in any order. */
  messages: ThreadMessage[];
  names: Map<string, string>;
  sourceUrl?: string | undefined;
  /** The permalink of a Mattermost post, for message anchors. */
  permalink?: ((postId: string) => string) | undefined;
  chunkChars: number;
}

/** The thread's document, or its chunks (`<id>:<n>`) when the text is longer than `chunkChars`. */
export function buildThreadDocuments(input: ThreadDocumentInput): BrainDocument[] {
  const messages = threadOrder(input.messages, input.rootId);
  if (messages.length === 0) return [];
  const nameOf = (pubkey: string): string => input.names.get(pubkey) ?? 'someone';
  const lines = messages.map((message) => `${nameOf(message.pubkey)}: ${message.content}`);
  const groups = lines.join('\n').length <= input.chunkChars ? [lines.map((_, i) => i)] : chunk(lines, input.chunkChars);
  const base = threadDocId(input.channelId, input.rootId);
  return groups.map((group, n) => {
    const part = group.map((i) => messages[i]!);
    const authors = [...new Map(part.map((message) => [message.pubkey, { id: message.pubkey, name: nameOf(message.pubkey) }])).values()];
    const anchors: MessageAnchor[] = part.map((message) => {
      const postId = tagValue(message, 'mm');
      return { eventId: message.id, author: message.pubkey, at: new Date(messageTimeMs(message)), postId, url: postId && input.permalink ? input.permalink(postId) : undefined };
    });
    return {
      id: groups.length === 1 ? base : `${base}:${n}`,
      text: group.map((i) => lines[i]!).join('\n'),
      channelId: input.channelId,
      channelName: input.channelName,
      authors,
      firstAt: new Date(messageTimeMs(part[0]!)),
      lastAt: new Date(messageTimeMs(part.at(-1)!)),
      sourceUrl: input.sourceUrl,
      eventIds: part.map((message) => message.id),
      anchors,
    };
  });
}
