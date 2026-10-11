import { baseConfigSchema, chatConfigSchema, relayConfigSchema, secretKeySchema } from '@brain/shared';
import { z } from 'zod';

export const bridgeConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  ...chatConfigSchema.shape,
  MM_BRIDGE_TOKEN: z.string().min(1),
  BRIDGE_SECRET_KEY: secretKeySchema,
  BACKFILL_DAYS: z.coerce.number().int().min(0).default(0),
  RELAY_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(600),
  CATCH_UP_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(300),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(300),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
