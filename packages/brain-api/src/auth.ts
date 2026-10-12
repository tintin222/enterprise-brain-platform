// Who is calling (plan section 8): a browser session set by the Mattermost OAuth sign-in (spike B3), the
// service token, or nothing. Mattermost's own callbacks are verified in routes-mm.ts.
import { timingSafeEqual } from 'node:crypto';
import type { SourceKind, WriteContext } from '@brain/brain';
import { nowSeconds } from '@brain/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessError, type Principal } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { SECRET_OAUTH_CLIENT, SETTING_OAUTH_CLIENT } from './mattermost-setup.ts';

export const SESSION_COOKIE = 'brain_session';
const LOGIN_STATE_SECONDS = 600;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** How the principal was authenticated; cookie sessions need the X-Requested-With header on writes. */
    authKind?: 'cookie' | 'token';
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The caller, or a 401; cookie-authenticated writes must carry X-Requested-With (Mattermost's own rule). */
export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) throw new AccessError(401, 'Sign in first');
  if (request.authKind === 'cookie' && request.method !== 'GET' && request.method !== 'HEAD' && request.headers['x-requested-with'] !== 'XMLHttpRequest') {
    throw new AccessError(403, 'Writes from the browser need the X-Requested-With: XMLHttpRequest header');
  }
  return principal;
}

export function requireAdmin(request: FastifyRequest): Principal {
  const principal = requirePrincipal(request);
  if (principal.kind === 'service' || (principal.kind === 'person' && principal.isAdmin)) return principal;
  throw new AccessError(403, 'Administrators only');
}

export function writeContext(request: FastifyRequest, principal: Principal, source: SourceKind = request.authKind === 'cookie' ? 'web' : 'api'): WriteContext {
  const actor = principal.kind === 'service' ? { kind: 'system' as const, id: 'service' } : principal.kind === 'agent' ? { kind: 'agent' as const, id: principal.handle } : { kind: 'person' as const, id: principal.userId };
  return { actor, source: { kind: source }, ip: request.ip, requestId: request.id };
}

/** Only paths on this site are accepted as post-login destinations. */
function safeRedirect(value: string | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function registerAuth(app: FastifyInstance, deps: BrainApiDeps): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { config, tokens, access, store, keyStore, log } = deps;
  const publicUrl = config.BRAIN_PUBLIC_URL.replace(/\/$/, '');
  const callbackUrl = `${publicUrl}/auth/callback`;

  api.decorateRequest('principal', undefined);
  api.decorateRequest('authKind', undefined);
  api.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      if (safeEqual(header.slice(7), config.BRAIN_API_TOKEN)) {
        request.principal = { kind: 'service', userId: 'service' };
        request.authKind = 'token';
        return;
      }
      return reply.code(401).send({ error: 'Unknown bearer token', code: 'unauthorized' });
    }
    const payload = tokens.verify(request.cookies[SESSION_COOKIE], 'session');
    if (!payload) return;
    try {
      const membership = await access.membership(payload.uid);
      request.principal = { kind: 'person', userId: payload.uid, username: membership.username, isAdmin: membership.isAdmin, ...(membership.personId ? { personId: membership.personId } : {}) };
      request.authKind = 'cookie';
    } catch {
      // A deactivated account keeps no session.
    }
  });

  const oauthClientId = (): Promise<string | undefined> => store.getSetting<string>(SETTING_OAUTH_CLIENT);

  api.get('/auth/login', { schema: { tags: ['Sign-in'], summary: 'Start the Mattermost sign-in', querystring: z.object({ redirect: z.string().optional() }), hide: true } }, async (request, reply) => {
    const clientId = await oauthClientId();
    if (!clientId) return reply.code(503).send({ error: 'Sign-in is not set up yet: run the Mattermost setup (POST /api/v1/brain/setup/mattermost)', code: 'not_configured' });
    const state = tokens.sign({ uid: 'anonymous', exp: nowSeconds() + LOGIN_STATE_SECONDS, use: 'state', data: { purpose: 'login', redirect: safeRedirect(request.query.redirect) } });
    const url = new URL('/oauth/authorize', config.MM_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    return reply.redirect(url.toString(), 302);
  });

  api.get('/auth/callback', { schema: { tags: ['Sign-in'], summary: 'Finish the Mattermost sign-in', querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), hide: true } }, async (request, reply) => {
    const payload = tokens.verify(request.query.state, 'state');
    if (!payload || payload.data?.purpose !== 'login') return reply.code(400).send({ error: 'The sign-in link expired; start again', code: 'bad_state' });
    if (!request.query.code) return reply.code(400).send({ error: request.query.error ?? 'Mattermost returned no code', code: 'denied' });
    const clientId = await oauthClientId();
    const clientSecret = await keyStore.getSecretText(SECRET_OAUTH_CLIENT);
    if (!clientId || !clientSecret) return reply.code(503).send({ error: 'Sign-in is not set up', code: 'not_configured' });
    const granted = await deps.adminChat.exchangeOAuthCode({ clientId, clientSecret, code: request.query.code, redirectUri: callbackUrl });
    // The Mattermost token identifies the person and is then dropped: memberships are read with the bot's token.
    const me = await deps.chat.withToken(granted.access_token).getMe();
    const maxAge = Math.round(config.BRAIN_SESSION_HOURS * 3600);
    const session = tokens.sign({ uid: me.id, exp: nowSeconds() + maxAge, use: 'session' });
    access.invalidate(me.id);
    await store.audit({ action: 'session.sign_in', details: { username: me.username } }, { actor: { kind: 'person', id: me.id }, source: { kind: 'web' }, ip: request.ip, requestId: request.id });
    log.info({ userId: me.id }, 'Signed in');
    return reply
      .setCookie(SESSION_COOKIE, session, { path: '/', httpOnly: true, sameSite: 'lax', secure: publicUrl.startsWith('https://'), maxAge })
      .redirect(`${publicUrl}${payload.data.redirect ?? '/'}`, 302);
  });

  api.post('/auth/logout', { schema: { tags: ['Sign-in'], summary: 'End the session', hide: true } }, async (_request, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });
}
