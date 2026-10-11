// Deterministic provider for agents whose model is "echo": answers "echo: <last message>". Lets the whole
// runtime be exercised without a model API key.
import type { GenerateInput, GenerateResult, LlmProvider } from './types.ts';

export const ECHO_MODEL = 'echo';

export class EchoProvider implements LlmProvider {
  generate(input: GenerateInput): Promise<GenerateResult> {
    const last = input.conversation.at(-1);
    return Promise.resolve({ text: `echo: ${last?.text ?? ''}`, usage: { inputTokens: 0, outputTokens: 0 } });
  }
}
