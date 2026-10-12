// @brain/models: LLM and embedding providers shared by agent-runtime and the brain API (D54).
export { AnthropicProvider, type AnthropicProviderOptions, type Effort } from './anthropic.ts';
export { ECHO_MODEL, EchoProvider } from './echo.ts';
export { cosine, GeminiEmbeddingProvider, mockEmbedding, MockEmbeddingProvider, normalize, type GeminiEmbeddingApi, type GeminiEmbeddingOptions } from './embeddings.ts';
export { GeminiProvider, type GeminiModelsApi, type GeminiProviderOptions, type GeminiResponse } from './gemini.ts';
export { estimateCostUsd, parsePriceTable, type ModelPrice, type PriceTable } from './prices.ts';
export { systemPrompt, userMessage, type SystemPromptInput } from './prompt.ts';
export { embeddingProviderFromConfig, LlmProviders, modelConfigSchema, type ModelConfig } from './providers.ts';
export { executeTool, toolResultText } from './tools.ts';
export type { ChannelContext, ConversationTurn, EmbeddingProvider, EmbeddingPurpose, GenerateInput, GenerateResult, LlmProvider, ProviderName, RetrievedPassage, ToolCall, ToolExecution, ToolSpec, Usage } from './types.ts';
