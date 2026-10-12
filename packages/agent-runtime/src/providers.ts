// Choosing the LlmProvider for an agent (D21, D54): by the agent's provider and model, from the installation
// config. A vendor without a key still has a provider, which fails with a clear error (and an apology reply).
import { LlmProviders, type LlmProvider } from '@brain/models';
import type { RuntimeConfig } from './config.ts';
import type { AgentRecord } from './registry.ts';

export function providersFromConfig(config: RuntimeConfig): (agent: AgentRecord) => LlmProvider {
  const providers = new LlmProviders(config);
  return (agent) => providers.for(agent.provider, agent.model);
}
