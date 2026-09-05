use super::*;
#[path = "atomic_migrations_scenarios_tests.rs"]
mod scenarios;
use sqlx::{migrate::Migrate, PgConnection, PgPool};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
#[path = "../../../tests/support/test_postgres.rs"]
mod test_postgres;

tokio::task_local! {
    pub(super) static AFTER_40: (mpsc::Sender<i32>, Arc<Mutex<oneshot::Receiver<bool>>>);
}

pub(super) async fn after_40(connection: &mut PgConnection) -> Result<(), String> {
    let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(connection)
        .await
        .map_err(|e| e.to_string())?;
    AFTER_40
        .with(|hook| hook.0.clone())
        .send(pid)
        .await
        .map_err(|e| e.to_string())?;
    let receiver = AFTER_40.with(|hook| hook.1.clone());
    let fail = (&mut *receiver.lock().await)
        .await
        .map_err(|e| e.to_string())?;
    if fail {
        return Err("injected failure after 40".into());
    }
    Ok(())
}

fn catalog() -> sqlx::migrate::Migrator {
    migration_catalog()
}

#[test]
fn atomic_catalog_rejects_transaction_escape_and_no_tx() {
    assert!(validate_atomic_catalog(&catalog()).is_ok());
    for version in 39..=41 {
        let mut incompatible = catalog();
        incompatible
            .migrations
            .to_mut()
            .iter_mut()
            .find(|m| m.version == version)
            .unwrap()
            .no_tx = true;
        assert!(validate_atomic_catalog(&incompatible).is_err());
        let mut incompatible = catalog();
        incompatible
            .migrations
            .to_mut()
            .iter_mut()
            .find(|m| m.version == version)
            .unwrap()
            .sql = sqlx::SqlStr::from_static("COMMIT; VACUUM;");
        assert!(validate_atomic_catalog(&incompatible).is_err());
    }
}

async fn prefix(pool: &PgPool, version: i64) {
    sqlx::migrate!("./migrations")
        .run_to(version, pool)
        .await
        .unwrap();
}
async fn version(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap()
}
fn start(
    pool: PgPool,
) -> (
    tokio::task::JoinHandle<Result<(), String>>,
    mpsc::Receiver<i32>,
    oneshot::Sender<bool>,
) {
    let (entered, receiver) = mpsc::channel(1);
    let (resume, wait) = oneshot::channel();
    let task = tokio::spawn(
        AFTER_40.scope((entered, Arc::new(Mutex::new(wait))), async move {
            super::run_hosted_migrations(&pool).await
        }),
    );
    (task, receiver, resume)
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn atomic_runner_hides_40_and_rolls_back_failure() {
    let db = test_postgres::DisposablePostgres::from_projection_env().await;
    let pool = PgPool::connect(db.url()).await.unwrap();
    prefix(&pool, 38).await;
    let (task, mut entered, resume) = start(pool.clone());
    entered.recv().await.unwrap();
    assert_eq!(
        version(&pool).await,
        38,
        "40 must never be externally committed"
    );
    resume.send(true).unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!(version(&pool).await, 38);
    let mut fresh = pool.acquire().await.unwrap();
    fresh.close_on_drop();
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT pg_try_advisory_lock(hashtextextended('mdbase-candidate-b-cutover-v1',0))"
    )
    .fetch_one(&mut *fresh)
    .await
    .unwrap());
    tokio::time::timeout(std::time::Duration::from_secs(3), fresh.lock())
        .await
        .unwrap()
        .unwrap();
}
