// @brain/brain: the knowledge store (containers, entities, versions, links, chunks, audit, events), hybrid
// search, and the BrainClient that agents and ingestion use (docs/brain/01-phase0-plan.md).
export { PostgresBrainClient, splitDocId, toPassage, type PostgresBrainClientOptions } from './brain-client.ts';
export { approximateTokens, chunkEntityText, splitText, type ChunkOptions } from './chunker.ts';
export { DatabaseFileStore, type FileRecord, type FileStore, type StoredFile } from './files.ts';
export { hybridSearch, Params, scopeSql, toVectorLiteral } from './search.ts';
export { BRAIN_MIGRATIONS_DIR, BrainStore, BrainStoreError, defaultVisibility, EXPORT_TABLES, slugify, type AuditFilter, type ContainerFilter, type EntityFilter, type ExportTable } from './store.ts';
export * from './types.ts';
