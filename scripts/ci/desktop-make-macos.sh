#!/usr/bin/env bash
# Apple's stapling service can drop the connection after notarization passes,
# and Apple Silicon packaging can leave the app ad hoc signed, so the signature
# check fails. Either fails the whole package. Nothing has been uploaded at this
# point, so package again; any other failure stops at once.
set -uo pipefail

attempts="${DESKTOP_MAKE_ATTEMPTS:-3}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for attempt in $(seq 1 "$attempts"); do
  pnpm --filter @mdbase/connect-desktop make 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  [ "$status" -eq 0 ] && exit 0
  grep -Eq 'Failed to (staple|codesign) your application' "$log" || exit "$status"
  [ "$attempt" -lt "$attempts" ] || exit "$status"
  echo "::warning::Signing or stapling failed on attempt $attempt of $attempts; packaging again."
  sleep "${DESKTOP_MAKE_RETRY_SECONDS:-60}"
done
