//! Rollback-compatible hosted-provider migrations.
//!
//! A migration whose leading comment header contains
//! [`ROLLBACK_COMPATIBLE_MIGRATION_MARKER`] declares that the previous release
//! keeps working against the schema it produces. The runner records each such
//! migration's version and SQLx checksum in
//! `hosted_provider_rollback_compatible_migrations` before applying it, so an
//! older build that does not have the file can still tell, from the database
//! alone, that a newer applied migration is safe to run beside. Every other
//! newer migration keeps the previous build from starting.
//!
//! Recording happens before the migration runs, never after: a crash between
//! the two leaves a row for an unapplied version, which no build consults,
//! rather than an applied compatible migration that an older build would
//! refuse.

use sqlx::{migrate::Migrator, PgConnection};

/// The comment line that declares a hosted migration rollback-compatible. It
/// must appear in the migration's leading comment header (the run of lines
/// starting with `--` at the top of the file), so it can share the header with
/// SQLx's own `-- no-transaction` directive. Release tooling reads it too.
pub const ROLLBACK_COMPATIBLE_MIGRATION_MARKER: &str = "-- mdbase: rollback-compatible";

/// Whether a migration's SQL declares itself rollback-compatible.
pub(crate) fn declares_rollback_compatible(sql: &str) -> bool {
    sql.lines()
        .take_while(|line| line.starts_with("--"))
        .any(|line| line.trim_end() == ROLLBACK_COMPATIBLE_MIGRATION_MARKER)
}

/// One `_sqlx_migrations` row: version, success, checksum.
pub(crate) type AppliedMigration = (i64, bool, Vec<u8>);
/// One recorded rollback-compatible migration: version, checksum.
pub(crate) type CompatibleMigration = (i64, Vec<u8>);

/// Check the applied ledger against this build's catalog.
///
/// The ledger must start with an exact, successful prefix of the catalog, as
/// before. Once the catalog is exhausted, every further (newer) row must be
/// successful and recorded as rollback-compatible with the same checksum.
/// Returns those newer versions; an empty result means the ledger is an
/// ordinary prefix that this build may migrate forward.
pub(crate) fn classify_ledger(
    catalog: &Migrator,
    applied: &[AppliedMigration],
    compatible: &[CompatibleMigration],
) -> Result<Vec<i64>, String> {
    let mut expected = catalog
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration());
    let mut newer = Vec::new();
    for (version, success, checksum) in applied {
        let known = if newer.is_empty() {
            expected.next()
        } else {
            None
        };
        match known {
            Some(migration) => {
                if migration.version != *version
                    || !success
                    || migration.checksum.as_ref() != checksum.as_slice()
                {
                    return Err(format!(
                        "hosted migration ledger is not an exact successful catalog prefix at {version}"
                    ));
                }
            }
            None => {
                let recorded =
                    compatible
                        .iter()
                        .any(|(compatible_version, compatible_checksum)| {
                            compatible_version == version && compatible_checksum == checksum
                        });
                if !success || !recorded {
                    return Err(format!(
                        "hosted migration ledger is not an exact successful catalog prefix at {version}: \
                         newer migration {version} is not recorded as rollback-compatible"
                    ));
                }
                newer.push(*version);
            }
        }
    }
    Ok(newer)
}

pub(crate) async fn recorded_compatible_migrations(
    connection: &mut PgConnection,
) -> Result<Vec<CompatibleMigration>, String> {
    let exists: bool = sqlx::query_scalar(
        "SELECT to_regclass('hosted_provider_rollback_compatible_migrations') IS NOT NULL",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(Vec::new());
    }
    sqlx::query_as(
        "SELECT version, checksum FROM hosted_provider_rollback_compatible_migrations ORDER BY version",
    )
    .fetch_all(connection)
    .await
    .map_err(|error| error.to_string())
}

/// Make the compatibility record agree with `catalog` for every version the
/// catalog contains. Rows for versions this build does not know are left
/// untouched: they belong to newer builds.
pub(crate) async fn record_catalog_compatibility(
    connection: &mut PgConnection,
    catalog: &Migrator,
) -> Result<(), String> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS hosted_provider_rollback_compatible_migrations (
             version bigint PRIMARY KEY,
             checksum bytea NOT NULL,
             recorded_at timestamptz NOT NULL DEFAULT now()
           )"#,
    )
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    let mut known = Vec::new();
    let mut versions = Vec::new();
    let mut checksums = Vec::new();
    for migration in catalog
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
    {
        known.push(migration.version);
        if declares_rollback_compatible(migration.sql.as_str()) {
            versions.push(migration.version);
            checksums.push(migration.checksum.to_vec());
        }
    }
    sqlx::query(
        r#"DELETE FROM hosted_provider_rollback_compatible_migrations recorded
           WHERE recorded.version = ANY($1)
             AND NOT EXISTS (
               SELECT 1 FROM unnest($2::bigint[], $3::bytea[]) AS marked(version, checksum)
               WHERE marked.version = recorded.version AND marked.checksum = recorded.checksum
             )"#,
    )
    .bind(&known)
    .bind(&versions)
    .bind(&checksums)
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_rollback_compatible_migrations (version, checksum)
           SELECT version, checksum FROM unnest($1::bigint[], $2::bytea[]) AS marked(version, checksum)
           ON CONFLICT (version) DO NOTHING"#,
    )
    .bind(&versions)
    .bind(&checksums)
    .execute(connection)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Record and apply an arbitrary migrations directory, as a newer build would.
///
/// Only for Connect CI's rollback gate: the previous release's provider tests
/// call this, through their disposable PostgreSQL fixture, with the candidate
/// release's migrations directory, then run their own tolerant startup
/// against the result.
#[doc(hidden)]
pub async fn apply_newer_migrations_for_rollback_gate(
    database_url: &str,
    migrations: &std::path::Path,
) -> Result<(), String> {
    use sqlx::Connection;
    let migrator = Migrator::new(migrations)
        .await
        .map_err(|error| error.to_string())?;
    let mut connection = PgConnection::connect(database_url)
        .await
        .map_err(|error| error.to_string())?;
    record_catalog_compatibility(&mut connection, &migrator).await?;
    migrator
        .run_direct(None, &mut connection, false)
        .await
        .map_err(|error| error.to_string())?;
    connection.close().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration, MigrationType};
    use std::borrow::Cow;

    fn migration(version: i64, sql: &'static str) -> Migration {
        Migration::new(
            version,
            Cow::Owned(format!("m{version}")),
            MigrationType::Simple,
            sqlx::SqlStr::from_static(sql),
            sql.starts_with("-- no-transaction"),
        )
    }

    fn catalog(migrations: Vec<Migration>) -> Migrator {
        let mut migrator = Migrator::DEFAULT;
        migrator.migrations = Cow::Owned(migrations);
        migrator
    }

    fn applied(migration: &Migration) -> AppliedMigration {
        (migration.version, true, migration.checksum.to_vec())
    }

    #[test]
    fn marker_must_be_in_the_leading_comment_header() {
        assert!(declares_rollback_compatible(
            "-- mdbase: rollback-compatible\nCREATE INDEX x ON t (a);"
        ));
        assert!(declares_rollback_compatible(
            "-- mdbase: rollback-compatible  \r\nCREATE INDEX x ON t (a);"
        ));
        assert!(declares_rollback_compatible(
            "-- no-transaction\n-- mdbase: rollback-compatible\nCREATE INDEX CONCURRENTLY x ON t (a);"
        ));
        assert!(declares_rollback_compatible(
            "-- Add an index.\n-- mdbase: rollback-compatible\nCREATE INDEX x ON t (a);"
        ));
        for sql in [
            "CREATE INDEX x ON t (a);\n-- mdbase: rollback-compatible",
            "\n-- mdbase: rollback-compatible\nCREATE INDEX x ON t (a);",
            " -- mdbase: rollback-compatible\nCREATE INDEX x ON t (a);",
            "-- mdbase: rollback-compatible-ish\nCREATE INDEX x ON t (a);",
            "-- mdbase:rollback-compatible\nCREATE INDEX x ON t (a);",
            "/* mdbase: rollback-compatible */\nCREATE INDEX x ON t (a);",
            "",
        ] {
            assert!(!declares_rollback_compatible(sql), "accepted {sql:?}");
        }
    }

    #[test]
    fn ledger_prefix_and_recorded_newer_migrations() {
        let one = migration(1, "CREATE TABLE a (x int);");
        let two = migration(2, "CREATE TABLE b (x int);");
        let three = migration(
            3,
            "-- mdbase: rollback-compatible\nCREATE INDEX c ON a (x);",
        );
        let four = migration(4, "ALTER TABLE a DROP COLUMN x;");
        let old = catalog(vec![one.clone(), two.clone()]);
        let recorded = vec![(3, three.checksum.to_vec())];

        // Ordinary prefixes, including an empty ledger.
        assert_eq!(classify_ledger(&old, &[], &[]), Ok(vec![]));
        assert_eq!(classify_ledger(&old, &[applied(&one)], &[]), Ok(vec![]));
        assert_eq!(
            classify_ledger(&old, &[applied(&one), applied(&two)], &recorded),
            Ok(vec![])
        );
        // A recorded newer migration is tolerated once the catalog is applied.
        assert_eq!(
            classify_ledger(
                &old,
                &[applied(&one), applied(&two), applied(&three)],
                &recorded
            ),
            Ok(vec![3])
        );
        // Unrecorded, checksum-mismatched, or failed newer migrations refuse.
        for (ledger, compatible) in [
            (vec![applied(&one), applied(&two), applied(&three)], vec![]),
            (
                vec![applied(&one), applied(&two), applied(&three)],
                vec![(3, four.checksum.to_vec())],
            ),
            (
                vec![
                    applied(&one),
                    applied(&two),
                    (3, false, three.checksum.to_vec()),
                ],
                recorded.clone(),
            ),
            (
                vec![
                    applied(&one),
                    applied(&two),
                    applied(&three),
                    applied(&four),
                ],
                recorded.clone(),
            ),
        ] {
            let error = classify_ledger(&old, &ledger, &compatible).unwrap_err();
            assert!(
                error.starts_with(
                    "hosted migration ledger is not an exact successful catalog prefix at "
                ),
                "{error}"
            );
        }
        // A newer migration never excuses a gap or a changed known migration:
        // known versions keep their exact checksum check.
        assert!(classify_ledger(&old, &[applied(&one), applied(&three)], &recorded).is_err());
        assert!(classify_ledger(
            &old,
            &[
                applied(&one),
                (2, true, one.checksum.to_vec()),
                applied(&three)
            ],
            &recorded
        )
        .is_err());
        assert!(classify_ledger(
            &old,
            &[applied(&one), (2, false, two.checksum.to_vec())],
            &[]
        )
        .is_err());
    }
}
