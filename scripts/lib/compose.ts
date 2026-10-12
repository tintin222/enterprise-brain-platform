// Thin wrapper around `docker compose` for the local stack in infra/compose.yml.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envPath, readEnvFile, repoRoot } from './env.ts';

export const composeProject = 'enterprise-brain';
const composeFile = path.join(repoRoot, 'infra', 'compose.yml');
/** Another Mattermost build instead of Team Edition, by MATTERMOST_EDITION in .env (D11, D22, D48). */
const editionFiles: Record<string, string> = {
  mostlymatter: path.join(repoRoot, 'infra', 'compose.mostlymatter.yml'),
  'enterprise-brain': path.join(repoRoot, 'infra', 'compose.chat.yml'),
};

function baseArgs(): string[] {
  const args = ['compose', '--project-name', composeProject, '--file', composeFile];
  const editionFile = editionFiles[readEnvFile().MATTERMOST_EDITION ?? 'team'];
  if (editionFile) args.push('--file', editionFile);
  if (existsSync(envPath)) args.push('--env-file', envPath);
  return args;
}

function run(command: string, args: string[], capture: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}${stderr ? `\n${stderr.trim()}` : ''}`));
    });
  });
}

/** Run `docker compose <args>` with output streamed to the terminal. */
export async function compose(args: string[]): Promise<void> {
  await run('docker', [...baseArgs(), ...args], false);
}

/** Run `docker compose <args>` and return stdout. */
export function composeOutput(args: string[]): Promise<string> {
  return run('docker', [...baseArgs(), ...args], true);
}

/** Run a plain `docker <args>` command and return stdout. */
export function dockerOutput(args: string[]): Promise<string> {
  return run('docker', args, true);
}
