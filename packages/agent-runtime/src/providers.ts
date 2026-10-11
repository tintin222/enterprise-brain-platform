// Choosing the LlmProvider for an agent: "echo" for the deterministic echo model, otherwise the Anthropic
// provider (D21). Without ANTHROPIC_API_KEY, model agents fail with a clear error (and an apology reply).
import type { RuntimeConfig } from './config.ts';
import { AnthropicProvider } from './llm/anthropic.ts';
import { ECHO_MODEL, EchoProvider } from './llm/echo.ts';
import type { LlmProvider } from './llm/types.ts';
import type { AgentRecord } from './registry.ts';

export function providersFromConfig(config: RuntimeConfig): (agent: AgentRecord) => LlmProvider {
  const echo = new EchoProvider();
  const anthropic = config.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, effort: config.LLM_EFFORT, maxTokens: config.LLM_MAX_TOKENS }) : undefined;
  const missingKey: LlmProvider = { generate: () => Promise.reject(new Error('ANTHROPIC_API_KEY is not set; only agents with model "echo" can answer')) };
  return (agent) => (agent.model === ECHO_MODEL ? echo : (anthropic ?? missingKey));
}
