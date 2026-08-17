# Candidate B beta69 rollback and roll-forward evidence

Date: 2026-08-17

Database: disposable PostgreSQL 17 (`rollback_runtime`)

Rollback artifact: `ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:c233855520ab7b4fa0e2a6576bebb29cdfa029eef57ad327cd303aebb3516888`

Artifact revision: `90334b9c4f6de306bdee5b6992a849362d508789` / beta69

## Procedure and result

1. A clean database was migrated by the final provider through the exact SQLx ledger 1–36. A new collection completed initial projection indexing and verification.
2. Durable query admission was suspended and `prepare-hosted-provider-beta69-rollback.sql` ran successfully. It retained the completed generation and reported no incomplete generation work.
3. The immutable production beta69 provider image started against that additive final schema and returned a healthy response. Its embedded migrator accepted the newer ledger through the existing `ignore_missing` policy.
4. Through beta69’s normal internal/control and operation APIs, a known disposable account, collection, application replica, and exact Markdown record were created. Beta69 read the exact path and body back successfully.
5. The final indexer planned the beta69-created collection as unready, advanced bounded passes across separate process invocations, and ended with complete-inventory verification for every collection. The final provider then read the same exact path/body.
6. The service was rolled back a second time. Beta69 wrote a second exact record to the now-bound collection. As expected, the collection head advanced from 1 to 2 while `active_projection_head` remained 1, making the derived binding observably stale without affecting exact availability.
7. Before roll-forward indexing, a server-side digest was captured across the collection’s canonical fields, encrypted resources, exact records, retained versions, changes, resource changes, outbox, mutation journal, and archived receipts. Active projection binding fields and collection `updated_at` were excluded because they are derived/operational.
8. The final indexer rebuilt and verified both collections. The canonical digest before and after was identical:

   `34577d8c7e0b420c468c54e82abf3e00`

9. Final `verify` reported `ok: true`, a complete inventory, and every collection verified.

## Immutable-image upgrade fixture

`test/upgrade/provider-from-previous` now uses the exact beta69 provider digest
above rather than the obsolete beta28 fixture. It creates an account, collection,
mirror replica, encrypted exact Markdown record, durable mutation receipt, and
beta69-compatible notification grant through beta69's public/internal APIs. It
then:

1. hashes the canonical collection fields plus exact records, retained versions,
   changes, resources, files, immutable journal evidence, and stable outbox
   authority fields;
2. runs the `mdbase-hosted-projection-indexer` binary copied into the candidate
   provider image and requires complete-inventory verification;
3. starts the candidate provider and requires projection plus notification
   recovery readiness;
4. compares the canonical SHA-256 inventory unchanged after indexing and runtime
   recovery;
5. replays the exact beta69 mutation and receipt, compares the inventory unchanged
   again; and
6. applies a new revision-CAS exact update and requires the projection verifier to
   remain complete.

The 2026-08-17 run kept the inventory at
`sha256:3ea6f5e29b02495d627b151dca93e0c685055ded0cf39552700db15690990e8b`
through all non-mutating phases and passed the final exact update. The companion
server fixture also passed beta69 migrations followed by current migrations and a
current v5 OAuth authorization flow. Both upgrade harnesses accept isolated local
ports so an unrelated development service cannot satisfy their readiness probes.

Independent semantic and security re-review also exercised the final absent/stale
projection boundary. Disposable PostgreSQL regressions prove that an empty
unindexed beta69 collection returns a valid empty result, while a non-empty
collection whose active projection head is stale returns its canonical encrypted
record through bounded exact fallback. A missing generation can no longer inherit
a prior integrity-verification bit or enter the projected SQL fast path. Completed
authority imports are idempotent and do not restart projection work. Provider unit
tests (106 passed, 3 ignored), warnings-denied clippy, server tests (320 passed),
server typecheck, protocol tests (45 passed), and both focused PostgreSQL
regressions were green on 2026-08-17.

## Conclusions

- The exact production beta69 rollback image starts and serves exact authority on the final additive schema.
- Beta69 writes make a prior projection binding stale rather than corrupting or falsely advancing it.
- Roll-forward detects the stale binding and rebuilds from encrypted exact authority.
- Projection indexing changes derived rows/bindings only; the measured canonical authority/journal/outbox digest is unchanged.
- No schema downgrade, exact rewrite, projection deletion, or migration-ledger edit is required.

This is disposable local evidence, not authorization to run the sequence on production. The same procedure must pass on the fresh beta69-based staging database and the exact immutable release candidate before the production gate.
