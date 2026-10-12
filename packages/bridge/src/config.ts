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
  /**
   * Which channels the brain reads (D50): `all` adds @brain to every public and private channel it has never
   * captured, `public` to public ones only, `opt-in` to none (D5: someone invites @brain). A channel @brain was
   * removed from stays out in every mode.
   */
  BRAIN_CAPTURE_CHANNELS: z.enum(['all', 'public', 'opt-in']).default('all'),
  /** How often the bridge looks for channels to capture (also at start and at reconciliation). */
  CAPTURE_SWEEP_SECONDS: z.coerce.number().int().min(5).default(60),
  /** /healthz, /readyz and /metrics (0 picks a free port). */
  BRIDGE_OPS_PORT: z.coerce.number().int().min(0).max(65535).default(9101),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
