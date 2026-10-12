// Google provider (spec section 13 decision 2; D56): Gemini through the official SDK with the same prompt
// discipline as the Anthropic provider. Between tool rounds the model's turn is replayed verbatim, thought
// signatures included: Gemini 3 refuses a functionCall part rebuilt by hand (spike B6).
import { GoogleGenAI, type Content, type GenerateContentParameters, type Part } from '@google/genai';
import { userMessage } from './prompt.ts';
import { executeTool, toolResultText } from './tools.ts';
import type { GenerateInput, GenerateResult, LlmProvider, ToolExecution, Usage } from './types.ts';

/** The part of the SDK the provider uses, so tests can pass a fake. */
export interface GeminiModelsApi {
  generateContent(params: GenerateContentParameters): Promise<GeminiResponse>;
}

/** The fields read from a GenerateContentResponse (the SDK's class also has getters, which fakes need not have). */
export interface GeminiResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

export interface GeminiProviderOptions {
  apiKey?: string | undefined;
  /** For tests: a fake in place of the SDK. */
  api?: GeminiModelsApi;
  defaultModel: string;
  maxOutputTokens: number;
}

const DEFAULT_TOOL_ROUNDS = 8;
const REFUSAL_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

export class GeminiProvider implements LlmProvider {
  readonly name = 'google' as const;
  readonly defaultModel: string;
  readonly #api: GeminiModelsApi;
  readonly #maxOutputTokens: number;

  constructor(options: GeminiProviderOptions) {
    this.#api = options.api ?? new GoogleGenAI({ ...(options.apiKey ? { apiKey: options.apiKey } : {}) }).models;
    this.defaultModel = options.defaultModel;
    this.#maxOutputTokens = options.maxOutputTokens;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const contents: Content[] = [{ role: 'user', parts: [{ text: userMessage(input.conversation, input.knowledge, input.channel) }] }];
    const config: GenerateContentParameters['config'] = {
      systemInstruction: input.instructions,
      maxOutputTokens: this.#maxOutputTokens,
      ...(input.tools.length > 0 ? { tools: [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] } : {}),
    };
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const executions: ToolExecution[] = [];
    const maxRounds = input.maxToolRounds ?? DEFAULT_TOOL_ROUNDS;
    for (let round = 0; ; round++) {
      const response = await this.#api.generateContent({ model: input.model, contents, config });
      const meta = response.usageMetadata;
      usage.inputTokens += meta?.promptTokenCount ?? 0;
      usage.outputTokens += (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
      if (meta?.thoughtsTokenCount) usage.thoughtTokens = (usage.thoughtTokens ?? 0) + meta.thoughtsTokenCount;
      if (meta?.cachedContentTokenCount) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + meta.cachedContentTokenCount;
      const candidate = response.candidates?.[0];
      const turn = candidate?.content;
      const parts = turn?.parts ?? [];
      const calls = parts.filter((part): part is Part & { functionCall: NonNullable<Part['functionCall']> } => part.functionCall !== undefined);
      if (calls.length > 0 && input.runTool && round < maxRounds && turn) {
        contents.push(turn);
        const responses: Part[] = [];
        for (const [index, part] of calls.entries()) {
          const name = part.functionCall.name ?? 'tool';
          const execution = await executeTool(input.runTool, { id: part.functionCall.id ?? `${name}-${round}-${index}`, name, input: part.functionCall.args ?? {} });
          executions.push(execution);
          responses.push({ functionResponse: { ...(part.functionCall.id ? { id: part.functionCall.id } : {}), name, response: execution.error ? { error: execution.error } : { result: toolResultText(execution) } } });
        }
        contents.push({ role: 'user', parts: responses });
        continue;
      }
      const refused = (candidate?.finishReason !== undefined && REFUSAL_REASONS.has(candidate.finishReason)) || response.promptFeedback?.blockReason !== undefined;
      const text = parts
        .filter((part) => typeof part.text === 'string' && part.thought !== true)
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();
      return { text: refused ? '' : text, usage, toolCalls: executions, ...(refused ? { refused: true } : {}), ...(candidate?.finishReason ? { stopReason: candidate.finishReason } : {}) };
    }
  }
}
