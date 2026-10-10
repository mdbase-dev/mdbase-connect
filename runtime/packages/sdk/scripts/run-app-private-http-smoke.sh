#!/usr/bin/env bash
# LOCAL fixture only; a fresh owned disposable postgres17 container. No LAB,
# deploy, shared database, checked-in credentials or budget/CI change.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ $# == 3 ]] || { printf 'usage: %s WASM OWNED_CONNECT_CHECKOUT PULLED_LOG_BINARY\n' "$0" >&2; exit 2; }
mkdir -p target
fixture="clients-private-http-test-$(date -u +%s)-$$"
secret=$(openssl rand -hex 16)
POSTGRES_PASSWORD="$secret" docker run --detach --name "$fixture" \
  --label mdbn.fixture.owner=clients --memory=512m --cpus=1 \
  --env POSTGRES_PASSWORD --env POSTGRES_DB=clients_private_http_test \
  -p 127.0.0.1::5432 postgres:17 > target/private-http-postgres-container.log
trap 'docker rm -f "$fixture" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
port=$(docker port "$fixture" 5432/tcp | awk -F: '{print $NF}')
ready=false
for i in $(seq 1 30); do
  # TCP only: postgres image's temporary init server is UNIX-socket ready
  # before it shuts down. Do not race that server with the real host carrier.
  if docker exec "$fixture" pg_isready -h 127.0.0.1 -U postgres -d clients_private_http_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { printf 'owned fixture postgres unavailable\n' >&2; exit 1; }
MDBASE_CONNECT_TEST_DATABASE_URL="postgres://postgres:$secret@127.0.0.1:$port/clients_private_http_test" \
MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS" \
node packages/sdk/scripts/app-private-http-smoke.mjs "$@"
