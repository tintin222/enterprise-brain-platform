// Model access for agents and the brain (spec section 5, "shared agent runtime"): one LlmProvider interface
// with Anthropic, Google and echo implementations, and one EmbeddingProvider interface (D53, D54, D56).
// Model ids always come from configuration (D21).
import type { RetrievedPassage } from '@brain/shared';

export type { RetrievedPassage };

export type ProviderName = 'anthropic' | 'google' | 'echo';

export interface ConversationTurn {
  author: string;
  role: 'person' | 'agent';
  /** ISO time the message was written. */
  time: string;
  text: string;
  /** True for the agent's own earlier messages. */
  self?: boolean;
}

/** A tool the model may call; `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  /** The provider's id for the call, echoed back with the result. */
  id: string;
  name: string;
  input: unknown;
}

/** One executed tool call, kept for traces (NFR-8). */
export interface ToolExecution {
  call: ToolCall;
  output: unknown;
  error?: string;
  ms: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  thoughtTokens?: number;
}

/** The channel a reply goes to. Members can edit both fields, so they are data, never instructions. */
export interface ChannelContext {
  name: string;
  about: string;
}

export interface GenerateInput {
  model: string;
  /** The agent's standing instructions (system prompt), from the registry or playbook only. */
  instructions: string;
  channel?: ChannelContext;
  /** Untrusted chat content, oldest first; the last turn is the message to answer. */
  conversation: ConversationTurn[];
  knowledge: RetrievedPassage[];
  /** Only tools on the agent's allow-list. */
  tools: ToolSpec[];
  /** Runs a tool call; without it, tool calls end the generation. */
  runTool?: (call: ToolCall) => Promise<unknown>;
  /** Rounds of tool calls before the provider stops asking the model (default 8). */
  maxToolRounds?: number;
}

export interface GenerateResult {
  text: string;
  toolCalls?: ToolExecution[];
  usage: Usage;
  /** The model declined (after any server-side fallback). */
  refused?: boolean;
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  /** The configured model for this provider, used when an agent names none. */
  readonly defaultModel: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export type EmbeddingPurpose = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** Unit-length vectors, one per text, in order. */
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}
