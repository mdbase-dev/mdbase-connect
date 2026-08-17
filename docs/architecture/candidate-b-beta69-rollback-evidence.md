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

## Conclusions

- The exact production beta69 rollback image starts and serves exact authority on the final additive schema.
- Beta69 writes make a prior projection binding stale rather than corrupting or falsely advancing it.
- Roll-forward detects the stale binding and rebuilds from encrypted exact authority.
- Projection indexing changes derived rows/bindings only; the measured canonical authority/journal/outbox digest is unchanged.
- No schema downgrade, exact rewrite, projection deletion, or migration-ledger edit is required.

This is disposable local evidence, not authorization to run the sequence on production. The same procedure must pass on the fresh beta69-based staging database and the exact immutable release candidate before the production gate.
