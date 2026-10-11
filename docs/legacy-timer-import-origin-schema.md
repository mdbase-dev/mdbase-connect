# Legacy timer import origin schema

This SQL-only change adds one nullable `next_timers.legacy_import_origin jsonb` column with object, key allowlist, digest, erasure-marker, exact-timestamp shape and 2048-byte storage checks. It does not implement or enable a migration, importer, worker, native onboarding or account-flip exception.

## Representation

SQL NULL means an ordinary native-origin timer. It is NOT imported-origin metadata, successful import, completed migration, native admission or permission to fire. JSON null/arrays/scalars are rejected. Non-NULL origins require a string `record_sha256` matching 64 lowercase hexadecimal characters; missing keys cannot pass via SQL UNKNOWN. Only the keys listed below are allowed. Existing rows remain NULL with no backfill or default; the event/receipt tables and indexes are unchanged.

The planned strict importer retains only content-free original provenance here:

- Original runtime namespace and internal scoped runtime ID, application timer ID, generation as decimal text, status and original `fire_at`.
- Original `event_contract` and `event_source` identity metadata.
- `source_uri_sha256` and `subject_sha256`: SHA-256 of UTF-8 JCS-canonical JSON of each ORIGINAL scalar (including quotes/escapes for strings, and the bytes `null` for a null subject). When present, each is a 64-character lowercase hexadecimal string. Never store raw `source_uri` or `subject`, which may contain record names/paths. Do not normalize or stringify the original into a different scalar before hashing.
- `record_sha256`: lowercase SHA-256 of the JCS-canonical original SQL `record_json::text`, after strict I-JSON validation. This is comparison data, not source authentication or a flip witness.
- `exact_timestamps`, only when flooring discards nonzero sub-microsecond digits: an object whose only permitted keys are `fire_at`, `fired_at`, `updated_at` and `created_at`, with string values holding the original RFC3339 values as relevant. JSON null, arrays and non-string values are rejected.
- `data_erased: true` after content erasure, while retaining the original digest/origin. No other value is permitted when present. A subsequent import must refuse, not restore erased content.

The complete top-level allowlist is `namespace`, `id`, `generation`, `status`, `fire_at`, `event_contract`, `event_source`, `source_uri_sha256`, `subject_sha256`, `runtime_id`, `record_sha256`, `exact_timestamps`, `data_erased`. `octet_length(origin::text)` must not exceed 2048 bytes, including JSONB formatting and UTF-8 multibyte characters. Larger origins STOP; the importer must not drop metadata or weaken this cap.

There is no duplicate TimerRecord, application payload, raw record JSON, key, token hash, lease or delivery/outbox in origin. Operational data remains in the existing `data` column; generation/status/timestamps remain in existing columns. Source headers must be checked to be representable content-free identity metadata, not an arbitrary storage extension.

## Timestamp fidelity (co0699)

Source bytes/strings are never normalized or changed. The target importer floors original UTC RFC3339 timestamps to microseconds using validated string arithmetic, never rounds up and never reconstructs originals through JS Date. When nonzero digits are lost, retain those exact original strings in origin as above. Verify operational timestamps equal floor(original) and the original canonical digest matches. Refuse malformed calendars, unsupported range/precision, state, generation, identity or inconsistent SQL/record/wrapper representations.

SQL enforces this bounded content-free storage shape, not timestamp calendar validity, complete source identity, import authority or account completion. Complete original fields and exact comparisons also belong to the separately reviewed strict importer. Missing source inventory/session/fence/currentness remains UNKNOWN; metadata cannot repair it.

## Effects, privacy and lifecycle

A normal worker must verify the genuine original whole-account flip before ANY imported-timer cancellation, firing or receipt effect. Native pushes use native identities consistently, not reconstructed legacy identities. The runtime importer/guard/whole-account producer remain outside this SQL-only branch.

Content erasure removes operational timer/event data and retains only this content-free origin/digest plus an erasure marker; re-import cannot undo it. Subject/source URI digests, other identity metadata and timestamp history remain private, follow existing timer retention and grant/account deletion, and must not be exposed through app notification data or audit/receipt storage. The additive column creates no new retention extension, reader, index, serving route or automatic cleanup policy.

## SQL review / tests

One SQL reviewer pass is required before merge. Migration number 0074 was checked against current main after 0073 collection grants merged. No production/LAB DDL execution is implied.

Isolated real-PostgreSQL schema tests apply the actual existing 0045 DDL and this migration, exercising unchanged pre-existing/native rows and nullable default, content-free origin plus floored/exact timestamp storage, rejection of non-object JSON, unknown/raw-content keys, missing/malformed digests, invalid erasure/timestamp shapes and oversized/multibyte origins, and erasure metadata without data restoration/digest change. This standalone DDL suite does not qualify the full migration chain, runtime-importer fidelity, original source authentication, native/physical completion or late-fire/click behavior; full-chain PostgreSQL compatibility requires a separate check. The memory adapter recognizes the private shape-section marker only because pg-mem lacks JSONB key-array subtraction and JSONPath; it keeps the nullable column/object check but is never shape-enforcement qualification.
