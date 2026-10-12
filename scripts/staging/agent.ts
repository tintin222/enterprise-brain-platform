// pnpm staging:agent --handle <h> --name "<Name>" [--provider anthropic|google|echo] [--model <id>] [--instructions "..."]:
// create or update an agent on staging through the brain API (docs/phase7.md), from a temporary Railway sandbox
// on the private network (docs/staging.md). Railway resolves the service token inside the sandbox, so it never
// passes through this machine.
import { parseArgs } from 'node:util';
import { brainApiFromSandbox } from '../lib/railway-sandbox.ts';

const { values } = parseArgs({
  options: { handle: { type: 'string' }, name: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, instructions: { type: 'string' } },
});
if (!values.handle || !values.name) {
  console.error('Usage: pnpm staging:agent --handle <h> --name "<Name>" [--provider anthropic|google|echo] [--model <id>] [--instructions "..."]');
  process.exit(2);
}

const body = JSON.stringify({ handle: values.handle, name: values.name, provider: values.provider, model: values.model, instructions: values.instructions });
console.log(await brainApiFromSandbox('POST', '/agents', body));
