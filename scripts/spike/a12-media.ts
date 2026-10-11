// A12: PUT /media/upload authentication and the URL form it returns.
import { blossomHeader, nip98Header, sha256Hex } from '../lib/relay.ts';
import { newMember } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

// A 1x1 PNG with only IHDR, IDAT and IEND chunks (the relay rejects images carrying metadata).
const TINY_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

export const a12: Spike = {
  id: 'A12',
  title: 'PUT /media/upload: auth and returned URL',
  kind: 'assumption',
  async run(ctx, r) {
    const uploader = await newMember(ctx);
    const sha = sha256Hex(TINY_PNG);
    const base = { 'Content-Type': 'image/png', 'X-SHA-256': sha };

    const anonymous = await ctx.relayHttp.request('PUT', '/media/upload', base, TINY_PNG);
    r.check('an upload without auth is rejected', anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status} ${shortJson(anonymous.body)}`);

    const withNip98 = await ctx.relayHttp.request('PUT', '/media/upload', { ...base, Authorization: nip98Header(uploader, `${ctx.relayHttp.baseUrl}/media/upload`, 'PUT') }, TINY_PNG);
    r.note(`upload with a NIP-98 header instead of Blossom auth: HTTP ${withNip98.status} ${shortJson(withNip98.body)}`);

    const upload = await ctx.relayHttp.request('PUT', '/media/upload', { ...base, Authorization: blossomHeader(uploader, 'upload', sha) }, TINY_PNG);
    const descriptor = upload.body as { url?: string } | null;
    r.check('an upload with Blossom kind 24242 auth (t=upload, x=sha256) succeeds and returns a URL', upload.status === 200 && Boolean(descriptor?.url), `HTTP ${upload.status} ${shortJson(upload.body, 500)}`);
    r.record('uploadResponse', upload.body);

    const path = descriptor?.url ? new URL(descriptor.url).pathname : `/media/${sha}.png`;
    const anonymousGet = await ctx.relayHttp.request('GET', path, {});
    r.check('fetching the returned URL without auth is refused', anonymousGet.status === 401 || anonymousGet.status === 403, `HTTP ${anonymousGet.status}`);
    const memberGet = await ctx.relayHttp.request('GET', path, { Authorization: blossomHeader(ctx.reader, 'get', sha) });
    r.check('fetching with Blossom "get" auth by a relay member returns the same bytes', memberGet.status === 200 && memberGet.bytes !== undefined && sha256Hex(memberGet.bytes) === sha, `HTTP ${memberGet.status}`);
  },
};
