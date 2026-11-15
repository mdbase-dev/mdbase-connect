#!/usr/bin/env bash
# Vendor the selected spec fixtures this repo runs into conformance/spec/,
# recording the spec commit they came from in conformance/spec/SOURCE.
#
# Usage: scripts/sync-spec-fixtures.sh <mdbase-spec checkout> [--working-tree]
#   --working-tree explicitly vendors uncommitted sources and records their hashes.
#   Provide a checkout of mdbase-spec at the commit to vendor, for example a
#   detached checkout of the selected revision. For a detached checkout, set
#   SPEC_BRANCH to the branch the commit is on (it is recorded in SOURCE).
#
# Afterwards run
#   cargo run -p mdbn-conformance --bin spec-conformance -- --bless
# so new fixture ids are recorded (as pending unless they already pass) and
# removed ones are dropped, then review and commit both.
set -euo pipefail

SPEC=${1:?usage: scripts/sync-spec-fixtures.sh <mdbase-spec checkout> [--working-tree]}
WORKING_TREE=${2:-}
if [[ -n "$WORKING_TREE" && "$WORKING_TREE" != "--working-tree" ]]; then
  echo "unknown option: $WORKING_TREE" >&2
  exit 1
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=$ROOT/conformance/spec

# Keep the entire v0.3 suite and its referenced artifacts at one revision.
mapfile -t FILES < <(git -C "$SPEC" ls-files -- \
  tests/v0.3 examples/v0.3 schemas/v0.3 schemas/testbed/v0.1 standard-packs _types _contracts testbed/v0.1/fixtures testbed/v0.1/scenarios)

git -C "$SPEC" rev-parse --git-dir >/dev/null
if [[ -z "$WORKING_TREE" && -n "$(git -C "$SPEC" status --porcelain -- "${FILES[@]}")" ]]; then
  echo "error: $SPEC has uncommitted changes to the vendored files; commit them first" >&2
  exit 1
fi
COMMIT=$(git -C "$SPEC" rev-parse HEAD)
BRANCH=${SPEC_BRANCH:-$(git -C "$SPEC" rev-parse --abbrev-ref HEAD)}

rm -rf "$DEST/tests" "$DEST/examples" "$DEST/schemas" "$DEST/standard-packs" "$DEST/_types" "$DEST/_contracts" "$DEST/testbed"
for f in "${FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  if [[ "$WORKING_TREE" == "--working-tree" ]]; then
    cp "$SPEC/$f" "$DEST/$f"
  else
    git -C "$SPEC" show "HEAD:$f" > "$DEST/$f"
  fi
done

{
  echo "# Vendored by scripts/sync-spec-fixtures.sh. Do not edit the files by hand."
  echo "repository: mdbase-dev/mdbase-spec (MIT License)"
  echo "branch: $BRANCH"
  echo "commit: $COMMIT"
  if [[ "$WORKING_TREE" == "--working-tree" ]]; then
    echo "working_tree: true # content hashes below identify uncommitted sources"
  fi
  echo "files:"
  for f in "${FILES[@]}"; do
    echo "  $(sha256sum "$DEST/$f" | cut -d' ' -f1)  $f"
  done
} > "$DEST/SOURCE"

echo "vendored ${#FILES[@]} files from $BRANCH @ $COMMIT"
