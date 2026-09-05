//! Disposable historical schema, not a downgrade or qualification of current migrations.

#[tokio::test]
#[ignore = "requires a clean MDBASE_PROJECTION_DATABASE_URL disposable PostgreSQL database"]
async fn historical_rollback_migration_38_fixture() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
    let ledger: Option<String> = sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations')::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        ledger.is_none(),
        "historical fixture requires a fresh database"
    );

    // SQLx applies the actual checked-in SQL and records its original checksums.
    // Never create this endpoint by deleting ledger rows from a current schema.
    let mut historical = sqlx::migrate!("./migrations");
    historical
        .migrations
        .to_mut()
        .retain(|migration| migration.version <= 38);
    historical.run(&pool).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(versions, (1_i64..=38).collect::<Vec<_>>());
    for migration in historical.iter() {
        let checksum: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                .bind(migration.version)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(checksum.as_slice(), migration.checksum.as_ref());
    }
    pool.close().await;
    println!("historical rollback fixture: exact checked-in successful migration prefix 1-38");
}
