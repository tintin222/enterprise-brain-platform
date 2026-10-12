// Choosing providers from the installation config (D54, D56): one LlmProvider per configured vendor plus echo,
// and the embedding provider. Without a key, a vendor's provider fails with a clear message instead of
// crashing the service at start, so an installation with only one key still runs.
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.ts';
import { ECHO_MODEL, EchoProvider } from './echo.ts';
import { GeminiEmbeddingProvider, MockEmbeddingProvider } from './embeddings.ts';
import { GeminiProvider } from './gemini.ts';
import type { EmbeddingProvider, LlmProvider, ProviderName } from './types.ts';

export const modelConfigSchema = z.object({
  /** The vendor an agent uses when its record names none. */
  LLM_PROVIDER: z.enum(['anthropic', 'google']).default('anthropic'),
  /** Required only for agents on the Anthropic provider. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Default Anthropic model (D21); an agent's own `model` overrides it. */
  LLM_MODEL: z.string().min(1).default('claude-opus-5-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  LLM_MAX_TOKENS: z.coerce.number().int().min(256).default(16_000),
  /** Required for the Google provider and for Google embeddings. */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-pro'),
  GEMINI_MODEL_FAST: z.string().min(1).default('gemini-3.5-flash'),
  /** auto: Google when GEMINI_API_KEY is set, otherwise none (keyword search only). */
  EMBEDDING_PROVIDER: z.enum(['auto', 'google', 'mock', 'none']).default('auto'),
  EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(16).max(4096).default(1536),
  MODEL_PRICES_JSON: z.string().optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

function missingKey(name: ProviderName, variable: string, defaultModel: string): LlmProvider {
  return { name, defaultModel, generate: () => Promise.reject(new Error(`${variable} is not set; agents on the ${name} provider cannot answer`)) };
}

/** The configured LLM providers, chosen per agent by provider name and model. */
export class LlmProviders {
  readonly #byName: Record<ProviderName, LlmProvider>;
  readonly #default: ProviderName;

  constructor(config: ModelConfig) {
    this.#default = config.LLM_PROVIDER;
    this.#byName = {
      echo: new EchoProvider(),
      anthropic: config.ANTHROPIC_API_KEY
        ? new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, defaultModel: config.LLM_MODEL, effort: config.LLM_EFFORT, maxTokens: config.LLM_MAX_TOKENS })
        : missingKey('anthropic', 'ANTHROPIC_API_KEY', config.LLM_MODEL),
      google: config.GEMINI_API_KEY ? new GeminiProvider({ apiKey: config.GEMINI_API_KEY, defaultModel: config.GEMINI_MODEL, maxOutputTokens: config.LLM_MAX_TOKENS }) : missingKey('google', 'GEMINI_API_KEY', config.GEMINI_MODEL),
    };
  }

  /** `provider` empty means the configured default; model "echo" always selects the echo provider. */
  for(provider: ProviderName | '' | undefined, model: string | undefined): LlmProvider {
    if (model === ECHO_MODEL || provider === 'echo') return this.#byName.echo;
    return this.#byName[provider || this.#default];
  }

  get(name: ProviderName): LlmProvider {
    return this.#byName[name];
  }
}

export function embeddingProviderFromConfig(config: ModelConfig): EmbeddingProvider | undefined {
  const choice = config.EMBEDDING_PROVIDER === 'auto' ? (config.GEMINI_API_KEY ? 'google' : 'none') : config.EMBEDDING_PROVIDER;
  switch (choice) {
    case 'none':
      return undefined;
    case 'mock':
      return new MockEmbeddingProvider(config.EMBEDDING_DIMENSIONS);
    case 'google':
      if (!config.GEMINI_API_KEY) throw new Error('EMBEDDING_PROVIDER=google needs GEMINI_API_KEY');
      return new GeminiEmbeddingProvider({ apiKey: config.GEMINI_API_KEY, model: config.EMBEDDING_MODEL, dimensions: config.EMBEDDING_DIMENSIONS });
  }
}
