# Legacy timer import origin schema

This SQL-only change adds one nullable `next_timers.legacy_import_origin jsonb` column and an object-or-SQL-NULL CHECK. It does not implement or enable a migration, importer, worker, native onboarding or account-flip exception.

## Representation

SQL NULL means an ordinary native-origin timer. It is NOT imported-origin metadata, successful import, completed migration, native admission or permission to fire. JSON null/arrays/scalars are rejected. Existing rows remain NULL with no backfill or default; the event/receipt tables and indexes are unchanged.

The planned strict importer retains only content-free original provenance here:

- Original runtime namespace and internal scoped runtime ID, application timer ID, generation as decimal text, status and original `fire_at`.
- Original event contract/source identity, source URI and subject.
- `record_sha256`: lowercase SHA-256 of the JCS-canonical original SQL `record_json::text`, after strict I-JSON validation. This is comparison data, not source authentication or a flip witness.
- `exact_timestamps`, only when flooring discards nonzero sub-microsecond digits: original RFC3339 `fire_at`, `fired_at`, `updated_at` and/or `created_at` strings as relevant.
- `data_erased: true` after content erasure, while retaining the original digest/origin. A subsequent import must refuse, not restore erased content.

There is no duplicate TimerRecord, application payload, raw record JSON, key, token hash, lease or delivery/outbox in origin. Operational data remains in the existing `data` column; generation/status/timestamps remain in existing columns. Source headers must be checked to be representable content-free identity metadata, not an arbitrary storage extension.

## Timestamp fidelity (co0699)

Source bytes/strings are never normalized or changed. The target importer floors original UTC RFC3339 timestamps to microseconds using validated string arithmetic, never rounds up and never reconstructs originals through JS Date. When nonzero digits are lost, retain those exact original strings in origin as above. Verify operational timestamps equal floor(original) and the original canonical digest matches. Refuse malformed calendars, unsupported range/precision, state, generation, identity or inconsistent SQL/record/wrapper representations.

The object CHECK intentionally does not turn metadata into authority or duplicate a changing application validator in SQL. Required fields and exact comparisons belong to the separately reviewed strict importer. Missing source inventory/session/fence/currentness remains UNKNOWN; metadata cannot repair it.

## Effects, privacy and lifecycle

A normal worker must verify the genuine original whole-account flip before ANY imported-timer cancellation, firing or receipt effect. Native pushes use native identities consistently, not reconstructed legacy identities. The runtime importer/guard/whole-account producer remain outside this SQL-only branch.

Content erasure removes operational timer/event data and retains only this content-free origin/digest plus an erasure marker; re-import cannot undo it. Subject/source identity and timestamp history remain private, follow existing timer retention and grant/account deletion, and must not be exposed through app notification data or audit/receipt storage. The additive column creates no new retention extension, reader, index, serving route or automatic cleanup policy.

## SQL review / tests

One SQL reviewer pass is required before merge. Migration number 0074 was checked against current main after 0073 collection grants merged. No production/LAB DDL execution is implied.

Four isolated real-PostgreSQL tests apply the actual existing 0045 DDL and this migration, exercising unchanged pre-existing/native rows and nullable default, content-free origin plus floored/exact timestamp storage, rejection of every non-object JSON kind, and erasure metadata without data restoration/digest change. These are SQL-schema tests, not runtime-importer fidelity, original source authentication, native/physical completion or late-fire/click qualification.
