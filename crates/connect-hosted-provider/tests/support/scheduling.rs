use std::{future::Future, time::Duration};

use sqlx::PgPool;

pub async fn wait_for_query_blocked(pool: &PgPool, query_fragment: &str) {
    let fragment = format!("%{query_fragment}%");
    wait_for_database_condition(pool, || {
        let pool = pool.clone();
        let fragment = fragment.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                r#"SELECT EXISTS (
                     SELECT 1 FROM pg_stat_activity
                     WHERE datname = current_database()
                       AND pid <> pg_backend_pid()
                       AND wait_event_type = 'Lock'
                       AND query LIKE $1
                   )"#,
            )
            .bind(fragment)
            .fetch_one(&pool)
            .await
            .expect("could not inspect blocked database queries")
        }
    })
    .await;
}

pub async fn wait_for_database_condition<F, Fut>(pool: &PgPool, mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let _ = pool;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if condition().await {
                return;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("database scheduling condition was not reached");
}
