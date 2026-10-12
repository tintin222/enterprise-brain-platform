// pnpm staging:agent --handle <h> --name "<Name>" [--model echo] [--instructions "..."]: create or update an agent
// on staging through the admin API (docs/phase7.md), from a temporary Railway sandbox on the private network
// (docs/staging.md). Railway resolves the admin token inside the sandbox, so it never passes through this machine.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { repoRoot } from '../lib/env.ts';

const { values } = parseArgs({
  options: { handle: { type: 'string' }, name: { type: 'string' }, model: { type: 'string' }, instructions: { type: 'string' } },
});
if (!values.handle || !values.name) {
  console.error('Usage: pnpm staging:agent --handle <h> --name "<Name>" [--model echo] [--instructions "..."]');
  process.exit(2);
}

function railway(args: string[]): Promise<string> {
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

const body = JSON.stringify({ handle: values.handle, name: values.name, model: values.model, instructions: values.instructions });
const created = JSON.parse(
  await railway(['sandbox', 'create', '--private-network', '--idle-timeout-minutes', '10', '--variable', 'ADMIN_API_TOKEN=${{admin-api.ADMIN_API_TOKEN}}', '--json']),
) as { id: string };
try {
  // argv form: the sandbox's shell expands the token; the request body arrives as $1, quoted intact.
  const script = 'curl -sS -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" -d "$1" -w "\\nHTTP %{http_code}\\n" http://admin-api.railway.internal:9110/agents';
  // A new sandbox takes a few seconds to start; until then exec answers "Sandbox is not running".
  for (let attempt = 1; ; attempt++) {
    try {
      console.log((await railway(['sandbox', 'exec', '--id', created.id, '--timeout', '180', '--', 'sh', '-c', script, 'sh', body])).trim());
      break;
    } catch (error) {
      if (attempt >= 20 || !String(error).includes('not running')) throw error;
      await sleep(3000);
    }
  }
} finally {
  await railway(['sandbox', 'destroy', '--id', created.id]);
}
