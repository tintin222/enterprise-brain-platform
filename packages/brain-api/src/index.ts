// @brain/brain-api: the brain's HTTP API, pages host and Mattermost callbacks (docs/brain/01-phase0-plan.md).
export { AccessError, AccessService, type Membership, type Principal } from './access.ts';
export { API_PREFIX, buildApp, type BrainApiDeps } from './app.ts';
export { requireAdmin, requirePrincipal, SESSION_COOKIE, writeContext } from './auth.ts';
export { ChannelLinker } from './channels.ts';
export { brainApiConfigSchema, type BrainApiConfig } from './config.ts';
export { COMMAND_TRIGGER, ensureMattermostIntegration, SECRET_OAUTH_CLIENT, secretCommandToken, SETTING_COMMANDS, SETTING_OAUTH_CLIENT, type MattermostSetupDeps, type MattermostSetupResult } from './mattermost-setup.ts';
export { TokenSigner, type SessionPayload } from './sessions.ts';
export { startEmbeddingWorker, type EmbeddingWorker, type EmbeddingWorkerOptions } from './worker.ts';
