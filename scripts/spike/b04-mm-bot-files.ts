// B4 (Company Brain Phase 0): the @brain bot reads chat attachments with its own token, so the document
// pipeline can ingest them (FR-5.6). Also what happens for a channel the bot is not in.
import { randomBytes } from 'node:crypto';
import type { MmPost, MmUser } from '../lib/mattermost.ts';
import { mmAddMember, mmCreateChannel, mmLogin, mmTeamId, uniqueName } from './lib/fixtures.ts';
import { type Spike } from './lib/spike.ts';

interface UploadResult {
  file_infos: { id: string; name: string; size: number; mime_type: string }[];
}

export const b04: Spike = {
  id: 'B4',
  title: 'The @brain bot downloads chat attachments',
  kind: 'assumption',
  async run(ctx, r) {
    const teamId = await mmTeamId(ctx);
    const alice = await mmLogin(ctx, 'alice');
    const bot = await ctx.mmBot.get<MmUser>('/users/me');
    const withBot = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'b4'));
    await mmAddMember(alice.api, withBot.id, bot.id);
    const privateWithoutBot = await mmCreateChannel(alice.api, teamId, 'P', uniqueName(ctx, 'b4-private'));

    const bytes = new Uint8Array(randomBytes(4096));
    const upload = await alice.api.upload<UploadResult>(`/files?channel_id=${withBot.id}`, 'files', bytes, 'notes.bin', 'application/octet-stream');
    const fileId = upload.file_infos[0]!.id;
    const post = await alice.api.post<MmPost>('/posts', { channel_id: withBot.id, message: 'see the attachment', file_ids: [fileId] });
    r.check('the post lists its file and metadata.files', post.file_ids?.[0] === fileId && (post.metadata?.files?.length ?? 0) === 1, JSON.stringify(post.metadata?.files?.map((f) => ({ name: f.name, size: f.size, mime_type: f.mime_type }))));

    const download = await ctx.mmBot.raw('GET', `/files/${fileId}`);
    const got = new Uint8Array(await download.arrayBuffer());
    r.check('the bot downloads the file from a channel it is in, bytes intact', download.ok && got.length === bytes.length && got.every((b, i) => b === bytes[i]), `HTTP ${download.status}, ${got.length} bytes, content-type ${download.headers.get('content-type') ?? '?'}`);
    const info = await ctx.mmBot.raw('GET', `/files/${fileId}/info`);
    r.check('the bot reads the file info', info.ok, `HTTP ${info.status}`);

    const hiddenUpload = await alice.api.upload<UploadResult>(`/files?channel_id=${privateWithoutBot.id}`, 'files', bytes, 'secret.bin', 'application/octet-stream');
    await alice.api.post<MmPost>('/posts', { channel_id: privateWithoutBot.id, message: 'private attachment', file_ids: [hiddenUpload.file_infos[0]!.id] });
    const hidden = await ctx.mmBot.raw('GET', `/files/${hiddenUpload.file_infos[0]!.id}`);
    r.note(`a file in a private channel the bot is not a member of: HTTP ${hidden.status} for the system-admin bot (the brain must apply its own access rule, not rely on Mattermost's)`);
  },
};
