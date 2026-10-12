# Staging (Railway): the Buzz relay image pinned in infra/compose.yml, unchanged. Wrapping it keeps the digest pin,
# which Railway's image source does not document. The relay runs as its own user and keeps git data in the image's
# /data/git, without a volume: we use none of the relay's git features.
FROM ghcr.io/block/buzz:0.2.1@sha256:4e31b7c7abb7d00b6f513dc559e58d2b980416f1dc400aa01bcf762cf2989cfc
