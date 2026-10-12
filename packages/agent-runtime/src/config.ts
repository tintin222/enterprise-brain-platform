import { modelConfigSchema } from '@brain/models';
import { baseConfigSchema, chatConfigSchema, relayConfigSchema, secretKeySchema } from '@brain/shared';
import { z } from 'zod';

/** The agent runtime service (dispatcher and job runner) and the echo agent. */
export const runtimeConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  /** Providers, model ids and keys (D21, D54, D56). */
  ...modelConfigSchema.shape,
  MAX_EVENT_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
  RELAY_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(600),
  MAX_REPLIES_PER_THREAD: z.coerce.number().int().min(1).default(10),
  REPLY_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** How often the agent list is re-read; a mention of an unknown key also re-reads it. */
  AGENT_REFRESH_SECONDS: z.coerce.number().int().min(1).default(30),
  CONTEXT_CHAR_BUDGET: z.coerce.number().int().min(1000).default(60_000),
  /** /healthz, /readyz and /metrics (0 picks a free port). */
  RUNTIME_OPS_PORT: z.coerce.number().int().min(0).max(65535).default(9102),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

/** Agent provisioning (`pnpm agent:provision`). */
export const provisionConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  ...chatConfigSchema.shape,
  /** Bots are created with an admin user's token; Mattermost refuses bot creation to bots (D25). */
  MM_ADMIN_TOKEN: z.string().min(1),
  MM_TEAM_NAME: z.string().min(1),
  /** Agents become relay members through the relay owner (bridge) key. */
  BRIDGE_SECRET_KEY: secretKeySchema,
});

export type ProvisionConfig = z.infer<typeof provisionConfigSchema>;
