// Running a tool call on behalf of a provider: timed, errors caught and returned to the model as text.
import type { ToolCall, ToolExecution } from './types.ts';

const MAX_RESULT_CHARS = 20_000;

export async function executeTool(run: (call: ToolCall) => Promise<unknown>, call: ToolCall): Promise<ToolExecution> {
  const started = Date.now();
  try {
    const output = await run(call);
    return { call, output, ms: Date.now() - started };
  } catch (error) {
    return { call, output: null, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

/** What the model sees of a tool's result: JSON, cut to a sane size. */
export function toolResultText(execution: ToolExecution): string {
  if (execution.error) return `Error: ${execution.error}`;
  const text = typeof execution.output === 'string' ? execution.output : JSON.stringify(execution.output ?? null);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text;
}
