# Image for our services: bridge, agent-runtime, ingestion and the brain API (with the built pages), plus their
# operations tools. One image for all of them; the command picks the program, e.g.
# `node --import tsx packages/brain-api/src/main.ts` (on Railway, each service's start command).
# Build from the repository root: docker build -f infra/services/Dockerfile .
# The services run their TypeScript source with tsx (no build step); only the pages (brain-web) are built, in
# the first stage. Configuration comes from the environment only; .dockerignore keeps .env out of the context.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS manifests
WORKDIR /app
# Workspace manifests first, so dependency layers are reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/models/package.json packages/models/
COPY packages/brain/package.json packages/brain/
COPY packages/brain-api/package.json packages/brain-api/
COPY packages/brain-web/package.json packages/brain-web/
COPY packages/bridge/package.json packages/bridge/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/ingestion/package.json packages/ingestion/
COPY scripts/package.json scripts/
COPY e2e/package.json e2e/

# The pages are built with the development dependencies of brain-web only.
FROM manifests AS web
RUN corepack enable pnpm && pnpm install --frozen-lockfile --filter @brain/brain-web
COPY packages/brain-web/ packages/brain-web/
RUN pnpm --filter @brain/brain-web build

FROM manifests
ENV NODE_ENV=production
# Corepack installs the pnpm version pinned in package.json (packageManager).
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod && pnpm store prune
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY --from=web /app/packages/brain-web/dist packages/brain-web/dist
ENV BRAIN_WEB_DIR=/app/packages/brain-web/dist

USER node
CMD ["node", "--import", "tsx", "packages/bridge/src/main.ts"]
