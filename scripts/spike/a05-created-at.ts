// A5: the relay accepts events whose created_at is in the past (backfill, deterministic ids).
import { nowSeconds, sign } from '../lib/nostr.ts';
import { accepted, createChannel, newMember, resultMessage } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

const DAY = 86_400;

export const a05: Spike = {
  id: 'A5',
  title: 'Events with a past created_at (backfill, deterministic ids)',
  kind: 'assumption',
  async run(ctx, r) {
    const channel = await createChannel(ctx, ctx.bridge, 'open');
    const author = await newMember(ctx);
    const now = nowSeconds();
    const offsets = [-60, -600, -890, -910, -3600, -DAY, -30 * DAY, -365 * DAY, 600, 890, 910];
    const outcome: Record<string, string> = {};
    for (const offset of offsets) {
      const res = await ctx.relayHttp.publish(author, sign(author, 9, [['h', channel]], `offset ${offset}s`, now + offset));
      outcome[`${offset}s`] = accepted(res) ? 'accepted' : resultMessage(res);
    }
    r.record('outcomeByOffset', outcome);
    const acceptedOffsets = offsets.filter((o) => outcome[`${o}s`] === 'accepted');
    r.note(`accepted offsets (seconds): ${acceptedOffsets.join(', ')}; rejected: ${offsets.filter((o) => !acceptedOffsets.includes(o)).join(', ')}`);

    r.check('created_at a few minutes in the past is accepted', ['-60s', '-600s', '-890s'].every((k) => outcome[k] === 'accepted'));
    r.check('created_at one day or more in the past (backfill) is accepted', [-DAY, -30 * DAY, -365 * DAY].every((o) => outcome[`${o}s`] === 'accepted'), `1 day: ${outcome[`${-DAY}s`]}`);

    const createdAt = now - 120;
    const e1 = sign(author, 9, [['h', channel], ['mm', 'a5-post']], 'deterministic', createdAt);
    const e2 = sign(author, 9, [['h', channel], ['mm', 'a5-post']], 'deterministic', createdAt);
    const p1 = await ctx.relayHttp.publish(author, e1);
    const p2 = await ctx.relayHttp.publish(author, e2);
    r.check('identical inputs give the same id, and republishing it returns "duplicate:"', e1.id === e2.id && accepted(p1) && resultMessage(p2).includes('duplicate'), `${resultMessage(p1)} then ${resultMessage(p2)}`);
  },
};
