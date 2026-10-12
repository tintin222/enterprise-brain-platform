// Phase 6 operations: health, readiness and metrics endpoints, and dead-letter replay in both directions.
import type { AgentRecord } from '@brain/agent-runtime';
import type { Bridge } from '@brain/bridge';
import { nowSeconds, relayChannelIdFor } from '@brain/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

describe('operations', () => {
  let stack: Stack;
  let bridge: Bridge;
  let alice: MmSession;
  let agent: AgentRecord;

  beforeAll(async () => {
    stack = new Stack();
    alice = await stack.login('alice');
    agent = await stack.provision({ handle: 'agent-a', displayName: 'Agent A', model: 'echo' });
    bridge = await stack.startBridge();
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await bridge?.stop();
    await stack?.close();
  });

  const get = (port: number | undefined, path: string): Promise<Response> => fetch(`http://127.0.0.1:${port ?? 0}${path}`);

  it('every service answers /healthz, /readyz and /metrics', { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'p6-ops');
    await stack.enable(alice, channel.id);
    const post = await stack.post(alice, channel.id, 'counted in the metrics');
    await stack.waitForEventForPost(channel.id, post.id);

    expect((await get(bridge.opsPort, '/healthz')).status).toBe(200);
    const ready = await waitFor(async () => {
      const response = await get(bridge.opsPort, '/readyz');
      return response.status === 200 ? ((await response.json()) as { checks: Record<string, boolean> }) : undefined;
    });
    expect(ready.checks).toEqual({ database: true, mattermost: true, relay: true });
    const metrics = await (await get(bridge.opsPort, '/metrics')).text();
    expect(metrics).toMatch(/brain_bridge_mirrored_total\{direction="mm_to_relay",kind="9"\} [1-9]/);
    expect(metrics).toContain('brain_bridge_mirror_lag_seconds_bucket');
    expect(metrics).toMatch(/brain_relay_requests_total\{path="\/events",status="200"\} [1-9]/);
    expect(metrics).toMatch(/brain_bridge_active_channels [1-9]/);

    const runtime = await stack.startRuntime();
    const ingestion = await stack.startIngestion();
    try {
      for (const port of [runtime.opsPort, ingestion.opsPort]) {
        expect((await get(port, '/healthz')).status).toBe(200);
        await waitFor(async () => (await get(port, '/readyz')).status === 200);
      }
      expect(await (await get(runtime.opsPort, '/metrics')).text()).toContain('brain_runtime_open_jobs');
      expect(await (await get(ingestion.opsPort, '/metrics')).text()).toContain('brain_ingestion_pending_threads');
    } finally {
      await runtime.stop();
      await ingestion.stop();
    }
  });

  it('dead letters replay in both directions, once', { timeout: 120_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'p6-dead-letter', [agent.mmBotUserId]);
    await stack.enable(alice, channel.id);
    const root = await stack.post(alice, channel.id, 'a root for the replays');
    const rootEvent = await stack.waitForEventForPost(channel.id, root.id);
    const relayChannelId = relayChannelIdFor(channel.id);

    // Events the running bridge would have mirrored, given up on while it was down.
    await bridge.stop();
    const signer = await stack.keyStore().signerFor(agent.nostrPubkey);
    const answer = signer.sign({ kind: 9, tags: [['h', relayChannelId], ['e', rootEvent.id, '', 'reply']], content: 'an answer replayed from the dead letters', created_at: nowSeconds() });
    await stack.relay.publish(answer, signer);
    const missed = await stack.post(alice, channel.id, 'a post replayed from the dead letters');
    await stack.store.deadLetter('relay_to_mm', { relayChannelId, event: answer }, 'simulated failure', 3);
    await stack.store.deadLetter('mm_to_relay', { mmPostId: missed.id, mmChannelId: channel.id, source: 'posted' }, 'simulated failure', 3);
    const rows = (await stack.store.listDeadLetters({ limit: 1000 })).slice(-2);

    const tool = stack.newBridge();
    expect(await tool.replayDeadLetter(rows[0]!.id)).toBe('replayed');
    expect(await tool.replayDeadLetter(rows[1]!.id)).toBe('replayed');
    expect(await tool.replayDeadLetter(rows[0]!.id)).toBe('already replayed');
    expect((await stack.store.getDeadLetter(rows[0]!.id))?.replayedAt).toBeInstanceOf(Date);
    expect((await stack.thread(alice, root.id)).filter((post) => post.props?.relay_event_id === answer.id)).toHaveLength(1);
    expect(await stack.eventsForPost(channel.id, missed.id)).toHaveLength(1);

    // The restarted bridge's catch-up finds both already done.
    bridge = await stack.startBridge();
    await bridge.relayCatchUp();
    await bridge.catchUpAll();
    expect((await stack.thread(alice, root.id)).filter((post) => post.props?.relay_event_id === answer.id)).toHaveLength(1);
    expect(await stack.eventsForPost(channel.id, missed.id)).toHaveLength(1);
  });
});
