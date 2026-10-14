# Scoped zero-hosted account archive

The explicit profile `mdbase-recovery-set/zero-hosted-v1` admits a genuine
trusted-verifier result for a complete frozen cohort whose current held hosted
collection set is empty. The first slice is **LAB and staging only**; production
capture remains closed. This is not the one-hosted LAB fixture exception, a
three-database restore, a local-folder backup, or permission to omit hosted data.

The dedicated migration service obtains
`GET /internal/v1/next/migration/cohorts/{name}/archive-binding?view=zero-hosted-v1`.
It returns the same bounded `mdbase-migration-capture/1` DTO as `capture-v1`, but
requires a nonempty frozen cohort and every member's held hosted set empty.
Suspended/terminal membership is not silently omitted. The existing general
capture and production restrictions remain unchanged.

The archive producer encrypts the original complete frozen inventory and its
source-query/scope provenance as **two real metadata payloads**. Its empty hosted
closure performs no provider database/object reads or H6 fence. The encrypted
manifest, completion, signature and actual retained versions remain real; the
ONE existing workflow signer/verifier must qualify their source, encryption,
hashes, complete closure and exact116-day GOVERNANCE retention. Metadata or a
local test fixture is not that cryptographic qualification.

The closed verified-result object uses the existing base fields:
`schema, environment, bucket, prefix, backup_id, complete_sha256, manifest_sha256,
source_commit, migration_batch, archive_created_at, archive_completed_at,
retention`. The schema is the named zero profile, the environment is `lab` or
`staging`, and the prefix is `legacy-archive/ENV/YYYY/MM/DD/ID`, matching the
archive identity. `retention.count` is exactly the string `"2"`, counting the
actual encrypted inventory/provenance payloads, not invented database dumps.
All existing binding, original-time, freshness, expiry and immutable retry
checks apply.

`backup-accept` independently checks the CURRENT complete frozen inventory is
nonempty and all held hosted sets are empty. Account start/current archive use
and cohort completion repeat the scope check under the existing cohort lock.
Migration0079 additively extends the acceptance profile and elapsed-time SQL
checks; prior migration bytes and immutable historical receipts are unchanged.

After genuine acceptance, the normal dedicated-service account start and flip
apply. For a zero-hosted account the flip submits `collections:[]` and the
existing `flipEvidenceDigest([])` (SHA-256 of the empty byte string). The timer
service must still be enabled, and starter reservation/currentness checks remain.
Cohort membership or a Native Private grant alone never flips the account.
Nonempty cohorts retain the existing source-exclusion archive refusal.
