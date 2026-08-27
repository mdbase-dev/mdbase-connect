use std::sync::{Arc, OnceLock};

use sqlx::{postgres::PgPoolOptions, AssertSqlSafe, PgPool};
use tokio::sync::{Mutex, OwnedMutexGuard};
use url::Url;
use uuid::Uuid;

const APPROVAL_ENV: &str = "MDBASE_APPROVE_DESTRUCTIVE_HOSTED_TESTS";
const EXACT_APPROVAL: &str = "operation_dispatch_uuid_schema_v1";

static SERIAL_TESTS: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

/// A loopback-only, UUID-schema-scoped PostgreSQL target for ignored destructive tests.
///
/// The serial guard keeps migration/global-count assertions isolated. Cleanup runs from
/// `Drop`, including while a test panic is unwinding.
pub struct DisposablePostgres {
    base_url: String,
    scoped_url: String,
    schema: String,
    _serial: OwnedMutexGuard<()>,
}

impl DisposablePostgres {
    pub async fn from_projection_env() -> Self {
        assert_eq!(
            std::env::var(APPROVAL_ENV).as_deref(),
            Ok(EXACT_APPROVAL),
            "set {APPROVAL_ENV}={EXACT_APPROVAL} only for a disposable loopback PostgreSQL target"
        );
        let base_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
            .expect("MDBASE_PROJECTION_DATABASE_URL is required");
        let mut url = Url::parse(&base_url).expect("PostgreSQL test URL is valid");
        assert!(
            matches!(url.scheme(), "postgres" | "postgresql"),
            "PostgreSQL test URL must use postgres or postgresql"
        );
        assert!(
            matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")),
            "destructive hosted tests require a loopback PostgreSQL URL"
        );
        assert!(
            url.query_pairs().all(|(key, _)| key != "options"),
            "PostgreSQL test URL must not supply connection options"
        );

        let serial = SERIAL_TESTS
            .get_or_init(|| Arc::new(Mutex::new(())))
            .clone()
            .lock_owned()
            .await;
        let schema = format!("mdbase_operation_dispatch_{}", Uuid::new_v4().simple());
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&base_url)
            .await
            .expect("disposable PostgreSQL test database connects");
        sqlx::query(AssertSqlSafe(format!(r#"CREATE SCHEMA "{schema}""#)))
            .execute(&admin)
            .await
            .expect("UUID-scoped test schema is created");
        admin.close().await;

        url.query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        Self {
            base_url,
            scoped_url: url.into(),
            schema,
            _serial: serial,
        }
    }

    pub fn url(&self) -> &str {
        &self.scoped_url
    }
}

impl Drop for DisposablePostgres {
    fn drop(&mut self) {
        let base_url = self.base_url.clone();
        let schema = self.schema.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("cleanup runtime is created");
            runtime.block_on(async move {
                let pool = PgPool::connect(&base_url)
                    .await
                    .expect("cleanup database connects");
                sqlx::query(AssertSqlSafe(format!(
                    r#"DROP SCHEMA IF EXISTS "{schema}" CASCADE"#
                )))
                .execute(&pool)
                .await
                .expect("UUID-scoped test schema is removed");
                pool.close().await;
            });
        })
        .join()
        .expect("PostgreSQL cleanup thread completes");
    }
}
