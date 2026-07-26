#!/bin/sh
set -eu

token=${NATS_AUTH_TOKEN:-}
port=${PORT:-}
if [ "${#token}" -lt 32 ]; then
  echo "NATS_AUTH_TOKEN must contain at least 32 characters" >&2
  exit 1
fi

case "$port" in
  ""|*[!0-9]*)
    echo "PORT must be a numeric HTTP monitoring port" >&2
    exit 1
    ;;
esac

case "$token" in
  *[!A-Za-z0-9_+=./-]*)
    echo "NATS_AUTH_TOKEN contains unsupported characters" >&2
    exit 1
    ;;
esac

# The constant prefix guarantees that an unquoted NATS config variable cannot
# be parsed as a number when a generated secret happens to start with a digit.
MDBASE_NATS_PASSWORD="mdbase_${token}"
MDBASE_NATS_HTTP_ADDR="0.0.0.0:${port}"
export MDBASE_NATS_PASSWORD MDBASE_NATS_HTTP_ADDR

nats-server -t -c /etc/nats/mdbase-connect.conf
exec nats-server -c /etc/nats/mdbase-connect.conf
