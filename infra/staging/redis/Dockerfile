# Staging (Railway): the Redis image pinned in infra/compose.yml, with the same settings. The image's entrypoint
# fixes ownership of the volume at /data and drops to the redis user.
FROM redis:7.4.11-alpine3.21@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
CMD ["sh", "-c", "exec docker-entrypoint.sh redis-server --appendonly yes --requirepass \"$REDIS_PASSWORD\""]
