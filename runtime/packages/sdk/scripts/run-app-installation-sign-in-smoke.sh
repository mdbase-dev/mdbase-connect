#!/usr/bin/env bash
# Owned LOCAL fixture only. No shared/LAB/production DB, deploy or printed secret.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ $# == 2 ]] || { printf 'usage: %s WASM OWNED_CONNECT_CHECKOUT\n' "$0" >&2; exit 2; }
mkdir -p target
fixture="clients-installation-http-test-$(date -u +%s)-$$"
secret=$(openssl rand -hex 16)
POSTGRES_PASSWORD="$secret" docker run --detach --name "$fixture" \
 --label mdbn.fixture.owner=clients --memory=512m --cpus=1 \
 --env POSTGRES_PASSWORD --env POSTGRES_DB=clients_installation_http_test \
 -p 127.0.0.1::5432 postgres:17 > target/installation-http-postgres-container.log
trap 'docker rm -f "$fixture" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
port=$(docker port "$fixture" 5432/tcp | awk -F: '{print $NF}')
ready=false
for i in $(seq 1 30); do
 if docker exec "$fixture" pg_isready -h 127.0.0.1 -U postgres -d clients_installation_http_test >/dev/null 2>&1; then ready=true; break; fi
 sleep 1
done
[[ "$ready" == true ]] || { printf 'owned TEST postgres unavailable\n' >&2; exit 1; }
MDBASE_CONNECT_TEST_DATABASE_URL="postgres://postgres:$secret@127.0.0.1:$port/clients_installation_http_test" \
MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL="I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS" \
MDBN_APP_WASM="$1" MDBN_CONNECT_CHECKOUT="$2" \
node packages/sdk/scripts/app-installation-sign-in-smoke.mjs
