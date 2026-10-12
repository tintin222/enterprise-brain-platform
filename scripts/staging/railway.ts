// pnpm staging:railway [step ...]: create or update the staging environment on Railway (docs/staging.md).
// Needs the Railway CLI, logged in, with this repository linked to the staging project (`railway link`).
// Reads and writes .env.staging (ENV_FILE, set by the package script). Secrets reach Railway through standard
// input and are never printed. Steps run in this order, all of them by default, and each is safe to repeat:
//   env         create or complete .env.staging: generated keys and passwords, staging endpoints
//   services    create services, volumes and Mattermost's domain; apply settings and variables
//   data        deploy the three databases, Redis and the S3 store
//   relay       deploy the relay
//   mattermost  deploy Mattermost (our own build, Enterprise Brain chat; D48)
//   seed        run pnpm dev:seed against the public address and check that nobody else holds an account
//   app         store the seed's tokens and deploy the bridge, agent-runtime, ingestion and admin API
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureEnvFile, envPath, readEnvFile, repoRoot, updateEnvFile, type EnvValues } from '../lib/env.ts';
import { MattermostApi, type MmUser } from '../lib/mattermost.ts';

const PROJECT = 'enterprise-brain-staging';
const ENVIRONMENT = 'production';
const STEPS = ['env', 'services', 'data', 'relay', 'mattermost', 'seed', 'app'] as const;
type Step = (typeof STEPS)[number];

if (!envPath.endsWith('.env.staging')) throw new Error('Run this through `pnpm staging:railway`, which sets ENV_FILE=.env.staging.');

// --- Service definitions ---

interface ServiceSpec {
  name: string;
  /** Deployed with `railway up <dir> --path-as-root`; without it, from the repository root with `dockerfilePath`. */
  dir?: string;
  dockerfilePath?: string;
  volume?: string;
  startCommand?: string;
  /** Railway probes the path on PORT when a deployment starts; PORT is set from `port`. */
  healthcheck?: { path: string; port: number };
  variables(env: EnvValues): Record<string, string>;
}

function need(env: EnvValues, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is empty in .env.staging`);
  return value;
}

/** The named values that are set, so optional ones (ANTHROPIC_API_KEY) stay unset rather than empty. */
function pick(env: EnvValues, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => env[key]).map((key) => [key, env[key] as string]));
}

const internal = (service: string, port: number): string => `${service}.railway.internal:${port}`;

const postgres = (name: string, database: string, user: string, passwordKey: string): ServiceSpec => ({
  name,
  dir: 'infra/staging/postgres',
  volume: '/var/lib/postgresql/data',
  variables: (env) => ({ POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: need(env, passwordKey) }),
});

// Every service of ours gets only the settings its configuration schema reads (MM_ADMIN_TOKEN only reaches the
// admin API, security review S5).
const COMMON = ['LOG_LEVEL', 'STATE_DATABASE_URL', 'KEY_ENCRYPTION_KEY', 'OPS_HOST', 'RELAY_HTTP_URL', 'RELAY_WS_URL', 'READER_SECRET_KEY', 'RELAY_REQUESTS_PER_SECOND', 'MM_URL', 'MM_REQUESTS_PER_SECOND'];
const app = (name: string, program: string, portKey: string, healthPath: string, keys: string[]): ServiceSpec => ({
  name,
  dockerfilePath: 'infra/services/Dockerfile',
  startCommand: `node --import tsx ${program}`,
  healthcheck: { path: healthPath, port: 0 },
  variables: (env) => pick(env, [...COMMON, portKey, ...keys]),
});

const DATA: ServiceSpec[] = [
  postgres('mm-postgres', 'mattermost', 'mmuser', 'MM_DB_PASSWORD'),
  postgres('buzz-postgres', 'buzz', 'buzz', 'BUZZ_DB_PASSWORD'),
  postgres('state-postgres', 'brain', 'brain', 'STATE_DB_PASSWORD'),
  { name: 'buzz-redis', dir: 'infra/staging/redis', volume: '/data', variables: (env) => ({ REDIS_PASSWORD: need(env, 'BUZZ_REDIS_PASSWORD') }) },
  {
    name: 'buzz-s3',
    dir: 'infra/staging/s3',
    volume: '/data',
    variables: (env) => ({ MINIO_ROOT_USER: need(env, 'BUZZ_S3_ACCESS_KEY'), MINIO_ROOT_PASSWORD: need(env, 'BUZZ_S3_SECRET_KEY'), BUZZ_S3_BUCKET: need(env, 'BUZZ_S3_BUCKET') }),
  },
];

// The relay's settings follow infra/compose.yml, with private hostnames. RELAY_URL names the relay's community.
const RELAY: ServiceSpec = {
  name: 'relay',
  dir: 'infra/staging/relay',
  healthcheck: { path: '/_readiness', port: 8080 },
  variables: (env) => ({
    BUZZ_BIND_ADDR: '[::]:3000',
    BUZZ_HEALTH_PORT: '8080',
    BUZZ_METRICS_PORT: '9102',
    DATABASE_URL: `postgres://buzz:${need(env, 'BUZZ_DB_PASSWORD')}@${internal('buzz-postgres', 5432)}/buzz`,
    REDIS_URL: `redis://:${need(env, 'BUZZ_REDIS_PASSWORD')}@${internal('buzz-redis', 6379)}`,
    BUZZ_S3_ENDPOINT: `http://${internal('buzz-s3', 9000)}`,
    BUZZ_S3_ADDRESSING_STYLE: 'path',
    BUZZ_S3_ACCESS_KEY: need(env, 'BUZZ_S3_ACCESS_KEY'),
    BUZZ_S3_SECRET_KEY: need(env, 'BUZZ_S3_SECRET_KEY'),
    BUZZ_S3_BUCKET: need(env, 'BUZZ_S3_BUCKET'),
    BUZZ_GIT_REPO_PATH: '/data/git',
    BUZZ_GIT_HOOK_HMAC_SECRET: need(env, 'BUZZ_GIT_HOOK_HMAC_SECRET'),
    BUZZ_AUTO_MIGRATE: 'true',
    BUZZ_REQUIRE_RELAY_MEMBERSHIP: 'true',
    RELAY_OWNER_PUBKEY: need(env, 'RELAY_OWNER_PUBKEY'),
    BUZZ_RELAY_PRIVATE_KEY: need(env, 'BUZZ_RELAY_PRIVATE_KEY'),
    BUZZ_REQUIRE_AUTH_TOKEN: 'true',
    RELAY_URL: need(env, 'RELAY_WS_URL'),
    BUZZ_PUSH_GATEWAY_DELIVERY_URL: '',
    BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN: need(env, 'BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN'),
    BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC: need(env, 'BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC'),
    BUZZ_MEDIA_BASE_URL: `${need(env, 'RELAY_HTTP_URL')}/media`,
    RUST_LOG: 'buzz_relay=info,buzz_db=info,buzz_auth=info,buzz_pubsub=info,tower_http=info',
  }),
};

// Mattermost keeps its configuration in its database (one volume per Railway service) and runs as root, because
// Railway mounts volumes as root and the image's own user cannot write to them.
const MATTERMOST: ServiceSpec = {
  name: 'mattermost',
  dir: 'infra/chat',
  volume: '/mattermost/data',
  healthcheck: { path: '/api/v4/system/ping', port: 8065 },
  variables: (env) => {
    const datasource = `postgres://mmuser:${need(env, 'MM_DB_PASSWORD')}@${internal('mm-postgres', 5432)}/mattermost?sslmode=disable&connect_timeout=10`;
    return {
      MM_SQLSETTINGS_DRIVERNAME: 'postgres',
      MM_SQLSETTINGS_DATASOURCE: datasource,
      MM_CONFIG: datasource,
      MM_SERVICESETTINGS_SITEURL: need(env, 'MM_URL'),
      MM_LOGSETTINGS_ENABLEDIAGNOSTICS: 'false',
      RAILWAY_RUN_UID: '0',
    };
  },
};

const APPS: ServiceSpec[] = [
  app('bridge', 'packages/bridge/src/main.ts', 'BRIDGE_OPS_PORT', '/readyz', ['MM_BRIDGE_TOKEN', 'BRIDGE_SECRET_KEY', 'BACKFILL_DAYS', 'RELAY_OVERLAP_SECONDS', 'CATCH_UP_INTERVAL_SECONDS', 'RECONCILE_INTERVAL_SECONDS']),
  app('agent-runtime', 'packages/agent-runtime/src/main.ts', 'RUNTIME_OPS_PORT', '/readyz', [
    'MAX_EVENT_AGE_SECONDS',
    'RELAY_OVERLAP_SECONDS',
    'MAX_REPLIES_PER_THREAD',
    'REPLY_WINDOW_SECONDS',
    'JOB_CONCURRENCY',
    'AGENT_REFRESH_SECONDS',
    'CONTEXT_CHAR_BUDGET',
    'ANTHROPIC_API_KEY',
    'LLM_MODEL',
    'LLM_EFFORT',
    'LLM_MAX_TOKENS',
  ]),
  app('ingestion', 'packages/ingestion/src/main.ts', 'INGESTION_OPS_PORT', '/readyz', ['INGEST_DEBOUNCE_SECONDS', 'INGEST_CHUNK_CHARS', 'RELAY_OVERLAP_SECONDS', 'CATCH_UP_INTERVAL_SECONDS']),
  app('admin-api', 'packages/agent-runtime/src/cli/admin-api.ts', 'ADMIN_API_PORT', '/healthz', ['MM_ADMIN_TOKEN', 'MM_TEAM_NAME', 'BRIDGE_SECRET_KEY', 'MM_BRIDGE_TOKEN', 'ADMIN_API_TOKEN']),
];
const PORT_KEYS: Record<string, string> = { bridge: 'BRIDGE_OPS_PORT', 'agent-runtime': 'RUNTIME_OPS_PORT', ingestion: 'INGESTION_OPS_PORT', 'admin-api': 'ADMIN_API_PORT' };

const ALL: ServiceSpec[] = [...DATA, RELAY, MATTERMOST, ...APPS];

/** Healthcheck port: fixed for third-party images, the configured operations port for ours. */
function healthPort(spec: ServiceSpec, env: EnvValues): number | undefined {
  if (!spec.healthcheck) return undefined;
  const key = PORT_KEYS[spec.name];
  return key ? Number(need(env, key)) : spec.healthcheck.port;
}

// --- Railway access ---

function run(args: string[], input = '', { withholdOutput = false } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      // Output of calls that carry secrets is withheld: an error could echo what was sent.
      else reject(new Error(`railway ${args[0] ?? ''} exited with ${code}${withholdOutput ? '' : `: ${(err || out).trim().slice(-800)}`}`));
    });
    child.stdin.end(input);
  });
}

/** A GraphQL call through the CLI; variables travel on standard input. */
async function api<T>(query: string, variables: Record<string, unknown>, { secret = false } = {}): Promise<T> {
  const out = await run(['api', '--compact', '--variables', '@-', query], JSON.stringify(variables), { withholdOutput: secret });
  const parsed = JSON.parse(out) as { data?: T; errors?: { message: string }[] };
  if (parsed.errors?.length) throw new Error(`Railway API: ${parsed.errors.map((error) => error.message).join('; ')}`);
  return parsed.data as T;
}

interface Edge<T> {
  node: T;
}
interface Status {
  id: string;
  name: string;
  services: { edges: Edge<{ id: string; name: string }>[] };
  environments: { edges: Edge<{ id: string; name: string; volumeInstances: { edges: Edge<{ serviceId: string; mountPath: string }>[] } }>[] };
}
interface Context {
  projectId: string;
  environmentId: string;
  services: Map<string, string>;
  volumes: Map<string, string>;
}

async function context(): Promise<Context> {
  const status = JSON.parse(await run(['status', '--json'])) as Status;
  if (status.name !== PROJECT) throw new Error(`This directory is linked to Railway project ${status.name}, not ${PROJECT}. Run \`railway link --project ${PROJECT}\`.`);
  const environment = status.environments.edges.map((edge) => edge.node).find((node) => node.name === ENVIRONMENT);
  if (!environment) throw new Error(`Project ${PROJECT} has no ${ENVIRONMENT} environment`);
  return {
    projectId: status.id,
    environmentId: environment.id,
    services: new Map(status.services.edges.map((edge) => [edge.node.name, edge.node.id])),
    volumes: new Map(environment.volumeInstances.edges.map((edge) => [edge.node.serviceId, edge.node.mountPath])),
  };
}

function serviceId(ctx: Context, name: string): string {
  const id = ctx.services.get(name);
  if (!id) throw new Error(`Service ${name} does not exist yet; run the services step first.`);
  return id;
}

// --- Steps ---

const STAGING_VALUES: EnvValues = {
  MATTERMOST_EDITION: 'enterprise-brain',
  RELAY_WS_URL: `ws://${internal('relay', 3000)}`,
  RELAY_HTTP_URL: `http://${internal('relay', 3000)}`,
  STATE_DB_HOST: 'state-postgres.railway.internal',
  STATE_DB_PORT: '5432',
  OPS_HOST: '::',
  MM_TEAM_NAME: 'enterprise-brain',
  MM_TEAM_DISPLAY_NAME: 'Enterprise Brain',
};

function stepEnv(): void {
  const { created, generated } = ensureEnvFile();
  for (const [key, value] of Object.entries(STAGING_VALUES)) if (readEnvFile()[key] !== value) updateEnvFile(key, value);
  console.log(`${created ? 'Created' : 'Checked'} .env.staging${generated.length > 0 ? `; generated ${generated.join(', ')}` : ''}`);
}

async function ensureDomain(ctx: Context): Promise<void> {
  const id = serviceId(ctx, MATTERMOST.name);
  const { domains } = await api<{ domains: { serviceDomains: { domain: string }[] } }>(
    'query($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } } }',
    { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId: id },
  );
  let domain = domains.serviceDomains[0]?.domain;
  if (!domain) {
    const created = await api<{ serviceDomainCreate: { domain: string } }>(
      'mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }',
      { input: { environmentId: ctx.environmentId, serviceId: id, targetPort: 8065 } },
    );
    domain = created.serviceDomainCreate.domain;
    console.log(`Created Mattermost's public address https://${domain}`);
  }
  if (readEnvFile().MM_URL !== `https://${domain}`) updateEnvFile('MM_URL', `https://${domain}`);
}

async function configure(ctx: Context, spec: ServiceSpec, env: EnvValues): Promise<void> {
  const id = serviceId(ctx, spec.name);
  if (spec.volume && !ctx.volumes.has(id)) {
    await api('mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }', {
      input: { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId: id, mountPath: spec.volume },
    });
    console.log(`Added a volume at ${spec.volume} to ${spec.name}`);
  }
  const port = healthPort(spec, env);
  await api('mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }', {
    serviceId: id,
    environmentId: ctx.environmentId,
    input: {
      restartPolicyType: 'ALWAYS',
      dockerfilePath: spec.dockerfilePath ?? null,
      startCommand: spec.startCommand ?? null,
      healthcheckPath: spec.healthcheck?.path ?? null,
      // Mattermost's first start migrates its database, which takes minutes.
      healthcheckTimeout: spec.healthcheck ? 600 : null,
    },
  });
  const variables = { ...spec.variables(env), ...(port ? { PORT: String(port) } : {}) };
  await api(
    'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
    { input: { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId: id, variables, replace: true, skipDeploys: true } },
    { secret: true },
  );
  console.log(`Configured ${spec.name} (${Object.keys(variables).length} variables)`);
}

async function stepServices(): Promise<void> {
  let ctx = await context();
  for (const spec of ALL) {
    if (!ctx.services.has(spec.name)) {
      await run(['add', '--service', spec.name, '--json']);
      console.log(`Created service ${spec.name}`);
    }
  }
  ctx = await context();
  await ensureDomain(ctx);
  const env = readEnvFile();
  // Our services need the seed's tokens; until the seed has run they are configured in the app step.
  for (const spec of ALL) if (!APPS.includes(spec) || env.MM_BRIDGE_TOKEN) await configure(ctx, spec, env);
}

interface Deployment {
  id: string;
  status: string;
  createdAt: string;
}

async function latestDeployment(ctx: Context, id: string): Promise<Deployment | undefined> {
  const { deployments } = await api<{ deployments: { edges: Edge<Deployment>[] } }>(
    'query($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status createdAt } } } }',
    { input: { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId: id } },
  );
  return deployments.edges[0]?.node;
}

/** Upload and build a service, then wait until Railway reports the new deployment healthy. */
async function deploy(ctx: Context, spec: ServiceSpec): Promise<void> {
  const id = serviceId(ctx, spec.name);
  const before = await latestDeployment(ctx, id);
  // Without a path, `railway up` uploads the linked directory, the repository root.
  const args = spec.dir ? ['up', spec.dir, '--path-as-root'] : ['up'];
  await run([...args, '--service', spec.name, '--detach', '--message', `staging:railway ${spec.name}`]);
  const started = Date.now();
  for (;;) {
    await sleep(5000);
    const latest = await latestDeployment(ctx, id);
    if (latest && latest.id !== before?.id) {
      if (latest.status === 'SUCCESS') break;
      if (['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(latest.status)) {
        throw new Error(`Deployment of ${spec.name} ended ${latest.status}; see \`railway logs --service ${spec.name}\` and \`railway logs --build --service ${spec.name}\``);
      }
    }
    if (Date.now() - started > 20 * 60_000) throw new Error(`Deployment of ${spec.name} did not finish within 20 minutes`);
  }
  console.log(`Deployed ${spec.name} in ${Math.round((Date.now() - started) / 1000)} s`);
}

async function deployAll(specs: ServiceSpec[]): Promise<void> {
  const ctx = await context();
  await Promise.all(specs.map((spec) => deploy(ctx, spec)));
}

function seed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev/seed.ts', '--skip-relay'], { cwd: repoRoot, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pnpm dev:seed exited with ${code}`))));
  });
}

/**
 * On a fresh Mattermost the first account becomes system admin, and the public address exists before the seed
 * runs. Fail loudly if any person other than the seeded ones holds an account.
 */
async function checkAccounts(env: EnvValues): Promise<void> {
  const api = new MattermostApi(need(env, 'MM_URL'), need(env, 'MM_ADMIN_TOKEN'));
  const expected = new Set([need(env, 'MM_ADMIN_USERNAME'), 'alice', 'bob']);
  const people: MmUser[] = [];
  for (let page = 0; ; page++) {
    const batch = await api.get<MmUser[]>(`/users?per_page=200&page=${page}`);
    people.push(...batch.filter((user) => !user.is_bot));
    if (batch.length < 200) break;
  }
  const strangers = people.filter((user) => !expected.has(user.username)).map((user) => user.username);
  if (strangers.length > 0) throw new Error(`Unexpected Mattermost accounts: ${strangers.join(', ')}. Wipe staging before using it.`);
  console.log(`Mattermost accounts: ${people.map((user) => `@${user.username}`).join(', ')} (no strangers)`);
}

async function stepApp(): Promise<void> {
  const ctx = await context();
  const env = readEnvFile();
  for (const spec of APPS) await configure(ctx, spec, env);
  await deployAll(APPS);
}

const requested = process.argv.slice(2);
for (const name of requested) if (!STEPS.includes(name as Step)) throw new Error(`Unknown step ${name}; steps: ${STEPS.join(', ')}`);
const steps: Step[] = requested.length > 0 ? (requested as Step[]) : [...STEPS];

for (const step of steps) {
  console.log(`--- ${step}`);
  if (step === 'env') stepEnv();
  if (step === 'services') await stepServices();
  if (step === 'data') await deployAll(DATA);
  if (step === 'relay') await deployAll([RELAY]);
  if (step === 'mattermost') await deployAll([MATTERMOST]);
  if (step === 'seed') {
    await seed();
    await checkAccounts(readEnvFile());
  }
  if (step === 'app') await stepApp();
}
console.log(`Done: ${steps.join(', ')}. Mattermost: ${readEnvFile().MM_URL ?? '(no address yet)'}`);
