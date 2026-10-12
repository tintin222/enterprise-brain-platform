// Phase 7 in this repository: the brain product creates an agent, enables a channel and adds the agent to it
// through the internal admin API, without a terminal, and the agent then answers in that channel.
import { randomBytes } from 'node:crypto';
import { startAdminApi, type AdminApi, type AgentRuntime } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { MattermostChatClient, signerFromHex } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

describe('admin API', () => {
  let stack: Stack;
  let bridge: Bridge;
  let runtime: AgentRuntime;
  let api: AdminApi;
  let alice: MmSession;
  const token = randomBytes(32).toString('hex');

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    bridge = await stack.startBridge();
    // No periodic agent refresh during the test: the agent created through the API must answer at once.
    runtime = await stack.startRuntime({ AGENT_REFRESH_SECONDS: '3600' });
    api = await startAdminApi({
      host: '127.0.0.1',
      port: 0,
      token,
      pool: stack.pool,
      chat: new MattermostChatClient(stack.config.MM_URL, stack.env.MM_ADMIN_TOKEN ?? ''),
      relay: stack.relay,
      keyStore: stack.keyStore(),
      bridgeSigner: signerFromHex(stack.config.BRIDGE_SECRET_KEY),
      teamName: stack.env.MM_TEAM_NAME ?? '',
      brainUserId: await stack.botUserId(),
      log: stack.log('admin-api-e2e'),
    });
  });

  afterAll(async () => {
    await api?.close();
    await stack?.archiveCreatedChannels();
    await runtime?.stop();
    await bridge?.stop();
    await stack?.close();
  });

  const call = (method: string, path: string, body?: unknown, bearer = token): Promise<Response> =>
    fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('refuses callers without the token', async () => {
    expect((await fetch(`http://127.0.0.1:${api.port}/agents`)).status).toBe(401);
    expect((await call('GET', '/agents', undefined, 'x'.repeat(64))).status).toBe(401);
    expect((await call('POST', '/agents', { handle: 'Bad Handle', name: 'x' })).status).toBe(400);
  });

  it('creates an agent, enables a channel and adds the agent, which then answers there', { timeout: 120_000 }, async () => {
    const created = await call('POST', '/agents', { handle: 'api-agent', name: 'API Agent', model: 'echo' });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { handle: string; mmBotUserId: string; nostrPubkey: string } };
    expect(agent.handle).toBe('api-agent');
    await runtime.refreshAgents();

    const channel = await stack.createChannel(alice, 'P', 'p7-api');
    expect((await call('POST', `/channels/${channel.id}/agents`, { handle: 'api-agent' })).status).toBe(409);
    expect((await call('POST', `/channels/${channel.id}/enable`)).status).toBe(202);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'active');
    expect((await call('POST', `/channels/${channel.id}/agents`, { handle: 'api-agent' })).status).toBe(202);
    await waitFor(async () => (await stack.relayMembers(channel.id)).has(agent.nostrPubkey));

    const question = await stack.post(alice, channel.id, '@api-agent hello from the brain product');
    const reply = await waitFor(async () => (await stack.thread(alice, question.id)).find((post) => post.user_id === agent.mmBotUserId), 60_000);
    expect(reply.message).toContain('echo:');

    expect((await call('DELETE', `/channels/${channel.id}/agents/api-agent`)).status).toBe(202);
    await waitFor(async () => !(await stack.relayMembers(channel.id)).has(agent.nostrPubkey));
    const listed = (await (await call('GET', '/agents')).json()) as { agents: { handle: string }[] };
    expect(listed.agents.map((a) => a.handle)).toContain('api-agent');
    expect(JSON.stringify(listed)).not.toMatch(/token|secret/i);
  });
});
