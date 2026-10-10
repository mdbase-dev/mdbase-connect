# LAB cohort archive acceptance data

The CP structural archive decoder supports the existing staging/production
`mdbase-recovery-set/v4` result and the separate
`mdbase-recovery-set/lab-cohort-v1` result with `environment: "lab"`.
LAB requires `legacy-archive/lab/YYYY/MM/DD/<backup_id>` and all existing v4
membership, archive hash/time and exact116-day GOVERNANCE retention fields.

LAB `source_commit` identifies Ops capture/signing source, not a guessed common
runtime release. Its exact `runtime_provenance` object contains `connect`,
`hosted_provider`, `relay` and `mcp`; each entry contains a lowercase40-hex
`commit`, a `sha256:` lowercase64-hex `image_digest`, and opaque `srv-...`
`service_id` (literal `srv-` followed by 1–80 lowercase alphanumeric characters).
Mixed commits are preserved. No private infrastructure mapping is
embedded in public CP code or fixtures.

This parser checks structure only. The ONE Ops verifier must independently
verify the fixed private LAB component mapping, signer/source/image attestations,
actual live identities/digests and matching signed completion/encrypted manifest
provenance before and after capture. It may emit a cohort result only after real
source-exclusion/full-coverage qualification; the current refusal remains closed.
General v3/global dumps, caller booleans and hold journals are not cohort evidence.

Acceptance continues to store the exact verifier result at the frozen membership
revision. Account start freshly rechecks the same binding, trusted database time,
capture-after-freeze, at-most24-hour capture, strict7-day age and exact116-day
retention. Retries do not renew archive age or replace an accepted revision.
Migration `0067` extends the same persisted elapsed validator for the explicit
LAB profile, without rewriting historical records or disabling immutable
acceptance triggers. Existing v4 staging/production semantics remain unchanged.

Explicit fresh LAB hold operation IDs, actor lineage, current expiry and UNKNOWN
retaining bounded TTL are separate Ops duties. Structural/source-only tests do
not authorize a capture, acceptance/start, migration, rollback or cutover.
