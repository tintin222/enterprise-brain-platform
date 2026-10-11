// A10: Mattermost. The posted event lists mentioned user ids; a bot only receives WebSocket events for
// channels it belongs to; posts?since= returns edits and deletions; a system-admin bot can add itself
// to private channels. Also: which membership events the bridge bot can see.
import { setTimeout as sleep } from 'node:timers/promises';
import { requireValue } from '../lib/env.ts';
import { eventPost, MattermostSocket, type MmPost, type MmUser } from '../lib/mattermost.ts';
import { mmAddMember, mmCreateChannel, mmLogin, mmTeamId, uniqueName } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

function parseMentions(value: unknown): string[] | undefined {
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

export const a10: Spike = {
  id: 'A10',
  title: 'Mattermost: mentions, bot event scope, posts?since, private self-add',
  kind: 'assumption',
  async run(ctx, r) {
    const teamId = await mmTeamId(ctx);
    const alice = await mmLogin(ctx, 'alice');
    const bob = await mmLogin(ctx, 'bob');
    const bot = await ctx.mmBot.get<MmUser>('/users/me');
    const admin = await ctx.mmAdmin.get<MmUser>('/users/me');
    const withBot = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'a10-with-bot'));
    const withoutBot = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'a10-no-bot'));
    const privateChannel = await mmCreateChannel(alice.api, teamId, 'P', uniqueName(ctx, 'a10-private'));
    await mmAddMember(alice.api, withBot.id, bob.user.id);
    await mmAddMember(alice.api, withBot.id, bot.id);

    const ws = await MattermostSocket.connect(requireValue(ctx.env, 'MM_URL'), requireValue(ctx.env, 'MM_BRIDGE_TOKEN'));

    // Mentions in the posted event.
    const both = await alice.api.post<MmPost>('/posts', { channel_id: withBot.id, message: '@bob and @brain please look' });
    const bothEvent = await ws.waitFor((e) => e.event === 'posted' && eventPost(e).id === both.id, 10_000);
    const bothMentions = parseMentions(bothEvent.data.mentions);
    r.record('postedEventDataKeys', Object.keys(bothEvent.data));
    r.check('posted (seen by the bot) lists the bot when the bot is mentioned', bothMentions?.includes(bot.id) === true, `mentions=${JSON.stringify(bothEvent.data.mentions ?? null)}`);
    r.check('posted (seen by the bot) lists other mentioned users too', bothMentions?.includes(bob.user.id) === true, `bob=${bob.user.id}`);
    const onlyBob = await alice.api.post<MmPost>('/posts', { channel_id: withBot.id, message: 'only @bob this time' });
    const onlyBobEvent = await ws.waitFor((e) => e.event === 'posted' && eventPost(e).id === onlyBob.id, 10_000);
    r.note(`a post mentioning only @bob, as seen by the bot: mentions=${JSON.stringify(onlyBobEvent.data.mentions ?? null)}`);

    // Event scope for a system-admin bot.
    const outside = await alice.api.post<MmPost>('/posts', { channel_id: withoutBot.id, message: 'the bot is not in this channel' });
    const hidden = await alice.api.post<MmPost>('/posts', { channel_id: privateChannel.id, message: 'private; the bot is not in it' });
    await sleep(3000);
    const leaked = ws.events.filter((e) => e.event === 'posted' && [outside.id, hidden.id].includes(eventPost(e).id));
    r.check('a system-admin bot gets no posted events from channels it is not a member of', leaked.length === 0, `${leaked.length} leaked`);

    // posts?since returns edits and deletions.
    const toEdit = await alice.api.post<MmPost>('/posts', { channel_id: withBot.id, message: 'to be edited' });
    const toDelete = await alice.api.post<MmPost>('/posts', { channel_id: withBot.id, message: 'to be deleted' });
    const mark = Math.max(toEdit.create_at, toDelete.create_at) + 1;
    await sleep(50);
    await alice.api.put(`/posts/${toEdit.id}/patch`, { message: 'edited text' });
    await alice.api.delete(`/posts/${toDelete.id}`);
    const sinceResult = await ctx.mmBot.get<{ order: string[]; posts: Record<string, MmPost> }>(`/channels/${withBot.id}/posts?since=${mark}`);
    const edited = sinceResult.posts[toEdit.id];
    const deleted = sinceResult.posts[toDelete.id];
    r.check('posts?since returns an edited post with its new text and edit_at', edited?.message === 'edited text' && edited.edit_at > 0, edited ? shortJson({ message: edited.message, edit_at: edited.edit_at, update_at: edited.update_at }) : 'not returned');
    r.check('posts?since returns a deleted post marked with delete_at', deleted !== undefined && deleted.delete_at > 0, deleted ? shortJson({ message: deleted.message, delete_at: deleted.delete_at }) : 'not returned');
    const includeDeleted: { posts: Record<string, MmPost> } = await ctx.mmBot
      .get<{ posts: Record<string, MmPost> }>(`/channels/${withBot.id}/posts?since=${mark}&include_deleted=true`)
      .catch(() => ({ posts: {} }));
    const deletedAgain = includeDeleted.posts[toDelete.id];
    r.note(`posts?since&include_deleted=true: deleted post ${deletedAgain ? `returned (delete_at=${deletedAgain.delete_at}, message "${deletedAgain.message}")` : 'not returned'}`);
    const editedEvent = await ws.waitFor((e) => e.event === 'post_edited' && eventPost(e).id === toEdit.id, 5000).catch(() => undefined);
    const deletedEvent = await ws.waitFor((e) => e.event === 'post_deleted' && eventPost(e).id === toDelete.id, 5000).catch(() => undefined);
    r.check('the bot receives post_edited and post_deleted events', editedEvent !== undefined && deletedEvent !== undefined);

    // Membership events visible to the bot.
    await mmAddMember(alice.api, withBot.id, admin.id);
    const added = await ws.waitFor((e) => e.event === 'user_added' && e.data.user_id === admin.id && e.broadcast.channel_id === withBot.id, 5000).catch(() => undefined);
    r.check('the bot sees user_added for a channel it is in', added !== undefined, added ? shortJson({ data: added.data, broadcast: added.broadcast }) : 'not received');
    await alice.api.delete(`/channels/${withBot.id}/members/${admin.id}`);
    const removed = await ws.waitFor((e) => e.event === 'user_removed' && (e.data.user_id === admin.id || e.broadcast.user_id === admin.id), 5000).catch(() => undefined);
    r.check('the bot sees user_removed for a channel it is in', removed !== undefined, removed ? shortJson({ data: removed.data, broadcast: removed.broadcast }) : 'not received');

    const later = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'a10-later'));
    await mmAddMember(alice.api, later.id, bot.id);
    const botAdded = await ws.waitFor((e) => e.event === 'user_added' && e.data.user_id === bot.id && e.broadcast.channel_id === later.id, 5000).catch(() => undefined);
    r.check('the bot gets user_added when it is itself added to a channel (the opt-in signal)', botAdded !== undefined, botAdded ? shortJson({ data: botAdded.data, broadcast: botAdded.broadcast }) : 'not received');

    // A system-admin bot adds itself to a private channel.
    const selfAdd = await ctx.mmBot.raw('POST', `/channels/${privateChannel.id}/members`, { user_id: bot.id });
    r.check('a system-admin bot can add itself to a private channel', selfAdd.ok, `HTTP ${selfAdd.status}`);
    ws.close();
  },
};
