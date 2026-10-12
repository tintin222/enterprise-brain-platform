// Default LlmProvider (D21): the Anthropic Messages API through the official SDK. Model id from
// configuration; effort set explicitly (Claude Opus 5.5 defaults to medium and always thinks, so the
// thinking parameter is left out); refusals are retried server-side with `fallbacks: "default"`.
import Anthropic from '@anthropic-ai/sdk';
import { userMessage } from './prompt.ts';
import type { GenerateInput, GenerateResult, LlmProvider } from './types.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  apiKey?: string | undefined;
  effort: Effort;
  maxTokens: number;
  /** For tests: a fetch implementation to use instead of the network. */
  fetch?: typeof fetch;
  baseURL?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly #client: Anthropic;
  readonly #effort: Effort;
  readonly #maxTokens: number;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 2,
    });
    this.#effort = options.effort;
    this.#maxTokens = options.maxTokens;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const response = await this.#client.beta.messages.create({
      model: input.model,
      max_tokens: this.#maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: this.#effort },
      system: [{ type: 'text', text: input.instructions, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage(input.conversation, input.knowledge, input.channel) }],
    });
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === 'refusal') return { text: '', usage, refused: true };
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return { text, usage };
  }
}
