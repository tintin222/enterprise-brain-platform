// B1 and B2 (Company Brain Phase 0, docs/brain/01-phase0-plan.md section 3): Mattermost's built-in integration
// features against a service on a private address, as the brain API will be. A probe container joins the
// stack's network under the name `brain-probe`; Mattermost must call it for a slash command, a dialog
// submission and a post action. Also: the trigger id lifetime, ephemeral posts and channel bookmarks by the
// @brain bot. Opt-in: it needs the docker CLI and patches two server settings (restored afterwards).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MattermostError, type MmPost, type MmUser } from '../lib/mattermost.ts';
import { mmAddMember, mmCreateChannel, mmLogin, mmTeamId, uniqueName } from './lib/fixtures.ts';
import { shortJson, type Spike } from './lib/spike.ts';

const PROBE_NAME = 'brain-probe';
const PROBE_PORT = 9121;
const PROBE_IMAGE = 'node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66';
const NETWORK = 'enterprise-brain_default';
const PROBE_URL = `http://${PROBE_NAME}:${PROBE_PORT}`;
const LOCAL_PROBE = `http://127.0.0.1:${PROBE_PORT}`;

interface Received {
  at: number;
  method: string;
  path: string;
  contentType: string;
  body: Record<string, unknown> | string | undefined;
}

interface ServiceSettings {
  AllowedUntrustedInternalConnections: string;
  OutgoingIntegrationRequestsTimeout: number;
  EnableCommands: boolean;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function received(): Promise<Received[]> {
  return (await (await fetch(`${LOCAL_PROBE}/_received`)).json()) as Received[];
}

async function clearReceived(): Promise<void> {
  await fetch(`${LOCAL_PROBE}/_received`, { method: 'DELETE' });
}

async function waitForProbe(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${LOCAL_PROBE}/_health`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error('probe container did not come up');
}

function startProbe(): void {
  try {
    docker(['stop', PROBE_NAME]);
  } catch {
    /* not running */
  }
  const script = path.join(import.meta.dirname, 'lib', 'probe-server.mjs');
  docker(['run', '-d', '--rm', '--name', PROBE_NAME, '--network', NETWORK, '-p', `127.0.0.1:${PROBE_PORT}:${PROBE_PORT}`, '-v', `${script}:/probe.mjs:ro`, PROBE_IMAGE, 'node', '/probe.mjs']);
}

export const b01: Spike = {
  id: 'B1',
  title: 'Mattermost integrations (commands, dialogs, actions) reaching a private address',
  kind: 'assumption',
  optIn: true,
  async run(ctx, r) {
    startProbe();
    await waitForProbe();
    const config = await ctx.mmAdmin.get<{ ServiceSettings: ServiceSettings }>('/config');
    const initial = config.ServiceSettings;
    r.record('initialServiceSettings', { AllowedUntrustedInternalConnections: initial.AllowedUntrustedInternalConnections, OutgoingIntegrationRequestsTimeout: initial.OutgoingIntegrationRequestsTimeout, EnableCommands: initial.EnableCommands });
    const restore = async (): Promise<void> => {
      await ctx.mmAdmin.put('/config/patch', { ServiceSettings: { AllowedUntrustedInternalConnections: initial.AllowedUntrustedInternalConnections, OutgoingIntegrationRequestsTimeout: initial.OutgoingIntegrationRequestsTimeout } });
    };
    const teamId = await mmTeamId(ctx);
    const alice = await mmLogin(ctx, 'alice');
    const bot = await ctx.mmBot.get<MmUser>('/users/me');
    const channel = await mmCreateChannel(alice.api, teamId, 'O', uniqueName(ctx, 'b1'));
    await mmAddMember(alice.api, channel.id, bot.id);
    const trigger = `probe${ctx.runId}`;
    let commandId: string | undefined;
    try {
      // Start from a server that does not trust the probe's address.
      await ctx.mmAdmin.put('/config/patch', { ServiceSettings: { AllowedUntrustedInternalConnections: '', OutgoingIntegrationRequestsTimeout: 30 } });
      const command = await ctx.mmAdmin.post<{ id: string; token: string }>('/commands', {
        team_id: teamId,
        trigger,
        method: 'P',
        url: `${PROBE_URL}/mm/commands/brain`,
        auto_complete: true,
        auto_complete_desc: 'Probe command',
        auto_complete_hint: '[text]',
        display_name: 'probe',
        description: 'Spike B1',
        username: 'brain',
      });
      commandId = command.id;
      r.check('an admin registers a slash command through the API', typeof command.token === 'string' && command.token.length > 0, `id ${command.id}`);

      const execute = (text: string): Promise<Response> => alice.api.raw('POST', '/commands/execute', { channel_id: channel.id, command: `/${trigger} ${text}` });
      const blocked = await execute('first try');
      const blockedBody = await blocked.text();
      await sleep(500);
      const blockedSeen = await received();
      r.record('untrustedAttempt', { status: blocked.status, body: blockedBody.slice(0, 300), probeReceived: blockedSeen.length });
      r.check('without AllowedUntrustedInternalConnections, Mattermost refuses to call the private address (expected)', !blocked.ok && blockedSeen.length === 0, `HTTP ${blocked.status} ${blockedBody.slice(0, 120)}`);

      await ctx.mmAdmin.put('/config/patch', { ServiceSettings: { AllowedUntrustedInternalConnections: PROBE_NAME } });
      await clearReceived();
      const allowed = await execute('hello brain');
      const allowedBody = (await allowed.json().catch(() => null)) as { response_type?: string; text?: string } | null;
      await sleep(300);
      const seen = await received();
      const commandRequest = seen.find((item) => item.path === '/mm/commands/brain');
      const body = (commandRequest?.body ?? {}) as Record<string, string>;
      r.record('commandRequest', commandRequest);
      r.check(`with AllowedUntrustedInternalConnections="${PROBE_NAME}", the command reaches the probe by name`, commandRequest !== undefined, `HTTP ${allowed.status}; probe saw ${seen.length}`);
      r.check('the probe\'s ephemeral response comes back to the caller', allowedBody?.response_type === 'ephemeral' && typeof allowedBody.text === 'string', shortJson(allowedBody));
      r.check('the command request carries user_id, channel_id, team_id, trigger_id, token, text and response_url', ['user_id', 'channel_id', 'team_id', 'trigger_id', 'token', 'text', 'response_url'].every((key) => typeof body[key] === 'string' && body[key].length > 0), `keys ${Object.keys(body).join(',')}; content-type ${commandRequest?.contentType ?? '?'}`);
      r.check('the token in the request is the command\'s token (how the brain API authenticates Mattermost)', body.token === command.token);
      r.check('the command runs as the invoking person', body.user_id === alice.user.id && body.channel_id === channel.id);

      // Interactive dialog opened with the trigger id, then submitted as alice.
      const dialogUrl = `${PROBE_URL}/mm/dialogs/test`;
      const openDialog = (triggerId: string): Promise<Response> =>
        fetch(`${ctx.mmAdmin.baseUrl}/api/v4/actions/dialogs/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trigger_id: triggerId,
            url: dialogUrl,
            dialog: { callback_id: 'cb1', title: 'Probe dialog', introduction_text: 'Spike B1', elements: [{ display_name: 'Name', name: 'name', type: 'text', placeholder: 'A name' }, { display_name: 'Kind', name: 'kind', type: 'select', options: [{ text: 'Internal', value: 'internal' }, { text: 'External', value: 'external' }] }], submit_label: 'Save', notify_on_cancel: false, state: 'state-1' },
          }),
        });
      const opened = await openDialog(body.trigger_id!);
      r.check('a dialog opens with the trigger id, without any session (the brain API needs no token for this)', opened.ok, `HTTP ${opened.status} ${(await opened.text()).slice(0, 120)}`);
      await clearReceived();
      const submitted = await alice.api.raw('POST', '/actions/dialogs/submit', { url: dialogUrl, callback_id: 'cb1', state: 'state-1', user_id: alice.user.id, channel_id: channel.id, team_id: teamId, submission: { name: 'Acme', kind: 'external' }, cancelled: false });
      await sleep(300);
      const dialogRequest = (await received()).find((item) => item.path === '/mm/dialogs/test');
      const submission = ((dialogRequest?.body ?? {}) as { submission?: Record<string, string>; user_id?: string; state?: string; type?: string });
      r.record('dialogRequest', dialogRequest);
      r.check('the dialog submission is posted to the probe as JSON with the submission, user and state', submitted.ok && submission.submission?.name === 'Acme' && submission.user_id === alice.user.id && submission.state === 'state-1', `HTTP ${submitted.status}; ${shortJson(dialogRequest?.body)}`);

      // Trigger id lifetime (B2): the source ties it to OutgoingIntegrationRequestsTimeout (30 s default). Shrink it to prove it.
      await ctx.mmAdmin.put('/config/patch', { ServiceSettings: { OutgoingIntegrationRequestsTimeout: 2 } });
      await clearReceived();
      await execute('expiry test');
      await sleep(300);
      const expiryRequest = (await received()).find((item) => item.path === '/mm/commands/brain');
      const expiryTrigger = ((expiryRequest?.body ?? {}) as Partial<Record<string, string>>).trigger_id;
      await sleep(3000);
      const late = await openDialog(expiryTrigger ?? '');
      const lateBody = await late.text();
      r.check('a trigger id older than OutgoingIntegrationRequestsTimeout is refused (B2: dialogs must open at once)', late.status === 400 && /expired/i.test(lateBody), `HTTP ${late.status} ${lateBody.slice(0, 120)} after 3 s with a 2 s timeout`);
      await ctx.mmAdmin.put('/config/patch', { ServiceSettings: { OutgoingIntegrationRequestsTimeout: 30 } });

      // A post with a button by the bot; alice clicks it; Mattermost calls the probe.
      await clearReceived();
      const proposal = await ctx.mmBot.post<MmPost>('/posts', {
        channel_id: channel.id,
        message: 'Proposal: create task "Send the schema"',
        props: { attachments: [{ text: 'Accept this task?', actions: [{ id: 'accept', name: 'Accept', type: 'button', integration: { url: `${PROBE_URL}/mm/actions/accept`, context: { proposal: 'p1' } } }] }] },
      });
      const clicked = await alice.api.raw('POST', `/posts/${proposal.id}/actions/accept`, {});
      const clickedBody = await clicked.text();
      await sleep(300);
      const actionRequest = (await received()).find((item) => item.path === '/mm/actions/accept');
      const actionBody = (actionRequest?.body ?? {}) as { user_id?: string; post_id?: string; context?: { proposal?: string }; trigger_id?: string };
      r.record('actionRequest', actionRequest);
      r.check('a button on a bot post calls the probe with the clicker, the post and the context', clicked.ok && actionBody.user_id === alice.user.id && actionBody.post_id === proposal.id && actionBody.context?.proposal === 'p1', `HTTP ${clicked.status} ${clickedBody.slice(0, 80)}; ${shortJson(actionRequest?.body)}`);
      r.note(`a post action request also carries a trigger_id: ${typeof actionBody.trigger_id === 'string'} (a button can open a dialog)`);

      // Ephemeral post by the bot (system admin) and a channel bookmark.
      const ephemeral = await ctx.mmBot.raw('POST', '/posts/ephemeral', { user_id: alice.user.id, post: { channel_id: channel.id, message: 'Only alice sees this' } });
      r.check('the @brain bot can post an ephemeral message to one person', ephemeral.ok, `HTTP ${ephemeral.status}`);
      const bookmark = await ctx.mmBot.raw('POST', `/channels/${channel.id}/bookmarks`, { display_name: 'Brain: Probe topic', type: 'link', link_url: 'http://localhost:9120/containers/probe' });
      r.check('the @brain bot can add a channel bookmark (a link to the container page)', bookmark.ok, `HTTP ${bookmark.status} ${(await bookmark.text()).slice(0, 100)}`);
    } finally {
      if (commandId) await ctx.mmAdmin.delete(`/commands/${commandId}`).catch(() => undefined);
      await restore().catch((error: unknown) => r.note(`could not restore settings: ${error instanceof MattermostError ? error.message : String(error)}`));
      try {
        docker(['stop', PROBE_NAME]);
      } catch {
        /* already gone */
      }
    }
  },
};
