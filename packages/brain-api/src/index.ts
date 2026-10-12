// @brain/brain-api: the brain's HTTP API, pages host and Mattermost callbacks (docs/brain/01-phase0-plan.md).
export { AccessError, AccessService, type Membership, type Principal } from './access.ts';
export { API_PREFIX, buildApp, type BrainApiDeps } from './app.ts';
export { requireAdmin, requirePrincipal, SESSION_COOKIE, writeContext } from './auth.ts';
export { ChannelLinker } from './channels.ts';
export { brainApiConfigSchema, type BrainApiConfig } from './config.ts';
export { COMMAND_TRIGGER, COMMAND_TRIGGERS, COMMANDS, ensureMattermostIntegration, SECRET_OAUTH_CLIENT, secretCommandToken, SETTING_COMMANDS, SETTING_OAUTH_CLIENT, type MattermostSetupDeps, type MattermostSetupResult } from './mattermost-setup.ts';
export { TokenSigner, type SessionPayload } from './sessions.ts';
export { startJobRunner, type JobRunner, type JobSpec } from './jobs.ts';
export { CONTAINER_ROLES, displayNameOf, PeopleService, personKey, profileText, type ContainerRole, type WhoKnowsHit } from './people.ts';
export { registerPhase1Jobs, type Phase1JobDeps } from './phase1-jobs.ts';
export { WorkspaceService, type HomePanels, type Milestone, type ProjectInput, type TopicInput } from './workspaces.ts';
export { dailyPeriod, everyMinutesPeriod, localParts } from './schedule.ts';
export { startEmbeddingWorker, type EmbeddingWorker, type EmbeddingWorkerOptions } from './worker.ts';
