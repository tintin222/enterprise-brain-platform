// X2 (opt-in; owner question Q14): how Team Edition enforces its user limit. Creates users until the
// server refuses, then deactivates them again. Run with `pnpm spike X2`.
import { MattermostApi, MattermostError } from '../lib/mattermost.ts';
import { requireValue } from '../lib/env.ts';
import { shortJson, type Spike } from './lib/spike.ts';

interface ServerLimits {
  maxUsersLimit: number;
  maxUsersHardLimit: number;
  activeUserCount: number;
}

export const x02: Spike = {
  id: 'X2',
  title: 'Team Edition user limit (creates and deactivates ~250 users)',
  kind: 'assumption',
  optIn: true,
  async run(ctx, r) {
    const before = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
    r.record('limitsBefore', before);
    const totalBefore = (await ctx.mmAdmin.get<{ total_users_count: number }>('/users/stats')).total_users_count;
    r.note(`limits: warning at ${before.maxUsersLimit}, hard limit ${before.maxUsersHardLimit}; ${before.activeUserCount} active users counted out of ${totalBefore} active accounts (bots are not counted)`);

    const created: string[] = [];
    let refusal: unknown;
    try {
      for (let i = 1; i <= before.maxUsersHardLimit + 5; i++) {
        const name = `limit-${ctx.runId}-${i}`;
        try {
          created.push((await ctx.mmAdmin.post<{ id: string }>('/users', { username: name, email: `${name}@example.test`, password: `Aa1-${name}` })).id);
        } catch (error) {
          refusal = error instanceof MattermostError ? error.body : String(error);
          break;
        }
      }
      const atLimit = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
      r.check('creating a user beyond the hard limit is refused', refusal !== undefined && atLimit.activeUserCount === before.maxUsersHardLimit, `${created.length} created; active ${atLimit.activeUserCount}/${before.maxUsersHardLimit}; refusal ${shortJson(refusal)}`);
      const login = await new MattermostApi(requireValue(ctx.env, 'MM_URL')).login('alice', requireValue(ctx.env, 'MM_PERSON_PASSWORD')).then(
        () => true,
        () => false,
      );
      r.check('existing users can still sign in at the limit', login);
    } finally {
      for (const id of created) await ctx.mmAdmin.delete(`/users/${id}`);
    }
    const after = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
    r.check('deactivated users no longer count toward the limit', after.activeUserCount === before.activeUserCount, `active after cleanup: ${after.activeUserCount}`);
  },
};
