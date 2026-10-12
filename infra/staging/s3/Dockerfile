# Staging (Railway): the S3-compatible store pinned in infra/compose.yml. start.sh also creates the relay's
# bucket, which buzz-s3-init does locally (Railway has no one-shot init containers).
FROM pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46
COPY --chmod=755 start.sh /usr/local/bin/start-s3.sh
ENTRYPOINT ["/usr/local/bin/start-s3.sh"]
