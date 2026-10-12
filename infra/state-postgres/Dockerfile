# Our state database: the pinned Postgres image (the same one infra/compose.yml uses for every database) with
# the pgvector extension compiled in (D52). Same base, locale and data layout as the plain image, so an
# existing data directory keeps working; `CREATE EXTENSION vector` runs from a brain migration.
# Build from this directory: docker build -t enterprise-brain/state-postgres:17.11-pgvector-0.8.7 infra/state-postgres
# Staging builds the same file (docs/staging.md).
ARG POSTGRES_IMAGE=postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

FROM ${POSTGRES_IMAGE} AS build
# pgvector release, pinned by tag and commit (checked after the clone).
ARG PGVECTOR_VERSION=v0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876
# The image's Postgres was built with clang-21 (pg_config: CLANG = clang-21), so the extension's bitcode needs the same.
RUN apk add --no-cache git build-base clang21 llvm21-dev \
 && git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /src/pgvector \
 && cd /src/pgvector \
 && test "$(git rev-parse HEAD)" = "${PGVECTOR_COMMIT}" \
 && make OPTFLAGS="" \
 && make install

FROM ${POSTGRES_IMAGE}
ARG PGVECTOR_VERSION=v0.8.7
LABEL org.opencontainers.image.description="Postgres 17.11 (Alpine) with pgvector ${PGVECTOR_VERSION} for the Enterprise Brain state database"
COPY --from=build /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=build /usr/local/lib/postgresql/bitcode/vector.index.bc /usr/local/lib/postgresql/bitcode/vector.index.bc
COPY --from=build /usr/local/lib/postgresql/bitcode/vector /usr/local/lib/postgresql/bitcode/vector
COPY --from=build /usr/local/share/postgresql/extension/vector.control /usr/local/share/postgresql/extension/vector.control
COPY --from=build /usr/local/share/postgresql/extension/vector--*.sql /usr/local/share/postgresql/extension/
