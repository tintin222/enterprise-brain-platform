import { baseConfigSchema, chatConfigSchema, relayConfigSchema, secretKeySchema } from '@brain/shared';
import { z } from 'zod';

export const runtimeConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  ...chatConfigSchema.shape,
  /** Provisioning creates bots with an admin user's token; Mattermost refuses bot creation to bots (D25). */
  MM_ADMIN_TOKEN: z.string().min(1),
  MM_TEAM_NAME: z.string().min(1),
  /** Provisioning adds agents as relay members with the relay owner (bridge) key. */
  BRIDGE_SECRET_KEY: secretKeySchema,
  MAX_EVENT_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
  RELAY_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(600),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
