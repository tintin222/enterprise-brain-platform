// A short-lived Railway sandbox on staging's private network (docs/staging.md): it runs one shell script with a
// variable Railway resolves inside the sandbox from another service, so a token never passes through this
// machine, and is destroyed afterwards. Used by `pnpm staging:agent` and the setup step of `pnpm staging:railway`.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { repoRoot } from './env.ts';

/** The brain API's private address on staging (BRAIN_INTERNAL_URL there). */
export const STAGING_BRAIN_API = 'http://brain-api.railway.internal:9120';

export function railway(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`railway ${args.slice(0, 2).join(' ')} exited with ${code}: ${err.trim().slice(-500)}`))));
  });
}

/**
 * Run `script` with `sh -c` in a new sandbox. `variable` is `NAME=${{service.NAME}}`, which Railway resolves
 * inside the sandbox; `args` arrive as $1, $2, … quoted intact. Returns the script's output.
 */
export async function runInSandbox(variable: string, script: string, args: string[] = []): Promise<string> {
  const created = JSON.parse(await railway(['sandbox', 'create', '--private-network', '--idle-timeout-minutes', '10', '--variable', variable, '--json'])) as { id: string };
  try {
    // A new sandbox takes a few seconds to start; until then exec answers "Sandbox is not running".
    for (let attempt = 1; ; attempt++) {
      try {
        return (await railway(['sandbox', 'exec', '--id', created.id, '--timeout', '180', '--', 'sh', '-c', script, 'sh', ...args])).trim();
      } catch (error) {
        if (attempt >= 20 || !String(error).includes('not running')) throw error;
        await sleep(3000);
      }
    }
  } finally {
    await railway(['sandbox', 'destroy', '--id', created.id]);
  }
}

/** One request to the brain API on the private network, with the service token resolved by Railway. */
export function brainApiFromSandbox(method: 'GET' | 'POST', path: string, body?: string): Promise<string> {
  const data = body === undefined ? '' : '-H "Content-Type: application/json" -d "$1" ';
  const script = `curl -sS -X ${method} -H "Authorization: Bearer $BRAIN_API_TOKEN" ${data}-w "\\nHTTP %{http_code}\\n" ${STAGING_BRAIN_API}/api/v1/brain${path}`;
  return runInSandbox('BRAIN_API_TOKEN=${{brain-api.BRAIN_API_TOKEN}}', script, body === undefined ? [] : [body]);
}
