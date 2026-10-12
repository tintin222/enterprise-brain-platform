// The agent registry (docs/agents-and-ingestion.md, A.1). If the brain stores agent definitions, an
// adapter replaces this table and only the chat-specific fields stay here.
import path from 'node:path';
import type { Queryable } from '@brain/shared';

export const RUNTIME_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

export interface AgentRecord {
  agentId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  instructions: string;
  /** The model vendor; empty means the installation default (LLM_PROVIDER). */
  provider: AgentProvider;
  /** Model id for the LLM provider; empty means the provider's configured default. "echo" selects the echo provider. */
  model: string;
  tools: string[];
  knowledgeScope: string[];
  nostrPubkey: string;
  mmBotUserId: string;
  status: 'active' | 'disabled';
}

export type AgentProvider = '' | 'anthropic' | 'google' | 'echo';

interface AgentRow {
  agent_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  instructions: string;
  provider: AgentProvider;
  model: string;
  tools: string[];
  knowledge_scope: string[];
  nostr_pubkey: string;
  mm_bot_user_id: string;
  status: 'active' | 'disabled';
}

const COLUMNS = 'agent_id, handle, display_name, avatar_url, instructions, provider, model, tools, knowledge_scope, nostr_pubkey, mm_bot_user_id, status';

const toRecord = (r: AgentRow): AgentRecord => ({
  agentId: r.agent_id,
  handle: r.handle,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  instructions: r.instructions,
  provider: r.provider,
  model: r.model,
  tools: r.tools,
  knowledgeScope: r.knowledge_scope,
  nostrPubkey: r.nostr_pubkey,
  mmBotUserId: r.mm_bot_user_id,
  status: r.status,
});

export class AgentRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async getByHandle(handle: string): Promise<AgentRecord | undefined> {
    const r = await this.#db.query<AgentRow>(`SELECT ${COLUMNS} FROM runtime.agents WHERE handle = $1`, [handle]);
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }

  async getByPubkey(pubkey: string): Promise<AgentRecord | undefined> {
    const r = await this.#db.query<AgentRow>(`SELECT ${COLUMNS} FROM runtime.agents WHERE nostr_pubkey = $1`, [pubkey]);
    return r.rows[0] ? toRecord(r.rows[0]) : undefined;
  }

  async listAll(): Promise<AgentRecord[]> {
    const r = await this.#db.query<AgentRow>(`SELECT ${COLUMNS} FROM runtime.agents ORDER BY handle`);
    return r.rows.map(toRecord);
  }

  async listActive(): Promise<AgentRecord[]> {
    const r = await this.#db.query<AgentRow>(`SELECT ${COLUMNS} FROM runtime.agents WHERE status = 'active' ORDER BY handle`);
    return r.rows.map(toRecord);
  }

  async upsert(record: AgentRecord): Promise<AgentRecord> {
    const r = await this.#db.query<AgentRow>(
      `INSERT INTO runtime.agents (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (agent_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, instructions = EXCLUDED.instructions,
         provider = EXCLUDED.provider, model = EXCLUDED.model, tools = EXCLUDED.tools, knowledge_scope = EXCLUDED.knowledge_scope,
         status = EXCLUDED.status, updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        record.agentId,
        record.handle,
        record.displayName,
        record.avatarUrl,
        record.instructions,
        record.provider,
        record.model,
        JSON.stringify(record.tools),
        JSON.stringify(record.knowledgeScope),
        record.nostrPubkey,
        record.mmBotUserId,
        record.status,
      ],
    );
    return toRecord(r.rows[0]!);
  }

  async setStatus(agentId: string, status: 'active' | 'disabled'): Promise<void> {
    await this.#db.query('UPDATE runtime.agents SET status = $2, updated_at = now() WHERE agent_id = $1', [agentId, status]);
  }
}
