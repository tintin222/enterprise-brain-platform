// A8: kind 0 profile fields the relay keeps, and that it accepts profiles for custodial keys.
import { nowSeconds, sign } from '../lib/nostr.ts';
import { accepted, newMember, publishOk, resultMessage } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

export const a08: Spike = {
  id: 'A8',
  title: 'Kind 0 profiles for custodial keys',
  kind: 'assumption',
  async run(ctx, r) {
    const person = await newMember(ctx);
    const profile = {
      name: 'alice',
      display_name: 'Alice Example',
      picture: 'http://localhost:8065/api/v4/users/abc123/image',
      about: 'Mirrored from Mattermost',
      nip05: 'alice@example.com',
      website: 'https://example.com',
      mm_user_id: 'abc123',
    };
    const res = await ctx.relayHttp.publish(person, sign(person, 0, [], JSON.stringify(profile)));
    r.check('the relay accepts a kind 0 signed by a custodial key', accepted(res), resultMessage(res));

    const q = await ctx.relayHttp.query(ctx.reader, [{ kinds: [0], authors: [person.pubkey] }]);
    const stored: unknown = q.events[0] ? JSON.parse(q.events[0].content) : null;
    r.check('the stored kind 0 keeps every field, including non-standard ones', JSON.stringify(stored) === JSON.stringify(profile), shortJson(stored));

    await publishOk(ctx, person, sign(person, 0, [], JSON.stringify({ ...profile, display_name: 'Alice Renamed' }), nowSeconds() + 1));
    const q2 = await ctx.relayHttp.query(ctx.reader, [{ kinds: [0], authors: [person.pubkey] }]);
    const latest = q2.events[0] ? (JSON.parse(q2.events[0].content) as { display_name?: string }) : null;
    r.check('a newer kind 0 replaces the old one', q2.events.length === 1 && latest?.display_name === 'Alice Renamed', `${q2.events.length} stored, display_name "${latest?.display_name}"`);

    const invalid = await ctx.relayHttp.publish(person, sign(person, 0, [], 'not json', nowSeconds() + 2));
    r.note(`kind 0 with non-JSON content: ${resultMessage(invalid)}`);
    r.note('From the relay source (not visible through the API): display_name (or name), picture (or image), about and an on-domain nip05 are copied into its users table; an off-domain nip05 is dropped there.');
  },
};
