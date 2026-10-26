# Original hosted timer source snapshots

`readHostedLegacyTimers(provider, collectionId, cursor)` replaces the active-only,
lossy legacy projection with SELECT-only keyset pages over the original runtime
namespace and ID. It does not initialize or migrate runtime storage.

Every page requires existing runtime schema 2, a migrating collection with its
original fence identity/start/head, no live in-flight mutation (provider H6 rule:
expired claimed/prepared and applied journal rows are retained evidence), and no
unfinished notification work. Missing, firing, leased, UNKNOWN, malformed or
unsupported timer/run records refuse; their expiry is not settlement. Scheduled, fired and cancelled rows are all included.

Pages contain at most 64 timers and 48 KiB, reserving native envelope space below
128 rows/64 KiB. `nextCursor` names the last **included** `(namespace,id)` and the
original fence DATA. Resume until null; collection size is not a stop condition.
An oversized single record refuses rather than being skipped. Changed fence
binding refuses rather than opening another source session.

Required DTO fields are `grant_id`, `namespace`, `id`, `criterion_id`, `fire_at`,
`data`, decimal-text `generation`, `status`, `created_at`, `updated_at`, nullable
`fired_at`, `runtime_namespace`, `runtime_id`, and raw SQL `record_json::text`.
The full original record is ephemeral transport, not an archival CP column.
SQL, full record and Connect wrapper must agree. Original UTC RFC3339 strings
retain their full fractional precision without a JS Date conversion or source
normalization. The physical SQL schedule must equal floor(original) at
microsecond precision. The target floors operational timestamptz fields and
retains exact original strings in approved origin metadata when nonzero digits
are lost; its digest still covers the unchanged original record. Unsafe JSON
numbers and malformed/out-of-range times refuse before payload projection.

The authenticated original migration caller must bind every page to its SAME
original frozen source session and all-pages provider watermark. Immediately
before the original flip, re-read the authenticated watermark: missing, changed
or format-mismatched data aborts the flip. DTOs, headers and readback are DATA,
not permission, native admission, completion receipts or authority to replay.

`next-timers copy-hosted` is the paged caller: it binds every page to one
provider run and an unchanged watermark, and records the manifest the account
flip re-checks (see `legacy-timer-import-target.md`). Push-target seal/unseal
commands are unchanged.
