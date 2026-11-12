#![allow(dead_code, unused_imports)]

//! The tolerant migration runner: a provider starts beside newer migrations
//! only when each one is recorded as rollback-compatible with the ledger's
//! checksum. See docs/hosted-provider-migrations.md.

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use std::path::Path;
use std::time::Duration;

use mdbase_connect_hosted_provider::{
    apply_newer_migrations_for_rollback_gate, run_hosted_cutover_migrations,
    ROLLBACK_COMPATIBLE_MIGRATION_MARKER,
};
use sqlx::{Connection, PgConnection};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;

const CUTOVER_LOCK_NAME: &str = "mdbase-candidate-b-cutover-v1";
const REFUSAL: &str = "hosted migration ledger is not an exact successful catalog prefix at ";

async fn locked(db: &DisposablePostgres) -> PgConnection {
    let mut connection = PgConnection::connect(db.url()).await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 0))")
        .bind(CUTOVER_LOCK_NAME)
        .execute(&mut connection)
        .await
        .unwrap();
    connection
}

async fn start(connection: &mut PgConnection) -> Result<(), String> {
    run_hosted_cutover_migrations(connection, Duration::from_secs(60)).await
}

async fn ledger(connection: &mut PgConnection) -> Vec<(i64, Vec<u8>)> {
    sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(connection)
        .await
        .unwrap()
}

/// A copy of this build's migrations (or of the newer release's, under the
/// rollback gate) plus one newer migration.
fn newer_catalog(sql: &str) -> (tempfile::TempDir, i64) {
    let source = std::env::var_os("MDBASE_TEST_NEWER_HOSTED_MIGRATIONS").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"),
        std::path::PathBuf::from,
    );
    let target = tempfile::tempdir().unwrap();
    let mut latest = 0;
    for entry in std::fs::read_dir(&source).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        latest = latest.max(name[..4].parse::<i64>().unwrap());
        std::fs::copy(&path, target.path().join(&name)).unwrap();
    }
    // Far above any real migration, so this also works when the rollback gate
    // has already applied a newer release's migrations to the schema.
    let version = 9000 + latest;
    std::fs::write(
        target
            .path()
            .join(format!("{version:04}_rollback_gate_fixture.sql")),
        sql,
    )
    .unwrap();
    (target, version)
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn provider_starts_beside_recorded_newer_migrations_only() {
    let db = DisposablePostgres::from_projection_env().await;
    let mut connection = locked(&db).await;
    start(&mut connection).await.unwrap();
    let before = ledger(&mut connection).await;
    let (latest, _) = before.last().cloned().unwrap();
    let version = latest + 9000;
    let checksum = vec![0x5a_u8; 48];
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES ($1, 'newer release', true, $2, 0)",
    )
    .bind(version)
    .bind(&checksum)
    .execute(&mut connection)
    .await
    .unwrap();

    // Unrecorded: refused exactly as before.
    let error = start(&mut connection).await.unwrap_err();
    assert!(error.starts_with(&format!("{REFUSAL}{version}")), "{error}");

    // Recorded with another checksum: refused.
    sqlx::query(
        "INSERT INTO hosted_provider_rollback_compatible_migrations (version, checksum) VALUES ($1, $2)",
    )
    .bind(version)
    .bind(vec![0x00_u8; 48])
    .execute(&mut connection)
    .await
    .unwrap();
    assert!(start(&mut connection)
        .await
        .unwrap_err()
        .starts_with(REFUSAL));

    // Recorded with the ledger checksum: starts, and leaves the ledger alone.
    sqlx::query(
        "UPDATE hosted_provider_rollback_compatible_migrations SET checksum = $2 WHERE version = $1",
    )
    .bind(version)
    .bind(&checksum)
    .execute(&mut connection)
    .await
    .unwrap();
    start(&mut connection).await.unwrap();
    start(&mut connection).await.unwrap();
    let mut expected = before.clone();
    expected.push((version, checksum.clone()));
    assert_eq!(ledger(&mut connection).await, expected);
    // This build's own record survives untouched for the newer version.
    let recorded: Vec<u8> = sqlx::query_scalar(
        "SELECT checksum FROM hosted_provider_rollback_compatible_migrations WHERE version = $1",
    )
    .bind(version)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(recorded, checksum);

    // A failed newer migration is refused even when recorded.
    sqlx::query("UPDATE _sqlx_migrations SET success = false WHERE version = $1")
        .bind(version)
        .execute(&mut connection)
        .await
        .unwrap();
    assert!(start(&mut connection)
        .await
        .unwrap_err()
        .starts_with(REFUSAL));
    sqlx::query("UPDATE _sqlx_migrations SET success = true WHERE version = $1")
        .bind(version)
        .execute(&mut connection)
        .await
        .unwrap();

    // Known migrations keep their exact checksum check beside newer ones.
    let (first, first_checksum) = before.first().cloned().unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum = $2 WHERE version = $1")
        .bind(first)
        .bind(vec![0x01_u8; 48])
        .execute(&mut connection)
        .await
        .unwrap();
    assert!(start(&mut connection)
        .await
        .unwrap_err()
        .starts_with(&format!("{REFUSAL}{first}")));
    sqlx::query("UPDATE _sqlx_migrations SET checksum = $2 WHERE version = $1")
        .bind(first)
        .bind(first_checksum)
        .execute(&mut connection)
        .await
        .unwrap();
    start(&mut connection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn marked_newer_migration_is_recorded_and_tolerated() {
    let db = DisposablePostgres::from_projection_env().await;
    let (catalog, version) = newer_catalog(&format!(
        "{ROLLBACK_COMPATIBLE_MIGRATION_MARKER}\nCREATE TABLE rollback_gate_fixture (id integer);\n"
    ));
    apply_newer_migrations_for_rollback_gate(db.url(), catalog.path())
        .await
        .unwrap();
    let mut connection = locked(&db).await;
    let recorded: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_provider_rollback_compatible_migrations r \
         JOIN _sqlx_migrations m USING (version, checksum) WHERE version = $1 AND m.success)",
    )
    .bind(version)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert!(recorded);
    start(&mut connection).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn unmarked_newer_migration_is_refused() {
    let db = DisposablePostgres::from_projection_env().await;
    let (catalog, version) =
        newer_catalog("-- An ordinary forward-only migration.\nCREATE TABLE rollback_gate_fixture (id integer);\n");
    apply_newer_migrations_for_rollback_gate(db.url(), catalog.path())
        .await
        .unwrap();
    let mut connection = locked(&db).await;
    let error = start(&mut connection).await.unwrap_err();
    assert!(error.starts_with(&format!("{REFUSAL}{version}")), "{error}");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn projection_indexer_accepts_recorded_newer_migrations_only() {
    let db = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(db.url()).await;
    let ledger_valid = || async {
        fixture
            .provider
            .projection_index_plan(None, 1)
            .await
            .unwrap()
            .migration_ledger_valid
    };
    // Under the rollback gate this schema already carries the newer release's
    // marked migrations; either way this build's indexer accepts it.
    assert!(ledger_valid().await);

    let (catalog, version) = newer_catalog(&format!(
        "{ROLLBACK_COMPATIBLE_MIGRATION_MARKER}\nCREATE TABLE rollback_gate_fixture (id integer);\n"
    ));
    apply_newer_migrations_for_rollback_gate(db.url(), catalog.path())
        .await
        .unwrap();
    assert!(ledger_valid().await);

    // Recorded with another checksum: refused, as for provider startup.
    let mut connection = PgConnection::connect(db.url()).await.unwrap();
    let recorded: Vec<u8> = sqlx::query_scalar(
        "SELECT checksum FROM hosted_provider_rollback_compatible_migrations WHERE version = $1",
    )
    .bind(version)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_provider_rollback_compatible_migrations SET checksum = $2 WHERE version = $1",
    )
    .bind(version)
    .bind(vec![0x00_u8; 48])
    .execute(&mut connection)
    .await
    .unwrap();
    assert!(!ledger_valid().await);
    sqlx::query(
        "UPDATE hosted_provider_rollback_compatible_migrations SET checksum = $2 WHERE version = $1",
    )
    .bind(version)
    .bind(&recorded)
    .execute(&mut connection)
    .await
    .unwrap();
    assert!(ledger_valid().await);

    // An unrecorded newer migration: refused.
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES ($1, 'newer forward-only release', true, $2, 0)",
    )
    .bind(version + 1)
    .bind(vec![0x5a_u8; 48])
    .execute(&mut connection)
    .await
    .unwrap();
    assert!(!ledger_valid().await);
}
