// BrainClient: the seam to the enterprise brain (docs/agents-and-ingestion.md, A.6). Agents search it;
// ingestion keeps its index in step with the relay. Until a brain API exists (Q3), PostgresBrainClient
// (brain-postgres.ts) stands in behind the same interface (D34).

export interface RetrievedPassage {
  id: string;
  text: string;
  title?: string;
  sourceUrl?: string;
  channelId?: string;
  score?: number;
}

export interface BrainDocument {
  /** `thread:{relay_channel_id}:{root_event_id}`, plus `:{n}` for chunks of long threads. */
  id: string;
  text: string;
  channelId: string;
  channelName: string;
  authors: { id: string; name: string }[];
  firstAt: Date;
  lastAt: Date;
  sourceUrl?: string | undefined;
  eventIds: string[];
}

export interface BrainSearchInput {
  query: string;
  /** Access scope: the channel the question was asked in. */
  channelId: string;
  /** The person who asked (pubkey), for brains that scope by person. */
  requesterId?: string;
  /** The agent's knowledge_scope (collections). */
  scope?: string[];
  limit: number;
}

/** What the brain must know about a channel to decide, at query time, who may see its documents (B.3). */
export interface BrainChannel {
  channelId: string;
  name: string;
  visibility: 'open' | 'private';
  /** False while the channel is paused or archived: keep its documents, never retrieve them (Q4). */
  active: boolean;
}

export interface BrainClient {
  search(input: BrainSearchInput): Promise<RetrievedPassage[]>;
  upsertDocuments(docs: BrainDocument[]): Promise<void>;
  deleteDocuments(ids: string[]): Promise<void>;
  upsertChannels(channels: BrainChannel[]): Promise<void>;
}

/** The id of a thread's document; long threads have chunks `<id>:<n>` (B.2). */
export function threadDocId(relayChannelId: string, rootEventId: string): string {
  return `thread:${relayChannelId}:${rootEventId}`;
}

/** True for the document, or a chunk, of the given thread. */
export function isThreadDoc(id: string, relayChannelId: string, rootEventId: string): boolean {
  const base = threadDocId(relayChannelId, rootEventId);
  return id === base || id.startsWith(`${base}:`);
}

/** A brain that finds nothing and stores nothing (tests that do not need retrieval). */
export class NullBrainClient implements BrainClient {
  search(): Promise<RetrievedPassage[]> {
    return Promise.resolve([]);
  }

  upsertDocuments(): Promise<void> {
    return Promise.resolve();
  }

  deleteDocuments(): Promise<void> {
    return Promise.resolve();
  }

  upsertChannels(): Promise<void> {
    return Promise.resolve();
  }
}
