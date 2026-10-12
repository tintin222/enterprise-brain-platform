import { baseConfigSchema, chatConfigSchema, relayConfigSchema } from '@brain/shared';
import { z } from 'zod';

export const ingestionConfigSchema = z.object({
  ...baseConfigSchema.shape,
  ...relayConfigSchema.shape,
  /** Only to build source links; ingestion never calls Mattermost. */
  ...chatConfigSchema.shape,
  /** A changed thread is re-indexed at most this long after its first change (B.2). */
  INGEST_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).default(30),
  /** Threads longer than this are split into overlapping chunks. */
  INGEST_CHUNK_CHARS: z.coerce.number().int().min(500).default(6000),
  RELAY_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(600),
  CATCH_UP_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(300),
  /** /healthz, /readyz and /metrics (0 picks a free port). */
  INGESTION_OPS_PORT: z.coerce.number().int().min(0).max(65535).default(9103),
});

export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;
