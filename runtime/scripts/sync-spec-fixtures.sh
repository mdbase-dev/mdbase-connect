#!/usr/bin/env bash
# Vendor the rc.5 conformance fixtures this repo runs into conformance/spec/,
# recording the spec commit they came from in conformance/spec/SOURCE.
#
# Usage: scripts/sync-spec-fixtures.sh <mdbase-spec checkout>
#   Provide a checkout of mdbase-spec at the commit to vendor, for example a
#   detached checkout of the selected revision. For a detached checkout, set
#   SPEC_BRANCH to the branch the commit is on (it is recorded in SOURCE).
#
# Afterwards run
#   cargo run -p mdbn-conformance --bin spec-conformance -- --bless
# so new fixture ids are recorded (as pending unless they already pass) and
# removed ones are dropped, then review and commit both.
set -euo pipefail

SPEC=${1:?usage: scripts/sync-spec-fixtures.sh <mdbase-spec checkout>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=$ROOT/conformance/spec

# The vendored set: pure-function fixture files plus the format README.
FILES=(
  tests/v0.3/README.md
  tests/v0.3/merge/merge.yaml
  tests/v0.3/merge/body-edits.yaml
  tests/v0.3/cel/regex-profile.yaml
  tests/v0.3/core/paths.yaml
  tests/v0.3/core/link-ambiguity.yaml
  tests/v0.3/core/rename-references.yaml
  tests/v0.3/core/links-and-discovery.yaml
  tests/v0.3/core/core-collection.yaml
  tests/v0.3/core/core-write.yaml
  tests/v0.3/core/list-ops-and-fidelity.yaml
  tests/v0.3/core/optional-membership.yaml
  tests/v0.3/core/validation-tiers.yaml
  tests/v0.3/core/body-edits-update.yaml
  tests/v0.3/core/yaml-document-records.yaml
  tests/v0.3/cel/match-determinism.yaml
  tests/v0.3/lifecycle/lifecycle.yaml
  tests/v0.3/data-contracts/data-contracts.yaml
  tests/v0.3/type-packs/type-packs.yaml
  examples/v0.3/tasknotes-migration/v0.3/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-baseline-digest/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-baseline-digest/_types/note.md
  examples/v0.3/seed-upgrades/invalid-duplicate-baseline/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-duplicate-baseline/_types/note.md
  examples/v0.3/seed-upgrades/invalid-empty-baselines/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-empty-baselines/_types/note.md
  examples/v0.3/seed-upgrades/invalid-incomplete-baseline/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-incomplete-baseline/_types/note.md
  examples/v0.3/seed-upgrades/invalid-managed-upgrade/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-managed-upgrade/_types/note.md
  examples/v0.3/seed-upgrades/invalid-name-mismatch/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-name-mismatch/_types/note.md
  examples/v0.3/seed-upgrades/invalid-self-baseline/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-self-baseline/_types/note.md
  examples/v0.3/seed-upgrades/invalid-version-mismatch/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/invalid-version-mismatch/_types/note.md
  examples/v0.3/seed-upgrades/v1.5-plain/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/v1.5-plain/_types/note.md
  examples/v0.3/seed-upgrades/v1/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/v1/_types/note.md
  examples/v0.3/seed-upgrades/v2/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/v2/_types/note.md
  examples/v0.3/seed-upgrades/v3/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/v3-only-v2/mdbase-pack.yaml
  examples/v0.3/seed-upgrades/v3-only-v2/_types/note.md
  examples/v0.3/seed-upgrades/v3/_types/note.md
  examples/v0.3/tasknotes-migration/v0.3/_contracts/tasknotes.task.md
  examples/v0.3/tasknotes-migration/v0.3/_types/task.md
  tests/v0.3/fixtures/data-contracts/conflicting-tasknotes.task.md
  tests/v0.3/fixtures/data-contracts/duplicate-implementation-type.md
  tests/v0.3/fixtures/data-contracts/invalid-binding-type.md
  tests/v0.3/fixtures/data-contracts/invalid-task.yml
  tests/v0.3/fixtures/data-contracts/json-pointer-contact.contract.md
  tests/v0.3/fixtures/data-contracts/json-pointer-contact-type.md
  tests/v0.3/fixtures/data-contracts/json-pointer-contact.yml
  tests/v0.3/fixtures/data-contracts/legacy-extension-type.md
  tests/v0.3/fixtures/data-contracts/missing-required-map-type.md
  tests/v0.3/fixtures/data-contracts/unknown-record-field-type.md
  tests/v0.3/fixtures/data-contracts/valid-task.yml
  tests/v0.3/watch/move-detection.yaml
)

git -C "$SPEC" rev-parse --git-dir >/dev/null
if [ -n "$(git -C "$SPEC" status --porcelain -- "${FILES[@]}")" ]; then
  echo "error: $SPEC has uncommitted changes to the vendored files; commit them first" >&2
  exit 1
fi
COMMIT=$(git -C "$SPEC" rev-parse HEAD)
BRANCH=${SPEC_BRANCH:-$(git -C "$SPEC" rev-parse --abbrev-ref HEAD)}

rm -rf "$DEST/tests" "$DEST/examples"
for f in "${FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  git -C "$SPEC" show "HEAD:$f" > "$DEST/$f"
done

{
  echo "# Vendored by scripts/sync-spec-fixtures.sh. Do not edit the files by hand."
  echo "repository: mdbase-dev/mdbase-spec (MIT License)"
  echo "branch: $BRANCH"
  echo "commit: $COMMIT"
  echo "files:"
  for f in "${FILES[@]}"; do
    echo "  $(sha256sum "$DEST/$f" | cut -d' ' -f1)  $f"
  done
} > "$DEST/SOURCE"

echo "vendored ${#FILES[@]} files from $BRANCH @ $COMMIT"
