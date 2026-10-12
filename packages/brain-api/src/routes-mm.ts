// Mattermost's callbacks (spike B1, plan section 10): the /brain slash command, dialog submissions and post
// actions. Mattermost is authenticated by the command token it was issued; dialogs and buttons carry a state
// we signed. The brain then acts as the invoking person, never as the integration.
import type { Container } from '@brain/brain';
import { nowSeconds, type MmDialog } from '@brain/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Principal } from './access.ts';
import type { BrainApiDeps } from './app.ts';
import { safeEqual } from './auth.ts';
import type { ChannelLinker } from './channels.ts';
import { COMMAND_TRIGGER, secretCommandToken } from './mattermost-setup.ts';
import { containerUrl } from './present.ts';
import { actionBody, commandBody, dialogBody } from './schemas.ts';

const STATE_SECONDS = 600;
const SEARCH_RESULTS = 5;

interface CommandResponse {
  response_type?: 'ephemeral' | 'in_channel';
  text?: string;
}

export function registerMattermostRoutes(app: FastifyInstance, deps: BrainApiDeps, linker: ChannelLinker): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { config, store, access, keyStore, tokens, chat, log } = deps;
  const publicUrl = config.BRAIN_PUBLIC_URL.replace(/\/$/, '');
  const internalUrl = config.BRAIN_INTERNAL_URL.replace(/\/$/, '');
  const ephemeral = (text: string): CommandResponse => ({ response_type: 'ephemeral', text });

  async function personFor(userId: string): Promise<Principal> {
    const membership = await access.membership(userId);
    return { kind: 'person', userId, username: membership.username, isAdmin: membership.isAdmin, ...(membership.personId ? { personId: membership.personId } : {}) };
  }

  const help = [
    '**Enterprise Brain**',
    `- \`/${COMMAND_TRIGGER} search <words>\`: search everything you may see.`,
    `- \`/${COMMAND_TRIGGER} link\`: make this channel feed a Project or Topic (its threads become that container's conversations).`,
    `- Pages: ${publicUrl}`,
  ].join('\n');

  async function searchCommand(principal: Principal, text: string, requestId: string): Promise<CommandResponse> {
    if (!text) return ephemeral(`What should I search for? \`/${COMMAND_TRIGGER} search <words>\``);
    const scope = await access.scope(principal);
    let embedding: number[] | undefined;
    if (deps.embeddings) {
      try {
        embedding = (await deps.embeddings.embed([text], 'query'))[0];
      } catch {
        embedding = undefined;
      }
    }
    const results = await store.search({ query: text, embedding, ...(deps.embeddings ? { maxDistance: deps.embeddings.relevanceDistance } : {}), scope, limit: SEARCH_RESULTS });
    await store.audit({ action: 'search', details: { via: 'chat', results: results.length, semantic: embedding !== undefined } }, { actor: { kind: 'person', id: principal.userId }, source: { kind: 'chat' }, requestId });
    const more = `${publicUrl}/search?q=${encodeURIComponent(text)}`;
    if (results.length === 0) return ephemeral(`Nothing found for "${text}". [Search the pages](${more})`);
    const lines = results.map((result) => {
      const url = result.citation.url ?? `${publicUrl}/entities/${result.entityId}`;
      const snippet = result.snippet.replace(/\s+/g, ' ').slice(0, 160);
      return `- **${result.title}** (${result.entityType}): ${snippet} [open](${url})`;
    });
    return ephemeral(`Results for "${text}":\n${lines.join('\n')}\n[All results](${more})`);
  }

  async function linkCommand(principal: Principal, body: z.infer<typeof commandBody>): Promise<CommandResponse> {
    if (!body.trigger_id) return ephemeral('This command needs a Mattermost that sends trigger ids.');
    const containers = (await store.listContainers({ status: 'active', limit: 100 })).filter((container) => container.kind !== 'general');
    if (containers.length === 0) return ephemeral(`There are no Projects or Topics yet. Create one on the pages: ${publicUrl}/containers`);
    const existing = await store.channelLinkByMm(body.channel_id);
    const dialog: MmDialog = {
      callback_id: 'link',
      title: 'Link this channel',
      introduction_text: existing ? `This channel feeds **${(await store.getContainer(existing.containerId))?.title ?? existing.containerId}** now. Choose where its threads should go.` : 'Choose the Project or Topic this channel feeds. Its threads become that container\'s conversations.',
      elements: [
        { display_name: 'Project or Topic', name: 'container', type: 'select', options: containers.map((container) => ({ text: `${container.title} (${container.kind})`, value: container.id })), ...(existing ? { default: existing.containerId } : {}) },
        { display_name: 'Role of this channel', name: 'role', type: 'select', default: 'linked', options: [{ text: 'Linked channel', value: 'linked' }, { text: 'Home channel', value: 'home' }, { text: 'Requirements channel', value: 'requirements' }] },
      ],
      submit_label: 'Link',
      notify_on_cancel: false,
      state: tokens.sign({ uid: body.user_id, exp: nowSeconds() + STATE_SECONDS, use: 'state', data: { purpose: 'link', channel: body.channel_id, team: body.team_id } }),
    };
    await chat.openDialog({ trigger_id: body.trigger_id, url: `${internalUrl}/mm/dialogs/link`, dialog });
    return {};
  }

  api.post(`/mm/commands/${COMMAND_TRIGGER}`, { schema: { tags: ['Mattermost'], summary: `The /${COMMAND_TRIGGER} slash command (form body from Mattermost)`, body: commandBody, hide: false } }, async (request, reply) => {
    const body = request.body;
    const expected = await keyStore.getSecretText(secretCommandToken(body.team_id, COMMAND_TRIGGER));
    if (!expected || !safeEqual(body.token, expected)) return reply.code(401).send({ error: 'Unknown command token', code: 'unauthorized' });
    if (!config.BRAIN_FEATURE_CHAT_COMMANDS) return ephemeral('The brain chat commands are switched off on this installation.');
    const principal = await personFor(body.user_id);
    const [sub = '', ...rest] = body.text.trim().split(/\s+/);
    const argument = rest.join(' ').trim();
    try {
      switch (sub.toLowerCase()) {
        case 'search':
        case 's':
          return await searchCommand(principal, argument, request.id);
        case 'link':
          return await linkCommand(principal, body);
        default:
          return ephemeral(help);
      }
    } catch (error) {
      log.warn({ requestId: request.id, sub, err: error instanceof Error ? error.message : String(error) }, 'Slash command failed');
      return ephemeral(`Sorry, that did not work: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  api.post('/mm/dialogs/:name', { schema: { tags: ['Mattermost'], summary: 'A dialog submission (JSON from Mattermost)', params: z.object({ name: z.enum(['link']) }), body: dialogBody } }, async (request, reply) => {
    const body = request.body;
    const state = tokens.verify(body.state, 'state');
    if (!state || state.uid !== body.user_id || state.data?.purpose !== request.params.name || state.data.channel !== body.channel_id) return reply.code(401).send({ error: 'Unknown or expired dialog', code: 'unauthorized' });
    if (body.cancelled) return {};
    const principal = await personFor(body.user_id);
    const containerId = String(body.submission.container ?? '');
    const role = String(body.submission.role ?? 'linked');
    const container = await store.getContainer(containerId);
    if (!container || container.kind === 'general') return { errors: { container: 'Choose a Project or Topic' } };
    if (role !== 'linked' && role !== 'home' && role !== 'requirements') return { errors: { role: 'Choose a role' } };
    try {
      await linker.attach(container, body.channel_id, role, principal, { actor: { kind: 'person', id: principal.userId }, source: { kind: 'chat' }, requestId: request.id });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    await chat.createEphemeralPost(body.user_id, { channel_id: body.channel_id, message: `Linked: this channel now feeds **${container.title}**. ${containerUrl({ publicUrl }, container.id)}` }).catch(() => undefined);
    return {};
  });

  api.post('/mm/actions/:name', { schema: { tags: ['Mattermost'], summary: 'A button on a post (JSON from Mattermost); the context carries a signed state', params: z.object({ name: z.string().min(1) }), body: actionBody } }, async (request, reply) => {
    const body = request.body;
    const state = tokens.verify(typeof body.context.state === 'string' ? body.context.state : undefined, 'state');
    if (!state || state.data?.purpose !== request.params.name) return reply.code(401).send({ error: 'Unknown or expired action', code: 'unauthorized' });
    // Phase 2 brings proposals (accept, edit, dismiss); Phase 0 only proves the path.
    return { ephemeral_text: `Nothing to do for "${request.params.name}" yet.` };
  });

  void containerLabel;
}

function containerLabel(container: Container): string {
  return `${container.title} (${container.kind})`;
}
