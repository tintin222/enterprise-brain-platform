#!/bin/sh
# Start the S3 server, create the relay's private bucket once the server answers, then wait on the server.
set -eu
/usr/bin/docker-entrypoint.sh server /data --console-address ":9001" &
server=$!
trap 'kill -TERM "$server" 2>/dev/null' TERM INT
until mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  kill -0 "$server" 2>/dev/null || exit 1
  sleep 1
done
mc mb --ignore-existing "local/$BUZZ_S3_BUCKET" >/dev/null
mc anonymous set none "local/$BUZZ_S3_BUCKET" >/dev/null
echo "Bucket $BUZZ_S3_BUCKET is ready"
wait "$server"
