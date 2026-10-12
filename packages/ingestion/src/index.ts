// Relay -> brain indexing (docs/agents-and-ingestion.md, part B).
export { ingestionConfigSchema, type IngestionConfig } from './config.ts';
export { INGEST_KINDS, Ingestion, permalinkFor, purgeAuthor, purgeChannel, resetForRelayRebuild, type IngestionDeps } from './ingestion.ts';
export { buildThreadDocuments, chunk } from './render.ts';
export { INGESTION_MIGRATIONS_DIR, IngestionStore } from './store.ts';
