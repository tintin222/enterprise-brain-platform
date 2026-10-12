#!/usr/bin/env bash
# The clean-install test (NFR-12 and the Phase 0 gate, docs/brain/01-phase0-plan.md section 12): from a machine
# with only Docker to a searchable entity, timed, then wiped. It discards any existing config.env, so run it on a
# clean machine or a throwaway checkout, never on a real installation.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f config.env ] && [ "${BRAIN_TEST_FORCE:-}" != "1" ]; then
  echo "install/config.env exists; this test wipes everything. Set BRAIN_TEST_FORCE=1 to run it anyway." >&2
  exit 2
fi
started=$(date +%s)
cleanup() { ./brain down --wipe >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Start from nothing: an earlier installation's volumes would not match the keys generated below.
cleanup
rm -f config.env
./brain init
echo "--- up ---"
./brain up
echo "--- self-test ---"
./brain selftest
elapsed=$(( $(date +%s) - started ))
echo "Clean install and self-test finished in ${elapsed} s (NFR-12 allows 3600 s)."
[ "$elapsed" -lt 3600 ]
