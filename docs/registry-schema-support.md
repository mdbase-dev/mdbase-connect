# Local registry schema, backup, and recovery contract

Status: Phase 1 beta contract.

## Supported historical schemas

| Source | Detection | Result |
| --- | --- | --- |
| No database / empty SQLite file | No application tables and `user_version = 0` | Create the current schema through numbered migrations; no empty backup is created. |
| Connect `0.1.0-beta.28` through beta.31 | Exact unversioned beta.28 table set plus security sentinel columns and `user_version = 0` | Take and verify an online backup, adopt the numbered ledger, preserve all rows, then migrate through schema 2. |
| Numbered schema 1 | `user_version = 1` plus the completed baseline migration name/checksum | Apply the durable-journal migration and set schema 2. |
| Numbered schema 2 | `user_version = 2` plus both completed migration names/checksums | Verify the ledger and integrity; make no schema change. |

Older development/MVP shapes and unrecognized unversioned databases fail with
`registry_schema_incompatible`. A database with a higher `user_version`, a
missing ledger row, a non-completed row, or a changed checksum also fails closed.
There is deliberately no duplicate-column/error-string inference.

Schema 1 is the beta.28 physical schema plus
`connect_schema_migrations(version, name, checksum, state, started_at,
completed_at)`. Migration 1 is transactional. Its fault suite terminates after
backup, ledger creation, baseline application, ledger completion,
`user_version`, and commit; every fixture reopens twice.

Schema 2 adds the fenced mutation journal, encrypted final receipts,
acknowledgements, recovery evidence, replay tombstones, and exact historical
grant verification material. Legacy completed receipt rows are archived
losslessly and are not treated as a second runtime journal. Migration 2 has the
same interruption/reopen proof as the baseline migration.

## Backup contract

Before changing a non-empty historical database, Connect uses SQLite's online
backup API. This captures committed WAL content into a standalone database. A
successful backup is quick-checked before migration and stored under:

```text
<state-dir>/registry-backups/connector-v<schema>-<timestamp>-<uuid>.sqlite
<state-dir>/registry-backups/connector-v<schema>-<timestamp>-<uuid>.sqlite.json
```

The directory is mode `0700`; database, metadata, and the independent local
authentication key are mode `0600` on Unix. Authenticated metadata binds format
and source-schema versions, creation time, filename, byte length, and SHA-256.
The database and containing directory are synced before migration begins.

Connect does not prune beta migration backups automatically. They remain until
an operator deliberately archives or removes them after the release rollback
window. The backup is a complete registry image because grants, receipts, and
WAL-consistent state must remain recoverable; its content is never logged or
included in the privacy-safe diagnostic report.

## Integrity, diagnostics, and recovery

Every open runs `quick_check` before migration and after open/migration.
`CollectionRegistry::registry_diagnostics` additionally runs the deeper
`integrity_check` and reports schema/backup status without exporting grants,
receipts, record data, or collection content.

Errors are distinct:

- `registry_corrupt`: SQLite corruption/not-a-database or a failed integrity
  check; the source file is left untouched;
- `registry_schema_incompatible`: recognized SQLite but unsupported or
  checksum-mismatched schema;
- `registry_busy`: another owner prevents the bounded database acquisition;
- `registry_migration_failed`: a numbered migration fails for another reason;
- `registry_backup_invalid`: backup metadata, authentication, digest, or restore
  validation fails.

Recovery is deliberate and offline:

1. stop the connector;
2. preserve `connector.sqlite` and any `-wal`/`-shm` siblings under a diagnostic
   name;
3. inspect backup diagnostics and select a verified metadata file;
4. call `restore_registry_backup` to a new path (it refuses to overwrite);
5. open and verify the restored database, then have management tooling place it
   at `connector.sqlite` explicitly.

`rebuild_registry_indexes` issues SQLite `REINDEX` only. It never drops tables,
grants, activity, or receipts, and it requires a green post-rebuild integrity
check. Reconstructing the whole registry from Markdown is not automatic because
Markdown cannot reconstruct authorization or mutation-recovery history.
