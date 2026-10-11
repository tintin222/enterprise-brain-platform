// Phase 0 acceptance: a script receives a Mattermost post over WebSocket and creates a post as a bot.
import { requireValue } from '../lib/env.ts';
import { eventPost, MattermostSocket, type MmPost, type MmUser } from '../lib/mattermost.ts';
import { mmAddMember, mmCreateChannel, mmLogin, mmTeamId, uniqueName } from './lib/fixtures.ts';
import type { Spike } from './lib/spike.ts';

export const acceptanceMm: Spike = {
  id: 'acceptance-mm',
  title: 'Receive a Mattermost post over WebSocket and post as a bot',
  kind: 'acceptance',
  async run(ctx, r) {
    const teamId = await mmTeamId(ctx);
    const alice = await mmLogin(ctx, 'alice');
    const bot = await ctx.mmBot.get<MmUser>('/users/me');
    const channel = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'acceptance'));
    await mmAddMember(alice.api, channel.id, bot.id);

    const socket = await MattermostSocket.connect(requireValue(ctx.env, 'MM_URL'), requireValue(ctx.env, 'MM_BRIDGE_TOKEN'));
    const root = await alice.api.post<MmPost>('/posts', { channel_id: channel.id, message: `hello @brain (${ctx.runId})` });
    const received = await socket.waitFor((e) => e.event === 'posted' && eventPost(e).id === root.id, 10_000).catch(() => undefined);
    r.check("the @brain bot receives alice's post over WebSocket", Boolean(received), received ? `sender=${String(received.data.sender_name)} channel_type=${String(received.data.channel_type)}` : 'not received');

    const reply = await ctx.mmBot.post<MmPost>('/posts', { channel_id: channel.id, root_id: root.id, message: 'reply from the bot', props: { relay_event_id: `acceptance-${ctx.runId}` } });
    r.check('the bot creates a threaded reply with its access token', reply.user_id === bot.id && reply.root_id === root.id);

    const thread = await alice.api.get<{ posts: Record<string, MmPost> }>(`/posts/${root.id}/thread`);
    const seen = thread.posts[reply.id];
    r.check('alice sees the bot reply in the thread, with its props', seen?.props?.relay_event_id === `acceptance-${ctx.runId}`, JSON.stringify(seen?.props ?? null));
    socket.close();
  },
};
