import { baseConfigSchema, chatConfigSchema, relayConfigSchema, secretKeySchema } from '@brain/shared';
import { z } from 'zod';

/** The agent runtime service (dispatcher and job runner) and the echo agent. */
export const runtimeConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  MAX_EVENT_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
  RELAY_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(600),
  MAX_REPLIES_PER_THREAD: z.coerce.number().int().min(1).default(10),
  REPLY_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** How often the agent list is re-read; a mention of an unknown key also re-reads it. */
  AGENT_REFRESH_SECONDS: z.coerce.number().int().min(1).default(30),
  CONTEXT_CHAR_BUDGET: z.coerce.number().int().min(1000).default(60_000),
  /** Required only for agents that use a model (not "echo"). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Default model id (D21); an agent's own `model` overrides it. */
  LLM_MODEL: z.string().min(1).default('claude-opus-5-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  LLM_MAX_TOKENS: z.coerce.number().int().min(256).default(16_000),
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

/** The internal admin API (`pnpm admin-api`, build-plan Phase 7 task 5). */
export const adminApiConfigSchema = z.object({
  ...provisionConfigSchema.shape,
  /** The @brain bot's token, to find its user id: adding @brain to a channel enables it. */
  MM_BRIDGE_TOKEN: z.string().min(1),
  ADMIN_API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  ADMIN_API_PORT: z.coerce.number().int().min(0).max(65535).default(9110),
});

export type AdminApiConfig = z.infer<typeof adminApiConfigSchema>;
