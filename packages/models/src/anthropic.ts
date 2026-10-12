// Anthropic provider (D21): the Messages API through the official SDK. Model id from configuration; effort set
// explicitly (Claude Opus 5.5 defaults to medium and always thinks, so the thinking parameter is left out);
// refusals are retried server-side with `fallbacks: "default"`. Tool calls run through `runTool` for up to
// `maxToolRounds` rounds; the model's own content blocks are replayed as-is between rounds.
import Anthropic from '@anthropic-ai/sdk';
import { userMessage } from './prompt.ts';
import { executeTool, toolResultText } from './tools.ts';
import type { GenerateInput, GenerateResult, LlmProvider, ToolExecution, Usage } from './types.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicProviderOptions {
  apiKey?: string | undefined;
  defaultModel: string;
  effort: Effort;
  maxTokens: number;
  /** For tests: a fetch implementation to use instead of the network. */
  fetch?: typeof fetch;
  baseURL?: string;
}

const DEFAULT_TOOL_ROUNDS = 8;

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly defaultModel: string;
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
    this.defaultModel = options.defaultModel;
    this.#effort = options.effort;
    this.#maxTokens = options.maxTokens;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userMessage(input.conversation, input.knowledge, input.channel) }];
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const executions: ToolExecution[] = [];
    const maxRounds = input.maxToolRounds ?? DEFAULT_TOOL_ROUNDS;
    for (let round = 0; ; round++) {
      const response = await this.#client.beta.messages.create({
        model: input.model,
        max_tokens: this.#maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.#effort },
        system: [{ type: 'text', text: input.instructions, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      if (cacheRead > 0) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
      if (response.stop_reason === 'refusal') return { text: '', usage, refused: true, toolCalls: executions, stopReason: 'refusal' };
      const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (response.stop_reason === 'tool_use' && toolUses.length > 0 && input.runTool && round < maxRounds) {
        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const execution = await executeTool(input.runTool, { id: use.id, name: use.name, input: use.input });
          executions.push(execution);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: toolResultText(execution), ...(execution.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      return { text, usage, toolCalls: executions, ...(response.stop_reason ? { stopReason: response.stop_reason } : {}) };
    }
  }
}
