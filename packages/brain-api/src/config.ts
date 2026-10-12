// Configuration of the brain API (docs/brain/01-phase0-plan.md sections 8 and 11). Feature flags per D55.
import { modelConfigSchema } from '@brain/models';
import { baseConfigSchema, chatConfigSchema, relayConfigSchema, secretKeySchema } from '@brain/shared';
import { z } from 'zod';

const flag = (defaultValue: boolean) => z.enum(['true', 'false']).default(defaultValue ? 'true' : 'false').transform((value) => value === 'true');

export const brainApiConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...chatConfigSchema.shape,
  ...relayConfigSchema.shape,
  ...modelConfigSchema.shape,
  /** The @brain bot's token: capture, ephemeral replies, pinned posts, membership lookups. */
  MM_BRIDGE_TOKEN: z.string().min(1),
  /** An admin user's token: bot creation for agents (D25), OAuth app and command registration, config patches. */
  MM_ADMIN_TOKEN: z.string().min(1),
  MM_TEAM_NAME: z.string().min(1),
  /** Agents become relay members through the relay owner (bridge) key. */
  BRIDGE_SECRET_KEY: secretKeySchema,
  /** The API listens for browsers and for Mattermost's callbacks, so not only on loopback. */
  BRAIN_API_HOST: z.string().min(1).default('0.0.0.0'),
  BRAIN_API_PORT: z.coerce.number().int().min(0).max(65535).default(9120),
  /** Where browsers reach the pages and the API. */
  BRAIN_PUBLIC_URL: z.url().default('http://localhost:9120'),
  /** Where Mattermost reaches the API for command, dialog and button callbacks (a private address). */
  BRAIN_INTERNAL_URL: z.url().default('http://brain-api:9120'),
  /** Service token for machine clients (our scripts, staging tools, tests). */
  BRAIN_API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  /** Signs session cookies and callback states (32 random bytes as hex). */
  BRAIN_SESSION_SECRET: secretKeySchema,
  BRAIN_SESSION_HOURS: z.coerce.number().positive().default(12),
  /** Installation time zone for schedules and dates in pages (R14). */
  BRAIN_TIMEZONE: z.string().min(1).default('Europe/Istanbul'),
  BRAIN_FEATURE_API: flag(true),
  BRAIN_FEATURE_CHAT_COMMANDS: flag(true),
  /** auto: on when an embedding provider is configured; true requires one; false keeps keyword search only. */
  BRAIN_FEATURE_SEMANTIC_SEARCH: z.enum(['auto', 'true', 'false']).default('auto'),
  /** Embedding worker: how often it looks for chunks and how many it sends per round. */
  EMBED_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(2),
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(64),
  /** The brain's web pages (a built brain-web); empty serves no pages. */
  BRAIN_WEB_DIR: z.string().default(''),
});

export type BrainApiConfig = z.infer<typeof brainApiConfigSchema>;
