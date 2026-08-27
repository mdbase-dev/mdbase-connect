use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use mdbase_connect_hosted_provider::{
    LifecycleDiagnosticSection, HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use url::Url;
use uuid::Uuid;

mod support;
use support::FileLifecycleFixture;

const DATABASE_ENV: &str = "MDBASE_CONNECT_PROVIDER_DIAGNOSTICS_TEST_DATABASE_URL";
const APPROVAL_ENV: &str = "MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL";
const REQUIRED_APPROVAL: &str = "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires exact destructive-test approval and a disposable loopback PostgreSQL test database"]
async fn provider_lifecycle_aggregates_use_production_sql() {
    assert_eq!(
        std::env::var(APPROVAL_ENV).as_deref(),
        Ok(REQUIRED_APPROVAL)
    );
    let database_url = std::env::var(DATABASE_ENV).expect("provider diagnostics database URL");
    let mut url = Url::parse(&database_url).expect("valid provider diagnostics database URL");
    assert!(matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "::1")
    ));
    let database = url.path().trim_start_matches('/');
    assert!(database.contains("test"));
    assert!(!matches!(database, "postgres" | "template0" | "template1"));

    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect disposable PostgreSQL");
    let schema = format!("mdbase_provider_lifecycle_{}", Uuid::new_v4().simple());
    sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#))
        .execute(&admin)
        .await
        .expect("create isolated schema");
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));

    let observed = AssertUnwindSafe(async {
        let fixture = FileLifecycleFixture::new(url.as_str()).await;
        let replica_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM hosted_provider_replicas WHERE collection_id=$1 LIMIT 1",
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await?;
        let zero = match fixture.provider.hosted_diagnostics().await.lifecycle_work {
            LifecycleDiagnosticSection::Ok { value } => value,
            LifecycleDiagnosticSection::Unavailable => {
                return Err("zero lifecycle section unavailable".into());
            }
        };
        assert_eq!(zero.runtime_outbox.open, 0);
        assert_eq!(zero.runtime_outbox.impossible, 0);
        assert_eq!(zero.mutation_journal.unfinished, 0);
        assert_eq!(zero.mutation_journal.outcome_unknown, 0);
        assert_eq!(zero.stuck_deleting_collections, 0);
        sqlx::query(
            r#"INSERT INTO hosted_provider_runtime_outbox
              (collection_id,sequence,event_type,payload,occurred_at,processed_at,attempts,
               available_at,lease_token,leased_until,last_error)
              VALUES
              ($1,101,'fixture','{}',now(),NULL,0,now(),NULL,NULL,NULL),
              ($1,102,'fixture','{}',now()-interval '31 minutes',NULL,11,now(),$2,
                now()-interval '1 second','fixture outbox error /private/path'),
              ($1,103,'fixture','{}',now(),now(),1,now(),NULL,NULL,'retained private error'),
              ($1,104,'fixture','{}',now(),NULL,0,now(),$3,NULL,NULL)"#,
        )
        .bind(fixture.collection_id)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .execute(&fixture.pool)
        .await?;
        for (state, age, expired, terminal, applied) in [
            ("claimed", 0_i64, false, false, false),
            ("prepared", 180, true, false, false),
            ("applied", 180, false, false, true),
            ("outcome_unknown", 180, false, true, false),
        ] {
            sqlx::query(
                r#"INSERT INTO hosted_provider_mutation_journal
                  (replica_id,request_id,operation_kind,input_schema_version,input_digest,state,
                   process_epoch,lease_owner,lease_expires_at,fencing_generation,
                   evidence_ciphertext,evidence_kind,effect_applied,final_receipt_ciphertext,
                   receipt_digest,accepted_at,updated_at,completed_at)
                  VALUES ($1,$2,'create',1,$3,$4,$5,$6,
                    CASE WHEN $7 THEN now()-interval '1 second' ELSE now()+interval '1 hour' END,
                    1,CASE WHEN $8 THEN $3 ELSE NULL END,
                    CASE WHEN $8 THEN 'public_result' ELSE NULL END,
                    CASE WHEN $8 THEN true ELSE NULL END,
                    CASE WHEN $9 THEN $3 ELSE NULL END,CASE WHEN $9 THEN $3 ELSE NULL END,
                    now()-($10 * interval '1 second'),now()-($10 * interval '1 second'),
                    CASE WHEN $9 THEN now() ELSE NULL END)"#,
            )
            .bind(replica_id)
            .bind(Uuid::new_v4())
            .bind(vec![7_u8; 32])
            .bind(state)
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .bind(expired)
            .bind(applied)
            .bind(terminal)
            .bind(age)
            .execute(&fixture.pool)
            .await?;
        }
        sqlx::query(
            "UPDATE hosted_provider_collections SET state='deleting', updated_at=now()-interval '11 minutes' WHERE id=$1",
        )
        .bind(fixture.collection_id)
        .execute(&fixture.pool)
        .await?;
        let diagnostics = fixture.provider.hosted_diagnostics().await;
        let serialized = serde_json::to_string(&diagnostics.lifecycle_work)?;
        let value = match diagnostics.lifecycle_work {
            LifecycleDiagnosticSection::Ok { value } => value,
            LifecycleDiagnosticSection::Unavailable => {
                return Err("lifecycle section unavailable".into());
            }
        };
        let private_ids = [replica_id.to_string(), fixture.collection_id.to_string()];
        drop(fixture);
        Ok::<_, Box<dyn std::error::Error>>((
            diagnostics.schema_version,
            value,
            serialized,
            private_ids,
        ))
    })
    .catch_unwind()
    .await;

    sqlx::query(&format!(r#"DROP SCHEMA IF EXISTS "{schema}" CASCADE"#))
        .execute(&admin)
        .await
        .expect("unconditionally drop isolated schema");
    admin.close().await;

    let observed = match observed {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    let (schema_version, value, serialized, private_ids) =
        observed.expect("collect lifecycle diagnostics");
    assert_eq!(schema_version, HOSTED_DIAGNOSTICS_SCHEMA_VERSION);
    assert_eq!(value.runtime_outbox.open, 3);
    assert_eq!(value.runtime_outbox.stale, 1);
    assert_eq!(value.runtime_outbox.poison, 1);
    assert_eq!(value.runtime_outbox.expired_leases, 1);
    assert_eq!(value.runtime_outbox.impossible, 2);
    assert!(value.runtime_outbox.oldest_open_seconds >= Some(1_859));
    assert_eq!(value.mutation_journal.unfinished, 3);
    assert_eq!(value.mutation_journal.stale, 2);
    assert_eq!(value.mutation_journal.outcome_unknown, 1);
    assert_eq!(value.mutation_journal.expired_leases, 1);
    assert_eq!(value.stuck_deleting_collections, 1);
    for private in private_ids.iter().map(String::as_str).chain([
        "fixture outbox error",
        "/private/path",
        "customer-id",
    ]) {
        assert!(!serialized.contains(private));
    }
    assert_eq!(
        serde_json::to_value(LifecycleDiagnosticSection::Unavailable).unwrap(),
        json!({"state":"unavailable"})
    );
}
