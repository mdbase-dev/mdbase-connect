#!/usr/bin/env bash
# Validating a stapled ticket asks Apple's ticket service, which can drop the
# connection after notarization and stapling have passed. Exit 68 is that lookup
# failing, so ask again; any other failure stops at once.
set -uo pipefail

attempts="${DESKTOP_VALIDATE_ATTEMPTS:-5}"

for attempt in $(seq 1 "$attempts"); do
  xcrun stapler validate "$1"
  status="$?"
  [ "$status" -eq 0 ] && exit 0
  [ "$status" -eq 68 ] || exit "$status"
  [ "$attempt" -lt "$attempts" ] || exit "$status"
  echo "::warning::Ticket validation could not reach Apple on attempt $attempt of $attempts; asking again."
  sleep "${DESKTOP_VALIDATE_RETRY_SECONDS:-30}"
done
