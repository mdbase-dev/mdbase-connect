# Legacy notification migration fence

The existing authenticated `GET /internal/v1/collections/{id}/legacy-migration`
returns its original drain body plus `Cache-Control: no-store` and a strong
`ETag: "mdbase-legacy-notifications-v1:<64 lowercase hex>"`. No CPP or native
wire field is added. The caller must capture and compare this ETag immediately
before cutover; missing, unsupported or changed observations require abort and
return to legacy ACTIVE, never an inferred unchanged result.

## Snapshot and fingerprint

The drain counters and watermark share one REPEATABLE READ READ ONLY snapshot.
No timer/run record payload, opaque token or payload/token hash is selected for
the watermark. SHA-256 consumes a sequence of UTF-8 strings, each framed with
its byte length as an unsigned 64-bit big-endian integer:

1. `mdbase-legacy-notifications-watermark/v1`, collection UUID, `schema:2`.
2. Every timer/run metadata row as PostgreSQL jsonb text, ordered by row kind
   (timers then runs), namespace and ID with C collation. Rows include the
   complete primary key and `xmin::text`, generation/revision, state and
   applicable scheduling/lease-presence/expiry metadata; runs also include
   executor/workflow/trigger identity and creation/not-before time.
3. Event maximum cursor and count, as decimal strings in a final jsonb array.

Rows are streamed rather than accumulated in a JSON aggregate. There is no
collection-wide row or byte cap. Query timeout or missing schema/data fails
closed without an ETag. Every row update changes its fingerprint, including
opaque lease replacement with unchanged token presence and expiry. Inserts and
deletes change the complete set. Freeze/VACUUM may cause a conservative false
change. The fence window is bounded; transaction-ID wraparound is outside that
window. Decimal values are strings and SQL timestamps are UTC microseconds.

## Effect admission and occupied work

Before the existing CP callback, Connect conditionally admits the persisted
running run/action-attempt under the collection's FOR SHARE lock, in its own
transaction. The attempt must still be dispatching, with the original invocation
identity and a current lease. Non-active collections do not send effects. The
existing recovery-loop guard is additional protection, not a substitute for
this admission or the immediate preflip watermark comparison.

Expired leases, unknown work and terminal labels with occupied leases do not
settle delivery. Pending outbox entries, firing timers and unfinished delivery
runs block fencing/cutover. Genuine completion belongs to the original runtime;
no synthetic completion, trigger, runtime seam or migration initializer is added.

The isolated PostgreSQL tests use physical projections and the original Connect
fence/effect methods. They are component guard evidence, not authenticated
whole-account migration, native completion or a deployment authorization.
