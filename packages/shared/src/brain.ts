// BrainClient: the seam to the enterprise brain (docs/agents-and-ingestion.md, A.6). Agents search it;
// ingestion keeps its index in step with the relay. Until a brain API exists (Q3), a local implementation
// stands in behind the same interface.

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

export interface BrainClient {
  search(input: BrainSearchInput): Promise<RetrievedPassage[]>;
  upsertDocuments(docs: BrainDocument[]): Promise<void>;
  deleteDocuments(ids: string[]): Promise<void>;
}

/** Retrieval stub used until real retrieval exists (Phase 3): finds nothing, stores nothing. */
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
}
