// X3 (opt-in; D48): a build without the user limit (our own, or Mostlymatter) lets the active user count pass
// Team Edition's former hard limit of 250. Creates users until 260 are active, then deactivates them again.
// Run with `pnpm spike X3` against `pnpm dev:up --enterprise-brain`.
import { MattermostError } from '../lib/mattermost.ts';
import { shortJson, type Spike } from './lib/spike.ts';

interface ServerLimits {
  maxUsersLimit: number;
  maxUsersHardLimit: number;
  activeUserCount: number;
}

const FORMER_HARD_LIMIT = 250;
const TARGET = FORMER_HARD_LIMIT + 10;

export const x03: Spike = {
  id: 'X3',
  title: 'No user limit (creates and deactivates users until 260 are active)',
  kind: 'assumption',
  optIn: true,
  async run(ctx, r) {
    const before = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
    r.record('limitsBefore', before);
    r.check('the server reports no hard user limit below the target', before.maxUsersHardLimit === 0 || before.maxUsersHardLimit > TARGET, shortJson(before));

    const created: string[] = [];
    let refusal: unknown;
    try {
      for (let active = before.activeUserCount; active < TARGET; active++) {
        const name = `nolimit-${ctx.runId}-${created.length + 1}`;
        try {
          created.push((await ctx.mmAdmin.post<{ id: string }>('/users', { username: name, email: `${name}@example.test`, password: `Aa1-${name}` })).id);
        } catch (error) {
          refusal = error instanceof MattermostError ? error.body : String(error);
          break;
        }
      }
      const reached = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
      r.check(
        `${TARGET} active users, past the former hard limit of ${FORMER_HARD_LIMIT}`,
        refusal === undefined && reached.activeUserCount >= TARGET,
        `${created.length} created; active ${reached.activeUserCount}${refusal === undefined ? '' : `; refusal ${shortJson(refusal)}`}`,
      );
    } finally {
      for (const id of created) await ctx.mmAdmin.delete(`/users/${id}`);
    }
    const after = await ctx.mmAdmin.get<ServerLimits>('/limits/server');
    r.check('deactivated users no longer count', after.activeUserCount === before.activeUserCount, `active after cleanup: ${after.activeUserCount}`);
  },
};
