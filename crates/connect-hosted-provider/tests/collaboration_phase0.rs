use mdbase_connect_collaboration::MarkdownBodyDocument;
use sqlx::{postgres::PgPoolOptions, AssertSqlSafe, PgPool};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;
use uuid::Uuid;

const CHILD_ENV: &str = "MDBASE_COLLABORATION_PHASE0_CHILD";
const DATABASE_ENV: &str = "MDBASE_COLLABORATION_PHASE0_DATABASE_URL";
const BODY: &str = "# Shared 👋\n\nTransient [[link\n";
const LIMIT: usize = 1024 * 1024;

#[tokio::test]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE0_DATABASE_URL PostgreSQL database"]
async fn collaboration_batch_is_atomic_across_process_crashes() {
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    let database_url = std::env::var(DATABASE_ENV).expect("database URL is required");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .unwrap();
    let schema = format!("collaboration_phase0_{}", Uuid::new_v4().simple());
    create_schema(&pool, &schema).await;
    let temporary = tempdir().unwrap();

    for failpoint in [
        "after_room",
        "after_record",
        "after_version",
        "after_change",
        "after_receipt",
    ] {
        let run_id = Uuid::new_v4();
        let marker = temporary.path().join(format!("{failpoint}.broadcast"));
        let status = child(&database_url, &schema, run_id, failpoint, &marker)
            .status()
            .unwrap();
        assert!(!status.success(), "{failpoint} must terminate the child");
        assert_state(&pool, &schema, run_id, 0).await;
        assert!(!marker.exists(), "{failpoint} broadcast before commit");
    }

    let committed_run = Uuid::new_v4();
    let marker = temporary.path().join("committed.broadcast");
    let status = child(
        &database_url,
        &schema,
        committed_run,
        "after_commit",
        &marker,
    )
    .status()
    .unwrap();
    assert!(!status.success());
    assert_state(&pool, &schema, committed_run, 1).await;
    assert!(!marker.exists(), "broadcast must follow commit");

    // Retrying the same client mutation after a lost post-commit process is
    // idempotent and publishes only the already committed sequence.
    let retry = child(&database_url, &schema, committed_run, "none", &marker)
        .status()
        .unwrap();
    assert!(retry.success());
    assert_state(&pool, &schema, committed_run, 1).await;
    assert_eq!(fs::read_to_string(&marker).unwrap(), "committed:1");

    let broadcast_run = Uuid::new_v4();
    let broadcast_marker = temporary.path().join("broadcast.broadcast");
    let status = child(
        &database_url,
        &schema,
        broadcast_run,
        "after_broadcast",
        &broadcast_marker,
    )
    .status()
    .unwrap();
    assert!(!status.success());
    assert_state(&pool, &schema, broadcast_run, 1).await;
    assert_eq!(
        fs::read_to_string(&broadcast_marker).unwrap(),
        "committed:1"
    );

    sqlx::query(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&pool)
        .await
        .unwrap();
}

#[test]
#[ignore = "child process for collaboration_batch_is_atomic_across_process_crashes"]
fn collaboration_phase0_child_process() {
    let Ok(failpoint) = std::env::var(CHILD_ENV) else {
        return;
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async move {
        let database_url = std::env::var(DATABASE_ENV).unwrap();
        let schema = std::env::var("MDBASE_COLLABORATION_PHASE0_SCHEMA").unwrap();
        let run_id =
            Uuid::parse_str(&std::env::var("MDBASE_COLLABORATION_PHASE0_RUN_ID").unwrap()).unwrap();
        let marker = std::env::var("MDBASE_COLLABORATION_PHASE0_MARKER").unwrap();
        run_child(
            &database_url,
            &schema,
            run_id,
            &failpoint,
            Path::new(&marker),
        )
        .await;
    });
}

fn child(
    database_url: &str,
    schema: &str,
    run_id: Uuid,
    failpoint: &str,
    marker: &Path,
) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("collaboration_phase0_child_process")
        .arg("--exact")
        .arg("--ignored")
        .env(CHILD_ENV, failpoint)
        .env(DATABASE_ENV, database_url)
        .env("MDBASE_COLLABORATION_PHASE0_SCHEMA", schema)
        .env("MDBASE_COLLABORATION_PHASE0_RUN_ID", run_id.to_string())
        .env("MDBASE_COLLABORATION_PHASE0_MARKER", marker);
    command
}

async fn run_child(database_url: &str, schema: &str, run_id: Uuid, failpoint: &str, marker: &Path) {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .unwrap();
    let document = MarkdownBodyDocument::new(BODY, LIMIT).unwrap();
    let snapshot = document.snapshot_v1();
    let revision = format!("phase0:{}", snapshot.len());
    let mut transaction = pool.begin().await.unwrap();

    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.rooms (run_id, snapshot, sequence, body) VALUES ($1, $2, 1, $3) \
         ON CONFLICT (run_id) DO NOTHING"
    )))
    .bind(run_id)
    .bind(&snapshot)
    .bind(BODY)
    .execute(&mut *transaction)
    .await
    .unwrap();
    crash_at(failpoint, "after_room");

    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.records (run_id, body, revision) VALUES ($1, $2, $3) \
         ON CONFLICT (run_id) DO NOTHING"
    )))
    .bind(run_id)
    .bind(BODY)
    .bind(&revision)
    .execute(&mut *transaction)
    .await
    .unwrap();
    crash_at(failpoint, "after_record");

    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.versions (run_id, revision) VALUES ($1, $2) \
         ON CONFLICT (run_id) DO NOTHING"
    )))
    .bind(run_id)
    .bind(&revision)
    .execute(&mut *transaction)
    .await
    .unwrap();
    crash_at(failpoint, "after_version");

    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.changes (run_id, sequence, revision) VALUES ($1, 1, $2) \
         ON CONFLICT (run_id) DO NOTHING"
    )))
    .bind(run_id)
    .bind(&revision)
    .execute(&mut *transaction)
    .await
    .unwrap();
    crash_at(failpoint, "after_change");

    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.receipts (run_id, client_mutation_id, sequence, revision) \
         VALUES ($1, $1, 1, $2) ON CONFLICT (run_id) DO NOTHING"
    )))
    .bind(run_id)
    .bind(&revision)
    .execute(&mut *transaction)
    .await
    .unwrap();
    crash_at(failpoint, "after_receipt");

    transaction.commit().await.unwrap();
    crash_at(failpoint, "after_commit");
    fs::write(marker, "committed:1").unwrap();
    crash_at(failpoint, "after_broadcast");
}

fn crash_at(actual: &str, expected: &str) {
    if actual == expected {
        std::process::abort();
    }
}

async fn create_schema(pool: &PgPool, schema: &str) {
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(pool)
        .await
        .unwrap();
    for statement in [
        format!("CREATE TABLE {schema}.rooms (run_id uuid PRIMARY KEY, snapshot bytea NOT NULL, sequence bigint NOT NULL, body text NOT NULL)"),
        format!("CREATE TABLE {schema}.records (run_id uuid PRIMARY KEY, body text NOT NULL, revision text NOT NULL)"),
        format!("CREATE TABLE {schema}.versions (run_id uuid PRIMARY KEY, revision text NOT NULL)"),
        format!("CREATE TABLE {schema}.changes (run_id uuid PRIMARY KEY, sequence bigint NOT NULL, revision text NOT NULL)"),
        format!("CREATE TABLE {schema}.receipts (run_id uuid PRIMARY KEY, client_mutation_id uuid UNIQUE NOT NULL, sequence bigint NOT NULL, revision text NOT NULL)"),
    ] {
        sqlx::query(AssertSqlSafe(statement))
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn assert_state(pool: &PgPool, schema: &str, run_id: Uuid, expected: i64) {
    for table in ["rooms", "records", "versions", "changes", "receipts"] {
        let count: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT count(*) FROM {schema}.{table} WHERE run_id = $1"
        )))
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(count, expected, "unexpected {table} count");
    }
    if expected == 1 {
        let (snapshot, room_body, sequence): (Vec<u8>, String, i64) =
            sqlx::query_as(AssertSqlSafe(format!(
                "SELECT snapshot, body, sequence FROM {schema}.rooms WHERE run_id = $1"
            )))
            .bind(run_id)
            .fetch_one(pool)
            .await
            .unwrap();
        let materialized = MarkdownBodyDocument::from_snapshot(&snapshot, LIMIT, LIMIT).unwrap();
        assert_eq!(materialized.body(), BODY);
        assert_eq!(room_body, BODY);
        assert_eq!(sequence, 1);
        let record_body: String = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT body FROM {schema}.records WHERE run_id = $1"
        )))
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(record_body, BODY);
    }
}
