#!/bin/sh
set -eu

token=${NATS_AUTH_TOKEN:-}
if [ "${#token}" -lt 32 ]; then
  echo "NATS_AUTH_TOKEN must contain at least 32 characters" >&2
  exit 1
fi

exec nats-server -c /etc/nats/mdbase-connect.conf --auth "$token"
