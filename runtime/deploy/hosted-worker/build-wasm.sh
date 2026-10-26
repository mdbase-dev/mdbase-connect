#!/usr/bin/env bash
# Build hosted.wasm on the remote builder (rcargo) and copy it here. Never builds
# under /tmp; removes the local target/ it pulls into.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# The runtime Cargo workspace, not the repository root.
repo=$(cd -- "$here/../.." && pwd)
features=()
output=hosted.wasm
if [[ ${1:-} == --local-rehearsal && $# == 1 ]]; then
  features=(--features local-rehearsal)
  output=hosted-local.wasm
elif (($#)); then
  echo "usage: build-wasm.sh [--local-rehearsal]" >&2; exit 2
fi
[[ ! -e "$repo/target" ]] || { echo "refusing to replace an existing $repo/target" >&2; exit 1; }
cd "$repo"
trap 'rm -rf -- "$repo/target"' EXIT
rcargo -q --pull wasm32-unknown-unknown/wasm-release/mdbn_hosted_worker.wasm build --locked \
  --target wasm32-unknown-unknown --profile wasm-release -p mdbn-hosted-worker "${features[@]}"
cp target/wasm32-unknown-unknown/wasm-release/mdbn_hosted_worker.wasm "$here/$output"
sha256sum "$here/$output"
