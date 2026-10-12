# Staging (Railway): the Postgres image pinned in infra/compose.yml. Railway mounts each volume with a lost+found
# directory at its root, so the cluster lives in a subdirectory of the mount at /var/lib/postgresql/data.
FROM postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
ENV PGDATA=/var/lib/postgresql/data/pgdata
