// D50: the brain reads every channel. The bridge's capture sweep adds @brain to public and private channels it
// has never captured; a channel someone removed @brain from stays out.
import type { Bridge } from '@brain/bridge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, waitFor, type MmSession } from './lib/harness.ts';

describe('capture of every channel (D50)', () => {
  let stack: Stack;
  let bridge: Bridge;
  let alice: MmSession;
  let botId: string;

  beforeAll(async () => {
    stack = new Stack({ BRAIN_CAPTURE_CHANNELS: 'all', CAPTURE_SWEEP_SECONDS: '5' });
    alice = await stack.login('alice');
    botId = await stack.botUserId();
    bridge = await stack.startBridge();
  });

  afterAll(async () => {
    await stack?.archiveCreatedChannels();
    await bridge?.stop();
    await stack?.close();
  });

  const isMember = async (channelId: string): Promise<boolean> => (await alice.api.raw('GET', `/channels/${channelId}/members/${botId}`)).ok;

  it('adds @brain to a new public and a new private channel and enables them', { timeout: 60_000 }, async () => {
    const open = await stack.createChannel(alice, 'O', 'cap-open');
    const closed = await stack.createChannel(alice, 'P', 'cap-private');
    expect(await isMember(open.id)).toBe(false);
    const report = await bridge.capture();
    expect(report.joined).toBeGreaterThanOrEqual(2);
    await waitFor(async () => (await stack.store.getChannel(open.id))?.state === 'active', 30_000);
    await waitFor(async () => (await stack.store.getChannel(closed.id))?.state === 'active', 30_000);
    expect(await isMember(open.id)).toBe(true);
    expect(await isMember(closed.id)).toBe(true);
  });

  it('leaves a channel alone once @brain was removed from it', { timeout: 60_000 }, async () => {
    const channel = await stack.createChannel(alice, 'O', 'cap-opt-out');
    await bridge.capture();
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'active', 30_000);
    await alice.api.delete(`/channels/${channel.id}/members/${botId}`);
    await waitFor(async () => (await stack.store.getChannel(channel.id))?.state === 'paused', 30_000);
    const report = await bridge.capture();
    expect(report.optedOut).toBeGreaterThanOrEqual(1);
    expect((await stack.store.getChannel(channel.id))?.state).toBe('paused');
    expect(await isMember(channel.id)).toBe(false);
  });
});
