use std::sync::{Arc, OnceLock};

use sqlx::{postgres::PgPoolOptions, AssertSqlSafe, PgPool};
use tokio::sync::{Mutex, OwnedMutexGuard};
use url::Url;
use uuid::Uuid;

const APPROVAL_ENV: &str = "MDBASE_APPROVE_DESTRUCTIVE_HOSTED_TESTS";
const EXACT_APPROVAL: &str = "operation_dispatch_uuid_schema_v1";

static SERIAL_TESTS: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

fn destructive_test_url(base_url: &str) -> Result<Url, &'static str> {
    let url = Url::parse(base_url).map_err(|_| "PostgreSQL test URL is valid")?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err("PostgreSQL test URL must use postgres or postgresql");
    }
    if !matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    ) {
        return Err("destructive hosted tests require a loopback PostgreSQL URL");
    }
    // SQLx accepts connection overrides including host, hostaddr, port, dbname,
    // credentials, and options from URL query pairs. Reject every caller-supplied
    // query rather than attempting to maintain an incomplete denylist. This helper
    // appends its sole search_path option only after the base connection succeeds.
    if url.query().is_some() || url.fragment().is_some() {
        return Err("PostgreSQL test URL must not supply query options or a fragment");
    }
    Ok(url)
}

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
        let mut url = destructive_test_url(&base_url).unwrap_or_else(|message| panic!("{message}"));

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

#[cfg(test)]
mod tests {
    use super::destructive_test_url;

    #[test]
    fn destructive_url_rejects_every_sqlx_query_override() {
        for query in [
            "host=production.example",
            "hostaddr=203.0.113.1",
            "port=6543",
            "dbname=production",
            "user=other",
            "password=other",
            "options=-csearch_path%3Dpublic",
            "sslmode=require",
        ] {
            assert!(
                destructive_test_url(&format!("postgres://user:pass@127.0.0.1/test?{query}"))
                    .is_err(),
                "accepted SQLx connection override {query}"
            );
        }
    }

    #[test]
    fn destructive_url_accepts_only_literal_loopback_without_overrides() {
        for url in [
            "postgres://user:pass@localhost/test",
            "postgresql://user:pass@127.0.0.1/test",
            "postgres://user:pass@[::1]/test",
        ] {
            assert!(destructive_test_url(url).is_ok(), "rejected {url}");
        }
        for url in [
            "postgres://user:pass@production.example/test",
            "postgres://user:pass@127.0.0.1/test#fragment",
            "file://127.0.0.1/test",
        ] {
            assert!(destructive_test_url(url).is_err(), "accepted {url}");
        }
    }
}
