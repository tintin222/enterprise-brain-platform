// A11: bot accounts and bot access tokens work on Team Edition 11.7.x without a licence.
import type { MmPost } from '../lib/mattermost.ts';
import { mmAddMember, mmCreateChannel, mmTeamId, uniqueName } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a11: Spike = {
  id: 'A11',
  title: 'Bot accounts and access tokens on Team Edition without a licence',
  kind: 'assumption',
  async run(ctx, r) {
    const license = await ctx.mmAdmin.get<Record<string, string>>('/license/client?format=old');
    const client = await ctx.mmAdmin.get<Record<string, string>>('/config/client?format=old');
    r.check('the server is Team Edition with no licence', license.IsLicensed === 'false' && client.BuildEnterpriseReady === 'false', `Version=${client.Version} BuildNumber=${client.BuildNumber} BuildEnterpriseReady=${client.BuildEnterpriseReady} IsLicensed=${license.IsLicensed}`);
    r.record('server', { version: client.Version, buildNumber: client.BuildNumber, buildHash: client.BuildHash });

    const created = await ctx.mmAdmin.post<{ user_id: string }>('/bots', { username: `agent-test-${ctx.runId}`, display_name: 'Agent Test', description: 'A11 spike' });
    r.check('a bot account can be created', Boolean(created.user_id));
    const token = await ctx.mmAdmin.post<{ token: string }>(`/users/${created.user_id}/tokens`, { description: 'A11 spike' });
    r.check('an access token can be created for the bot', Boolean(token.token));

    const teamId = await mmTeamId(ctx);
    await ctx.mmAdmin.post(`/teams/${teamId}/members`, { team_id: teamId, user_id: created.user_id });
    const channel = await mmCreateChannel(ctx.mmAdmin, teamId, 'O', uniqueName(ctx, 'a11'));
    await mmAddMember(ctx.mmAdmin, channel.id, created.user_id);
    const botApi = ctx.mmAdmin.withToken(token.token);
    const post = await botApi.post<MmPost>('/posts', { channel_id: channel.id, message: 'hello from a bot token', props: { relay_event_id: 'a11' } });
    r.check('the bot posts with its token, as itself', post.user_id === created.user_id, `props=${shortJson(post.props)}`);

    await ctx.mmAdmin.post(`/bots/${created.user_id}/disable`);
    const after = await botApi.raw('POST', '/posts', { channel_id: channel.id, message: 'should be refused' });
    r.check('disabling the bot stops its token', !after.ok, `HTTP ${after.status}`);
  },
};
