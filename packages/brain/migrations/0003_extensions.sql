-- Vector search (D52) and trigram matching on titles. The state database image carries pgvector
-- (infra/state-postgres); the plain Postgres image would fail here, which is the intended signal.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
