// Readiness checks for the local stack.
import { setTimeout as sleep } from 'node:timers/promises';
import { requireValue, type EnvValues } from './env.ts';

async function waitForUrl(name: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${name} not ready at ${url} after ${timeoutMs / 1000}s. Is \`pnpm dev:up\` running?`);
    await sleep(2000);
  }
}

/** Wait until Mattermost and the relay answer their readiness endpoints (`relay: false` waits for Mattermost only). */
export async function waitForStack(env: EnvValues, timeoutMs = 300_000, { relay = true } = {}): Promise<void> {
  await Promise.all([
    waitForUrl('Mattermost', `${requireValue(env, 'MM_URL')}/api/v4/system/ping`, timeoutMs),
    relay ? waitForUrl('Buzz relay', `${requireValue(env, 'RELAY_HTTP_URL')}/_readiness`, timeoutMs) : undefined,
  ]);
}
