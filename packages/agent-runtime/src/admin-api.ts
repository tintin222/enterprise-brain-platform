// Internal admin API for the brain product (build-plan Phase 7 task 5): create an agent, enable a channel and
// add an agent to a channel without a terminal. It runs the same provisioning operation as
// `pnpm agent:provision` and changes Mattermost channel membership through the public API; the bridge then
// mirrors the result (D5, D6). Bearer-token authentication, bound to 127.0.0.1 by default.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChatApiError, errorFields, type ChatClient, type KeyStore, type Logger, type Pool, type RelayClient, type Signer } from '@brain/shared';
import { z } from 'zod';
import { provisionAgent } from './provisioning.ts';
import { AgentRepository, type AgentRecord } from './registry.ts';

export interface AdminApiDeps {
  host: string;
  port: number;
  /** Callers send `Authorization: Bearer <token>`. */
  token: string;
  pool: Pool;
  /** A Mattermost client acting as an admin user (D25). */
  chat: ChatClient;
  relay: RelayClient;
  keyStore: KeyStore;
  bridgeSigner: Signer;
  teamName: string;
  /** The @brain bot's user id: adding it to a channel enables the channel (D5). */
  brainUserId: string;
  log: Logger;
}

const createAgentInput = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9._-]{2,21}$/, '3-22 characters: lowercase letters, digits, ".", "-", "_"'),
  name: z.string().trim().min(1).max(64),
  /** The model vendor; empty means the installation default (D54). */
  provider: z.enum(['anthropic', 'google', 'echo']).optional(),
  model: z.string().max(100).optional(),
  instructions: z.string().max(20_000).optional(),
  description: z.string().max(1024).optional(),
});

const addAgentInput = z.object({ handle: z.string().min(1) });

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What the API shows of an agent: never keys or tokens. */
function publicAgent(agent: AgentRecord): Record<string, unknown> {
  return { handle: agent.handle, displayName: agent.displayName, provider: agent.provider, model: agent.model, status: agent.status, mmBotUserId: agent.mmBotUserId, nostrPubkey: agent.nostrPubkey };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body is not JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  return result.data;
}

export interface AdminApi {
  readonly port: number;
  close(): Promise<void>;
}

export async function startAdminApi(deps: AdminApiDeps): Promise<AdminApi> {
  if (deps.token.length < 32) throw new Error('ADMIN_API_TOKEN must be at least 32 characters');
  const expected = Buffer.from(`Bearer ${deps.token}`);
  const agents = new AgentRepository(deps.pool);
  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers.authorization ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function channelOrFail(channelId: string): Promise<void> {
    const channel = await deps.chat.getChannel(channelId);
    if (!channel || channel.delete_at !== 0) throw new HttpError(404, 'No such channel');
    if (channel.type !== 'O' && channel.type !== 'P') throw new HttpError(400, 'Only open and private channels can have agents');
  }

  async function agentOrFail(handle: string): Promise<AgentRecord> {
    const agent = await agents.getByHandle(handle);
    if (!agent) throw new HttpError(404, `No agent @${handle}`);
    return agent;
  }

  async function route(method: string, path: string, request: IncomingMessage): Promise<[number, unknown]> {
    if (method === 'GET' && path === '/healthz') return [200, { ok: true }];
    if (!authorized(request)) throw new HttpError(401, 'Missing or wrong bearer token');
    if (method === 'GET' && path === '/agents') return [200, { agents: (await agents.listAll()).map(publicAgent) }];
    if (method === 'POST' && path === '/agents') {
      const input = parse(createAgentInput, await readJson(request));
      const agent = await provisionAgent(
        { pool: deps.pool, chat: deps.chat, relay: deps.relay, keyStore: deps.keyStore, bridgeSigner: deps.bridgeSigner, teamName: deps.teamName, log: deps.log },
        {
          handle: input.handle,
          displayName: input.name,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      );
      return [201, { agent: publicAgent(agent) }];
    }
    const enable = /^\/channels\/([a-z0-9]{26})\/enable$/.exec(path);
    if (method === 'POST' && enable) {
      const channelId = enable[1]!;
      await channelOrFail(channelId);
      await deps.chat.addChannelMember(channelId, deps.brainUserId);
      return [202, { channelId, enabled: true, note: 'The bridge mirrors the channel within seconds.' }];
    }
    const add = /^\/channels\/([a-z0-9]{26})\/agents$/.exec(path);
    if (method === 'POST' && add) {
      const channelId = add[1]!;
      const { handle } = parse(addAgentInput, await readJson(request));
      await channelOrFail(channelId);
      const agent = await agentOrFail(handle);
      // Without @brain the channel is not mirrored, and the agent would never hear a mention (D5).
      if (!(await deps.chat.isChannelMember(channelId, deps.brainUserId))) throw new HttpError(409, 'Enable the channel first (POST /channels/{id}/enable)');
      await deps.chat.addChannelMember(channelId, agent.mmBotUserId);
      return [202, { channelId, agent: agent.handle }];
    }
    const remove = /^\/channels\/([a-z0-9]{26})\/agents\/([a-z0-9._-]+)$/.exec(path);
    if (method === 'DELETE' && remove) {
      const agent = await agentOrFail(remove[2]!);
      await deps.chat.removeChannelMember(remove[1]!, agent.mmBotUserId).catch((error: unknown) => {
        if (!(error instanceof ChatApiError && error.status === 404)) throw error;
      });
      return [202, { channelId: remove[1], agent: agent.handle, removed: true }];
    }
    throw new HttpError(404, 'Not found');
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0]!;
    route(method, path, request)
      .then(([status, body]) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(`${JSON.stringify(body)}\n`))
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : error instanceof ChatApiError && error.status >= 400 && error.status < 500 ? 400 : 500;
        if (status >= 500) deps.log.error({ method, path, ...errorFields(error) }, 'Admin API request failed');
        else deps.log.info({ method, path, status }, 'Admin API request refused');
        const message = status >= 500 ? 'Internal error' : error instanceof Error ? error.message : String(error);
        if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json' }).end(`${JSON.stringify({ error: message })}\n`);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  deps.log.info({ host: deps.host, port }, 'Admin API listening');
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
