#!/usr/bin/env bash
# Validate every golden fixture in conformance/wire/ against docs/contracts/wire.cddl
# with the independent `cddl` validator (cargo install cddl). Positive fixtures must
# validate; .bad.cbor fixtures that break only the schema must not.
# Usage: scripts/check-wire-cddl.sh   (CDDL=/path/to/cddl to override the binary)
set -euo pipefail
cd "$(dirname "$0")/.."
CDDL=${CDDL:-cddl}
work=target/cddl-check
mkdir -p "$work"
rule_for() {
  case "$1" in
    attachment/ref-*) echo attachment-ref-v1 ;;
    attachment/content-legacy) echo file-content ;;
    attachment/content-*) echo attachment-content-v1 ;;
    attachment/file-attach-v1) echo file-attach-v1 ;;
    attachment/put-file-v1) echo put-attachment-file-v1 ;;
    attachment/conflict-v1) echo attachment-conflict-value-v1 ;;
    attachment/file-row-v1) echo attachment-file-row-v1 ;;
    attachment/tombstone-row-v1) echo attachment-tombstone-row-v1 ;;
    attachment/section-*) echo attachment-section-v1 ;;
    ordinary-file-promotion/op-*) echo ordinary-file-to-record-v1 ;;
    ordinary-file-promotion/effect-v1) echo reindex-ordinary-file-v1 ;;
    unindexed-markdown/payload-*) echo unindexed-markdown-payload-v1 ;;
    unindexed-markdown/put-*) echo unindexed-markdown-put-v1 ;;
    unindexed-markdown/record-to-file-v1) echo record-to-unindexed-markdown-v1 ;;
    unindexed-markdown/file-to-record-v1) echo unindexed-markdown-to-record-v1 ;;
    unindexed-markdown/effect-put-v1) echo put-unindexed-markdown-v1 ;;
    unindexed-markdown/effect-reindex-v1) echo reindex-unindexed-markdown-v1 ;;
    unindexed-markdown/conflict-*) echo unindexed-markdown-conflict-value-v1 ;;
    unindexed-markdown/file-row-v1) echo unindexed-markdown-file-row-v1 ;;
    unindexed-markdown/tombstone-row-*) echo unindexed-markdown-tombstone-row-v1 ;;
    unindexed-markdown/section-*) echo unindexed-markdown-section-v1 ;;
    unindexed-markdown/native-tombstone-last-v1) echo native-unindexed-markdown-tombstone-last-v1 ;;
    value/*) echo value ;;
    mutation/runtime-v1-*) echo attachment-runtime-v1-mutation ;;
    entry/runtime-v1-*) echo attachment-runtime-v1-entry-payload ;;
    manifest/runtime-v1-*) echo attachment-runtime-v1-manifest-payload ;;
    chunk/runtime-v1-*) echo attachment-runtime-v1-chunk-payload ;;
    mutation/*) echo mutation ;;
    entry/*) echo entry-payload ;;
    item/*) echo item ;;
    rekey/*) echo rekey-payload ;;
    key-grant/*) echo key-grant-payload ;;
    manifest/*) echo manifest-payload ;;
    chunk/*) echo chunk-payload ;;
    base/*) echo base-payload ;;
    policy/*) echo policy-payload ;;
    grant-approval/*) echo grant-approval-payload ;;
    head-witness/*) echo head-witness ;;
    log-service/append-appended|log-service/append-duplicate) echo append-result ;;
    log-service/read-result-behind) echo read-result ;;
    log-service/put-object-upload) echo put-object-result ;;
    log-service/get-object-range) echo get-object-params ;;
    log-service/stream-event) echo stream-event ;;
    log-service/*) echo ls-frame ;;
    list-resources-params-*) echo list-resources-params ;;
    list-resources-result-*) echo list-resources-result ;;
    client/receipt-*) echo receipt ;;
    client/status|client/status-resync-*|client/status-handover) echo sync-status ;;
    client/confirmed-head) echo confirmed-head ;;
    client/applied-prefix-params) echo applied-prefix-params ;;
    client/applied-prefix-ahead|client/applied-prefix-behind) echo applied-prefix ;;
    client/query-result-*) echo query-result ;;
    client/query-update-*) echo query-update ;;
    client/hold-file) echo hold ;;
    client/file-view) echo file-view ;;
    client/open-upload) echo open-upload-params ;;
    client/transfer-progress) echo transfer-progress ;;
    client/materialization) echo materialization ;;
    client/hello) echo hello-params ;;
    client/hello-result-*) echo hello-result ;;
    client/presence-peer) echo peer ;;
    client/*) echo client-frame ;;
    *) echo "" ;;
  esac
}
fail=0
# Ratchet: fixtures known not to match the current contracts, one per line as
# "<fixture> <owner/reason>". A listed fixture that now validates also fails, so
# entries are removed as soon as the fixture is fixed.
pending_file=conformance/wire/cddl-pending.txt
is_pending() { [[ -f "$pending_file" ]] && grep -qE "^$1([[:space:]]|$)" "$pending_file"; }
# Resource method schema cases are not typed mdbn-wire golden generators.
for f in conformance/wire/*/*.cbor conformance/resources/cddl/*.cbor; do
  rel=${f#conformance/wire/}
  rel=${rel#conformance/resources/cddl/}
  case "$rel" in *.bad.cbor) continue ;; esac
  case "$rel" in cbor/*) continue ;; esac
  rule=$(rule_for "${rel%.cbor}")
  [[ -z "$rule" ]] && { echo "no rule for $rel"; fail=1; continue; }
  schema="$work/${rule}.cddl"
  { echo "root = $rule"; cat docs/contracts/wire.cddl; } > "$schema"
  # cddl 0.10 exits 0 even when validation fails, so judge by its output.
  if "$CDDL" validate --cddl "$schema" --cbor "$f" >"$work/out.txt" 2>&1 && ! grep -q 'ERROR' "$work/out.txt"; then
    if is_pending "$rel"; then
      echo "FAIL $rel ($rule): validates now; remove it from $pending_file"; fail=1
    else
      echo "ok   $rel ($rule)"
    fi
  elif is_pending "$rel"; then
    echo "pend $rel ($rule): $(grep -E "^$rel" "$pending_file" | cut -d' ' -f2-)"
  else
    echo "FAIL $rel ($rule)"; sed 's/^/     /' "$work/out.txt" | head -20; fail=1
  fi
done
# Schema negatives (not profile negatives) must be rejected by the schema too.
# (value/bytes-not-a-value is skipped: cddl 0.10 accepts any top-level byte string.)
for f in conformance/wire/{mutation,entry,item,manifest,grant-approval,head-witness,attachment,unindexed-markdown}/*.bad.cbor conformance/wire/chunk/runtime-v1-*.bad.cbor conformance/resources/cddl/*.bad.cbor; do
  rel=${f#conformance/wire/}
  rel=${rel#conformance/resources/cddl/}
  rule=$(rule_for "${rel%.bad.cbor}")
  schema="$work/${rule}.cddl"
  { echo "root = $rule"; cat docs/contracts/wire.cddl; } > "$schema"
  if "$CDDL" validate --cddl "$schema" --cbor "$f" >"$work/out.txt" 2>&1 && ! grep -q 'ERROR' "$work/out.txt"; then
    echo "FAIL $rel ($rule): accepted, must be rejected"; fail=1
  else
    echo "ok   $rel rejected ($rule)"
  fi
done
exit $fail
