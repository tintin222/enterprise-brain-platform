// Deterministic provider for agents whose model is "echo": answers "echo: <last message>", followed by the
// knowledge passages it was given and their source links. Lets the whole runtime, retrieval included, be
// exercised without a model API key.
import type { GenerateInput, GenerateResult, LlmProvider } from './types.ts';

export const ECHO_MODEL = 'echo';

export class EchoProvider implements LlmProvider {
  generate(input: GenerateInput): Promise<GenerateResult> {
    const last = input.conversation.at(-1);
    const lines = [`echo: ${last?.text ?? ''}`];
    if (input.knowledge.length > 0) {
      lines.push('', 'From earlier threads:');
      for (const passage of input.knowledge) lines.push(`- ${passage.text.replace(/\s+/g, ' ').slice(0, 300)}${passage.sourceUrl ? ` (${passage.sourceUrl})` : ''}`);
    }
    return Promise.resolve({ text: lines.join('\n'), usage: { inputTokens: 0, outputTokens: 0 } });
  }
}
