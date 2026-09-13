use super::*;
use uuid::Uuid;

// Exact beta94 INSERT from semantic_migration.rs; SQL-shape evidence, not an old binary.
const BETA94_INSERT: &str = r#"INSERT INTO hosted_provider_replicas
                 (id, collection_id, name, purpose, mode, allowed_types, contract_scope,
                  full_collection,
                  allowed_operations, operation_transport_protocol,
                  operation_transport_recovery_protocols,
                  file_capability, allowed_origin, proof_public_key, grant_id,
                  application_declaration_id, application_declaration_digest, token_hash,
                  token_expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18,
                       now() + ($19 * interval '1 second'))"#;

async fn old_insert(connection: &mut PgConnection, collection: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(BETA94_INSERT)
        .bind(Uuid::new_v4())
        .bind(collection)
        .bind("beta94 SQL shape")
        .bind("application")
        .bind("read_write")
        .bind(Vec::<String>::new())
        .bind(serde_json::json!([]))
        .bind(true)
        .bind(vec!["apply_collection_setup", "assess_collection_setup"])
        .bind(3_i32)
        .bind(vec![2_i32])
        .bind(None::<serde_json::Value>)
        .bind("null")
        .bind("fixture-key")
        .bind(Uuid::new_v4())
        .bind("dev.mdbase.fixture")
        .bind(format!("sha256:{}", "a".repeat(64)))
        .bind(vec![0_u8; 32])
        .bind(3600_i64)
        .execute(connection)
        .await
        .map(|_| ())
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn atomic_runner_blocks_beta94_insert_until_41() {
    let db = test_postgres::DisposablePostgres::from_projection_env().await;
    let pool = PgPool::connect(db.url()).await.unwrap();
    prefix(&pool, 1).await;
    let collection = Uuid::new_v4();
    sqlx::query("INSERT INTO hosted_provider_collections (id, template, spec_version, max_records, max_content_bytes, max_document_bytes, max_replicas, resource_revision, wrapped_data_key, resources_ciphertext) VALUES ($1,'mdbase','0.3.0',100,100000,10000,50,'fixture',''::bytea,''::bytea)").bind(collection).execute(&pool).await.unwrap();
    prefix(&pool, 38).await;
    let (task, mut entered, resume) = start(pool.clone());
    entered.recv().await.unwrap();
    let mut writer = pool.acquire().await.unwrap();
    sqlx::query("SET lock_timeout='200ms'")
        .execute(&mut *writer)
        .await
        .unwrap();
    let error = old_insert(&mut writer, collection).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    assert_eq!(version(&pool).await, 38);
    resume.send(false).unwrap();
    task.await.unwrap().unwrap();
    old_insert(&mut writer, collection).await.unwrap();
    assert_eq!(version(&pool).await, 41);
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn atomic_runner_cancel_and_backend_loss_release_session_locks() {
    for terminate in [false, true] {
        let db = test_postgres::DisposablePostgres::from_projection_env().await;
        let pool = PgPool::connect(db.url()).await.unwrap();
        prefix(&pool, 38).await;
        let (task, mut entered, resume) = start(pool.clone());
        let pid = entered.recv().await.unwrap();
        if terminate {
            assert!(
                sqlx::query_scalar::<_, bool>("SELECT pg_terminate_backend($1)")
                    .bind(pid)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            );
            resume.send(false).unwrap();
            assert!(task.await.unwrap().is_err());
        } else {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        let mut fresh = pool.acquire().await.unwrap();
        fresh.close_on_drop();
        sqlx::query("SET statement_timeout='3000ms'")
            .execute(&mut *fresh)
            .await
            .unwrap();
        sqlx::query("SELECT pg_advisory_lock(hashtextextended('mdbase-candidate-b-cutover-v1',0))")
            .execute(&mut *fresh)
            .await
            .unwrap();
        fresh.lock().await.unwrap();
        assert_eq!(version(&pool).await, 38);
        let columns: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hosted_provider_replicas' AND column_name IN ('application_semantic_version','application_setup_evidence')").fetch_one(&pool).await.unwrap();
        assert_eq!(columns, 0);
    }
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn atomic_runner_validates_retained_40_and_rejects_corrupt_prefixes() {
    for corruption in [
        None,
        Some("DELETE FROM _sqlx_migrations WHERE version=39"),
        Some("UPDATE _sqlx_migrations SET checksum='bad'::bytea WHERE version=39"),
        Some("UPDATE _sqlx_migrations SET checksum='bad'::bytea WHERE version=40"),
        Some("UPDATE _sqlx_migrations SET success=false WHERE version=40"),
        Some("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) SELECT 42, description, success, checksum, execution_time FROM _sqlx_migrations WHERE version=40"),
    ] {
        let db = test_postgres::DisposablePostgres::from_projection_env().await;
        let pool = PgPool::connect(db.url()).await.unwrap();
        prefix(&pool, 40).await;
        if let Some(sql) = corruption {
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&pool)
                .await
                .unwrap();
            assert!(super::super::run_hosted_migrations(&pool)
                .await
                .is_err());
            let has41: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version=41)",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(!has41);
        } else {
            let (task, mut entered, resume) = start(pool.clone());
            entered.recv().await.unwrap();
            resume.send(true).unwrap();
            assert!(task.await.unwrap().is_err());
            assert_eq!(version(&pool).await, 40);
            super::super::run_hosted_migrations(&pool)
                .await
                .unwrap();
            assert_eq!(version(&pool).await, 41);
        }
    }
}
