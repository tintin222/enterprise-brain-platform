// B3 (Company Brain Phase 0): Mattermost as an OAuth 2.0 provider for the brain's pages. An admin creates a
// trusted app through the API; a person authorizes it and the brain API exchanges the code for a token that
// identifies the person. Also: whether a trusted app skips the consent page for a browser with a session.
import { MattermostApi, type MmUser } from '../lib/mattermost.ts';
import { requireValue } from '../lib/env.ts';
import { mmLogin, uniqueName } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

interface OAuthApp {
  id: string;
  client_secret: string;
  is_trusted: boolean;
}

const REDIRECT = 'http://127.0.0.1:9121/auth/callback';

export const b03: Spike = {
  id: 'B3',
  title: 'Mattermost OAuth 2.0 provider for the brain pages',
  kind: 'assumption',
  async run(ctx, r) {
    const mmUrl = requireValue(ctx.env, 'MM_URL');
    const config = await ctx.mmAdmin.get<{ ServiceSettings: { EnableOAuthServiceProvider: boolean } }>('/config');
    r.check('the OAuth 2.0 provider is enabled by default', config.ServiceSettings.EnableOAuthServiceProvider === true);
    const alice = await mmLogin(ctx, 'alice');
    const created: string[] = [];
    try {
      const trusted = await ctx.mmAdmin.post<OAuthApp>('/oauth/apps', { name: uniqueName(ctx, 'brain-pages'), description: 'Spike B3', callback_urls: [REDIRECT], homepage: 'http://127.0.0.1:9121', is_trusted: true });
      created.push(trusted.id);
      r.check('an admin creates a trusted OAuth app through the API', trusted.is_trusted && trusted.client_secret.length > 0, `app ${trusted.id}`);

      // The API path the brain's sign-in can use directly: authorize as the person, exchange the code, read the identity.
      // The authorize endpoint lives on the web router (POST {MM_URL}/oauth/authorize, session required), not under /api/v4.
      const authorizeResponse = await fetch(`${mmUrl}/oauth/authorize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.api.token ?? ''}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ response_type: 'code', client_id: trusted.id, redirect_uri: REDIRECT, state: 'state-1', scope: '' }),
      });
      const authorized = (await authorizeResponse.json().catch(() => null)) as { redirect?: string } | null;
      const redirect = new URL(authorized?.redirect ?? 'http://invalid/');
      const code = redirect.searchParams.get('code');
      r.check('POST {MM_URL}/oauth/authorize as the person returns the redirect with a code and the state', authorizeResponse.ok && redirect.origin + redirect.pathname === REDIRECT && typeof code === 'string' && redirect.searchParams.get('state') === 'state-1', `HTTP ${authorizeResponse.status} ${shortJson(authorized).replace(/code=[^&"]+/, 'code=…')}`);
      const exchange = await fetch(`${mmUrl}/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: trusted.id, client_secret: trusted.client_secret, code: code ?? '', redirect_uri: REDIRECT }),
      });
      const token = (await exchange.json().catch(() => null)) as { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string } | null;
      r.record('tokenResponseKeys', token ? Object.keys(token) : null);
      r.check('POST /oauth/access_token exchanges the code for an access token', exchange.ok && typeof token?.access_token === 'string', `HTTP ${exchange.status}; keys ${token ? Object.keys(token).join(',') : '?'}; expires_in ${token?.expires_in ?? '?'}`);
      const me = await new MattermostApi(mmUrl, token?.access_token).get<MmUser>('/users/me').catch(() => undefined);
      r.check('the access token identifies the person (GET /users/me)', me?.id === alice.user.id, me ? `@${me.username}, roles "${me.roles}"` : 'no user');
      const reused = await fetch(`${mmUrl}/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: trusted.id, client_secret: trusted.client_secret, code: code ?? '', redirect_uri: REDIRECT }),
      });
      r.check('a code cannot be exchanged twice', !reused.ok, `HTTP ${reused.status}`);

      // The browser path: GET /oauth/authorize with the session cookie. A trusted app should redirect at once.
      const browser = await fetch(`${mmUrl}/oauth/authorize?response_type=code&client_id=${trusted.id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=state-2`, {
        redirect: 'manual',
        headers: { Cookie: `MMAUTHTOKEN=${alice.api.token ?? ''}` },
      });
      const location = browser.headers.get('location') ?? '';
      r.record('browserAuthorizeTrusted', { status: browser.status, location: location.replace(/code=[^&]+/, 'code=…') });
      r.check('a browser with a session is redirected straight back with a code for a trusted app (no consent page)', browser.status >= 300 && browser.status < 400 && location.startsWith(REDIRECT) && location.includes('code='), `HTTP ${browser.status} ${location.replace(/code=[^&]+/, 'code=…').slice(0, 120)}`);

      const untrusted = await ctx.mmAdmin.post<OAuthApp>('/oauth/apps', { name: uniqueName(ctx, 'brain-untrusted'), description: 'Spike B3', callback_urls: [REDIRECT], homepage: 'http://127.0.0.1:9121', is_trusted: false });
      created.push(untrusted.id);
      const consent = await fetch(`${mmUrl}/oauth/authorize?response_type=code&client_id=${untrusted.id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=state-3`, { redirect: 'manual', headers: { Cookie: `MMAUTHTOKEN=${alice.api.token ?? ''}` } });
      r.note(`an untrusted app gets HTTP ${consent.status} on GET /oauth/authorize (${consent.status === 200 ? 'the consent page' : consent.headers.get('location') ?? ''})`);
      const anonymous = await fetch(`${mmUrl}/oauth/authorize?response_type=code&client_id=${trusted.id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=state-4`, { redirect: 'manual' });
      r.note(`without a session GET /oauth/authorize answers HTTP ${anonymous.status} ${anonymous.headers.get('location') ?? ''}`);
    } finally {
      for (const id of created) await ctx.mmAdmin.delete(`/oauth/apps/${id}`).catch(() => undefined);
    }
  },
};
