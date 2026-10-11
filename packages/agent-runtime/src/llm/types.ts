// LlmProvider (docs/agents-and-ingestion.md, A.6). The model id always comes from configuration.
import type { RetrievedPassage } from '@brain/shared';

export type { RetrievedPassage };

export interface ConversationTurn {
  author: string;
  role: 'person' | 'agent';
  /** ISO time the message was written. */
  time: string;
  text: string;
  /** True for the agent's own earlier messages. */
  self?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateInput {
  model: string;
  /** The agent's standing instructions (system prompt), from the registry only. */
  instructions: string;
  /** Untrusted chat content, oldest first; the last turn is the message to answer. */
  conversation: ConversationTurn[];
  knowledge: RetrievedPassage[];
  /** Only tools on the agent's allow-list. */
  tools: ToolSpec[];
}

export interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
  usage: Usage;
  /** The model declined (after any server-side fallback). */
  refused?: boolean;
}

export interface LlmProvider {
  generate(input: GenerateInput): Promise<GenerateResult>;
}
