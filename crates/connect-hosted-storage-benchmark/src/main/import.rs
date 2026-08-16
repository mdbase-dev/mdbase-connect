const COLLECTION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0001);
const GENERATION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0002);
const REBUILD_GENERATION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0003);
const REBUILD_LEASE_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0004);
const DATA_KEY: [u8; 32] = [0x5a; 32];
const PATH_KEY: [u8; 32] = [0xa5; 32];

struct ImportRow {
    id: Uuid,
    sequence: i64,
    path: String,
    path_token: Vec<u8>,
    revision: String,
    content_bytes: i64,
    document: String,
    ciphertext: Vec<u8>,
    projection: Option<BenchmarkProjection>,
    semantic: Option<Value>,
    projection_digest: Option<String>,
    mtime: chrono::DateTime<chrono::Utc>,
}

async fn apply_schema(
    database_url: &str,
    candidate: Candidate,
    directory: &Path,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let ddl = match candidate {
        Candidate::BGin => {
            let base = std::fs::read_to_string(directory.join("candidate-b-no-gin.sql"))?
                .replace("candidate_b_no_gin", "candidate_b_gin");
            format!("{base}\nCREATE INDEX record_projections_projection_gin ON candidate_b_gin.record_projections USING gin (semantic_projection jsonb_path_ops);\n")
        }
        Candidate::CGin => {
            let base = std::fs::read_to_string(directory.join("candidate-c-no-gin.sql"))?
                .replace("candidate_c_no_gin", "candidate_c_gin");
            format!("{base}\nCREATE INDEX record_projections_projection_gin ON candidate_c_gin.record_projections USING gin (semantic_projection jsonb_path_ops);\n")
        }
        _ => std::fs::read_to_string(directory.join(candidate.file()))?,
    };
    sqlx::raw_sql(AssertSqlSafe(ddl)).execute(&pool).await?;
    println!(
        "{}",
        json!({"candidate": format!("{candidate:?}"), "schema": candidate.schema(), "applied": true})
    );
    Ok(())
}

async fn import_fixture(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(&pool)
        .await?;
    let started = Instant::now();
    let resource_bytes = std::fs::read(fixture_dir.join("resources.ndjson"))?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    initialize_candidate(
        &pool,
        candidate,
        &resource_bytes,
        catalog.resource_revision(),
    )
    .await?;
    let mut rows = Vec::with_capacity(128);
    let mut batch_ciphertext_bytes = 0_usize;
    let mut records = 0_i64;
    let mut content_bytes = 0_i64;
    let mut projection_elapsed = Duration::ZERO;
    let mut encryption_elapsed = Duration::ZERO;
    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let id = Uuid::parse_str(&record.record_id)
            .map_err(|error| Error::Invalid(format!("invalid record UUID: {error}")))?;
        let revision = format!("sha256:{:x}", Sha256::digest(record.document.as_bytes()));
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id),
            path: record.path.clone(),
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime.clone()),
            document: record.document.clone(),
        };
        let projection_started = Instant::now();
        let projection = candidate
            .projected()
            .then(|| catalog.benchmark_project_record(&canonical))
            .transpose()?;
        projection_elapsed += projection_started.elapsed();
        let semantic = projection.as_ref().map(semantic_projection);
        let projection_digest = projection
            .as_ref()
            .zip(semantic.as_ref())
            .map(|(projection, semantic)| {
                authority_projection_digest(
                    id,
                    &revision,
                    catalog.resource_revision(),
                    GENERATION_ID,
                    projection,
                    semantic,
                )
            })
            .transpose()?;
        let ciphertext = if candidate.encrypted() {
            let encryption_started = Instant::now();
            let envelope = serde_json::to_vec(&json!({
                "path": record.path,
                "file_mtime": record.file_mtime,
                "document": record.document
            }))?;
            let encrypted = encrypt_exact(id, &revision, &envelope)?;
            encryption_elapsed += encryption_started.elapsed();
            encrypted
        } else {
            Vec::new()
        };
        let bytes = record.document.len() as i64;
        records += 1;
        content_bytes += bytes;
        let stored_bytes = if candidate.encrypted() {
            ciphertext.len()
        } else {
            record.document.len()
        };
        if !rows.is_empty()
            && (rows.len() == 128 || batch_ciphertext_bytes + stored_bytes > 4_194_304)
        {
            insert_rows(&pool, candidate, &rows).await?;
            rows.clear();
            batch_ciphertext_bytes = 0;
        }
        rows.push(ImportRow {
            id,
            sequence: records,
            path_token: path_token(&record.path),
            path: record.path,
            revision,
            content_bytes: bytes,
            document: record.document,
            ciphertext,
            projection,
            semantic,
            projection_digest,
            mtime: chrono::DateTime::parse_from_rfc3339(&record.file_mtime)
                .map_err(|error| Error::Invalid(format!("invalid fixture mtime: {error}")))?
                .with_timezone(&chrono::Utc),
        });
        batch_ciphertext_bytes += stored_bytes;
    }
    if !rows.is_empty() {
        insert_rows(&pool, candidate, &rows).await?;
    }
    finish_import(&pool, candidate, records, content_bytes).await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(&pool)
    .await?;
    println!(
        "{}",
        json!({
            "candidate": format!("{candidate:?}"), "records": records,
            "canonical_bytes": content_bytes, "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
            "projection_elapsed_ms":projection_elapsed.as_secs_f64()*1000.0,
            "encryption_elapsed_ms":encryption_elapsed.as_secs_f64()*1000.0,
            "wal_bytes": wal
        })
    );
    Ok(())
}

async fn initialize_candidate(
    pool: &PgPool,
    candidate: Candidate,
    resources: &[u8],
    revision: &str,
) -> Result<(), Error> {
    let schema = candidate.schema();
    let mut tx = pool.begin().await?;
    sqlx::query("SET CONSTRAINTS ALL DEFERRED")
        .execute(&mut *tx)
        .await?;
    if candidate == Candidate::A {
        let encrypted = encrypt_exact(COLLECTION_ID, revision, resources)?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,resources_ciphertext,wrapped_data_key) VALUES ($1,$2,$3,$4)")))
            .bind(COLLECTION_ID).bind(revision).bind(encrypted).bind(vec![0x7b_u8; 48]).execute(&mut *tx).await?;
    } else if candidate.encrypted() {
        let encrypted = encrypt_exact(COLLECTION_ID, revision, resources)?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,active_projection_format_version,active_generation_id,resources_ciphertext,wrapped_data_key) VALUES ($1,$2,1,$3,$4,$5)")))
            .bind(COLLECTION_ID).bind(revision).bind(GENERATION_ID).bind(encrypted).bind(vec![0x7b_u8; 48]).execute(&mut *tx).await?;
        insert_generation(&mut tx, schema, revision).await?;
    } else {
        let resources_json = resources
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(serde_json::from_slice::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,active_projection_format_version,active_generation_id,resources_document) VALUES ($1,$2,1,$3,$4)")))
            .bind(COLLECTION_ID).bind(revision).bind(GENERATION_ID).bind(sqlx::types::Json(resources_json)).execute(&mut *tx).await?;
        insert_generation(&mut tx, schema, revision).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn insert_generation(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    schema: &str,
    revision: &str,
) -> Result<(), Error> {
    sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.projection_generations (collection_id,generation_id,target_catalog_revision,projection_format_version,status,source_head) VALUES ($1,$2,$3,1,'building',0)")))
        .bind(COLLECTION_ID).bind(GENERATION_ID).bind(revision).execute(&mut **tx).await?;
    Ok(())
}

async fn insert_rows(pool: &PgPool, candidate: Candidate, rows: &[ImportRow]) -> Result<(), Error> {
    let schema = candidate.schema();
    let mut tx = pool.begin().await?;
    if candidate.encrypted() {
        let mut records = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.records (collection_id,record_id,path_token,record_revision,content_bytes,exact_ciphertext,sequence) "));
        records.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.path_token)
                .push_bind(&row.revision)
                .push_bind(row.content_bytes)
                .push_bind(&row.ciphertext)
                .push_bind(row.sequence);
        });
        records.build().execute(&mut *tx).await?;
        let mut versions = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,exact_ciphertext) "));
        versions.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(row.sequence)
                .push_bind(&row.revision)
                .push_bind(&row.ciphertext);
        });
        versions.build().execute(&mut *tx).await?;
        let mut changes = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,after_ciphertext,record_revision) "));
        changes.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.sequence)
                .push_bind(row.id)
                .push_bind(&row.ciphertext)
                .push_bind(&row.revision);
        });
        changes.build().execute(&mut *tx).await?;
    } else {
        let mut records = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.records (collection_id,record_id,path,record_revision,content_bytes,exact_markdown,file_mtime,sequence) "));
        records.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.path)
                .push_bind(&row.revision)
                .push_bind(row.content_bytes)
                .push_bind(&row.document)
                .push_bind(row.mtime)
                .push_bind(row.sequence);
        });
        records.build().execute(&mut *tx).await?;
        let mut versions = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,path,exact_markdown,projection) "));
        versions.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(row.sequence)
                .push_bind(&row.revision)
                .push_bind(&row.path)
                .push_bind(&row.document)
                .push_bind(sqlx::types::Json(row.semantic.as_ref().unwrap()));
        });
        versions.build().execute(&mut *tx).await?;
        let mut changes = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,after_record,record_revision) "));
        changes.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.sequence)
                .push_bind(row.id)
                .push_bind(sqlx::types::Json(
                    json!({"path":row.path,"document":row.document,"projection":row.semantic}),
                ))
                .push_bind(&row.revision);
        });
        changes.build().execute(&mut *tx).await?;
    }
    if candidate.projected() {
        let mut projections = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_projections (collection_id,record_id,record_revision,catalog_revision,projection_format_version,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) "));
        projections.push_values(rows, |mut b, row| {
            let projection = row.projection.as_ref().unwrap();
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.revision)
                .push_bind(
                    "sha256:13d551f5d6fe7416779b7e64fe70d662e0a6c1da0332ae2c3be715960bd240d3",
                )
                .push_bind(1_i32)
                .push_bind(GENERATION_ID)
                .push_bind(&row.path)
                .push_bind(&projection.types)
                .push_bind(row.content_bytes)
                .push_bind(row.mtime)
                .push_bind(sqlx::types::Json(row.semantic.as_ref().unwrap()))
                .push_bind(row.projection_digest.as_ref().unwrap());
        });
        projections.build().execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn finish_import(
    pool: &PgPool,
    candidate: Candidate,
    records: i64,
    bytes: i64,
) -> Result<(), Error> {
    let schema = candidate.schema();
    sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.collections SET head=$2,record_count=$2,content_bytes=$3 WHERE collection_id=$1")))
        .bind(COLLECTION_ID).bind(records).bind(bytes).execute(pool).await?;
    if candidate.projected() {
        let completed = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.projection_generations g SET source_head=$3,status='complete',completed_at=clock_timestamp(),checkpoint_record_id=(SELECT record_id FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id DESC LIMIT 1) WHERE g.collection_id=$1 AND g.generation_id=$2 AND g.status='building' AND NOT EXISTS (SELECT 1 FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 AND (p.record_id IS NULL OR p.record_revision<>r.record_revision OR p.catalog_revision<>c.active_catalog_revision OR p.projection_format_version<>c.active_projection_format_version OR p.generation_id<>c.active_generation_id))")))
            .bind(COLLECTION_ID).bind(GENERATION_ID).bind(records).execute(pool).await?;
        if completed.rows_affected() != 1 {
            return Err(Error::Invalid(
                "initial projection completion proof failed".to_string(),
            ));
        }
    }
    Ok(())
}

fn semantic_projection(projection: &BenchmarkProjection) -> Value {
    json!({
        "persisted_frontmatter": projection.persisted_frontmatter,
        "effective_frontmatter": projection.effective_frontmatter,
        "relationships": projection.relationships,
        "diagnostics": projection.diagnostics
    })
}

fn authority_projection_digest(
    id: Uuid,
    revision: &str,
    catalog_revision: &str,
    generation_id: Uuid,
    projection: &BenchmarkProjection,
    semantic: &Value,
) -> Result<String, Error> {
    let value = json!([
        "mdbase/hosted-benchmark-projection/v1",
        COLLECTION_ID,
        id,
        revision,
        catalog_revision,
        1,
        generation_id,
        projection.path,
        projection.types,
        projection.file.size,
        projection.file.mtime,
        semantic
    ]);
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_jcs::to_vec(&value)?)
    ))
}

fn encrypt_exact(id: Uuid, revision: &str, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    let cipher = Aes256Gcm::new_from_slice(&DATA_KEY)
        .map_err(|_| Error::Invalid("invalid benchmark key".to_string()))?;
    let nonce_digest = Sha256::digest([id.as_bytes(), revision.as_bytes(), plaintext].concat());
    let nonce = Nonce::try_from(&nonce_digest[..12])
        .map_err(|_| Error::Invalid("invalid benchmark nonce".to_string()))?;
    let mut output = nonce.to_vec();
    output.extend(
        cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &exact_aad(id, revision),
                },
            )
            .map_err(|_| Error::Invalid("benchmark encryption failed".to_string()))?,
    );
    Ok(output)
}

fn path_token(path: &str) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&PATH_KEY).expect("fixed HMAC key");
    mac.update(path.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

#[derive(Serialize)]
struct RebuildRow {
    id: Uuid,
    revision: String,
    path: String,
    types: Vec<String>,
    file_size: i64,
    file_mtime: chrono::DateTime<chrono::Utc>,
    semantic: Value,
    projection_digest: String,
    #[serde(skip)]
    source_bytes: usize,
}

async fn exercise_candidate(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    operation: ExerciseOperation,
    samples: usize,
) -> Result<(), Error> {
    if samples == 0 {
        return Err(Error::Invalid(
            "exercise samples must be positive".to_string(),
        ));
    }
    let pool = PgPool::connect(database_url).await?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    if operation == ExerciseOperation::CasLoss {
        return write_one_record(
            &pool,
            candidate,
            &catalog,
            ExerciseOperation::BodyWrite,
            0,
            Some(WriteRace::RecordRevision),
        )
        .await;
    }
    if operation == ExerciseOperation::Supersession {
        return write_one_record(
            &pool,
            candidate,
            &catalog,
            ExerciseOperation::BodyWrite,
            0,
            Some(WriteRace::CatalogSupersession),
        )
        .await;
    }
    match operation {
        ExerciseOperation::PointRead => {
            for repetition in 0..samples {
                let started = Instant::now();
                let (id, revision, exact_bytes, plaintext_bytes) =
                    load_exact_point(&pool, candidate).await?;
                println!(
                    "{}",
                    json!({"candidate":format!("{candidate:?}"),"operation":"point.exact_read","repetition":repetition,"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"record_id":id,"record_revision":revision,"rows_selected":1,"rows_scanned":1,"documents_decrypted":usize::from(candidate.encrypted()),"ciphertext_bytes":exact_bytes,"plaintext_bytes":plaintext_bytes,"notes":{"exact_envelope_parsed":true,"revision_verified":true}})
                );
            }
        }
        ExerciseOperation::BodyWrite
        | ExerciseOperation::FrontmatterWrite
        | ExerciseOperation::PathWrite => {
            for repetition in 0..samples {
                write_one_record(&pool, candidate, &catalog, operation, repetition, None).await?;
            }
        }
        ExerciseOperation::Recovery => {
            let schema = candidate.schema();
            let checkpoint_expr = if candidate.projected() {
                format!("(SELECT checkpoint_record_id FROM {schema}.projection_generations WHERE collection_id=c.collection_id AND generation_id=c.active_generation_id)")
            } else {
                "NULL::uuid".to_string()
            };
            let baseline = sqlx::query(AssertSqlSafe(format!(
                "SELECT c.head,r.record_revision,{checkpoint_expr} AS checkpoint FROM {schema}.collections c JOIN LATERAL (SELECT record_revision FROM {schema}.records WHERE collection_id=c.collection_id ORDER BY record_id LIMIT 1) r ON true WHERE c.collection_id=$1"
            )))
            .bind(COLLECTION_ID).fetch_one(&pool).await?;
            let baseline_head: i64 = baseline.get("head");
            let baseline_revision: String = baseline.get("record_revision");
            let baseline_checkpoint: Option<Uuid> = baseline.get("checkpoint");
            let stages = if candidate.projected() {
                vec![
                    "before-exact",
                    "after-exact",
                    "after-projection",
                    "after-checkpoint",
                ]
            } else {
                vec!["before-exact", "after-exact"]
            };
            for stage in stages {
                let mut tx = pool.begin().await?;
                sqlx::query(AssertSqlSafe(format!(
                    "UPDATE {schema}.collections SET head=head+1 WHERE collection_id=$1"
                )))
                .bind(COLLECTION_ID)
                .execute(&mut *tx)
                .await?;
                if stage != "before-exact" {
                    sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET record_revision='sha256:injected-uncommitted' WHERE collection_id=$1 AND record_id=(SELECT record_id FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1)")))
                        .bind(COLLECTION_ID).execute(&mut *tx).await?;
                }
                if candidate.projected()
                    && (stage == "after-projection" || stage == "after-checkpoint")
                {
                    sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET record_revision='sha256:injected-uncommitted' WHERE collection_id=$1 AND record_id=(SELECT record_id FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1)")))
                        .bind(COLLECTION_ID).execute(&mut *tx).await?;
                }
                if candidate.projected() && stage == "after-checkpoint" {
                    sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.projection_generations SET checkpoint_record_id=NULL WHERE collection_id=$1 AND generation_id=(SELECT active_generation_id FROM {schema}.collections WHERE collection_id=$1)")))
                        .bind(COLLECTION_ID).execute(&mut *tx).await?;
                }
                tx.rollback().await?;
                let after = sqlx::query(AssertSqlSafe(format!("SELECT c.head,r.record_revision,{checkpoint_expr} AS checkpoint FROM {schema}.collections c JOIN LATERAL (SELECT record_revision FROM {schema}.records WHERE collection_id=c.collection_id ORDER BY record_id LIMIT 1) r ON true WHERE c.collection_id=$1")))
                    .bind(COLLECTION_ID).fetch_one(&pool).await?;
                if after.get::<i64, _>("head") != baseline_head
                    || after.get::<String, _>("record_revision") != baseline_revision
                    || after.get::<Option<Uuid>, _>("checkpoint") != baseline_checkpoint
                {
                    return Err(Error::Invalid(format!(
                        "recovery stage {stage} left ambiguous state"
                    )));
                }
                println!(
                    "{}",
                    json!({"candidate":format!("{candidate:?}"),"operation":"write.recovery","outcome":"success","failure_stage":stage,"recovery_state":"rolled-back-unambiguously","transaction_released":true,"final_head":baseline_head,"final_revision":baseline_revision,"checkpoint_record_id":baseline_checkpoint})
                );
            }
        }
        ExerciseOperation::Authorization => {
            let schema = candidate.schema();
            let mut tx = pool.begin().await?;
            let active = load_active_catalog(&mut tx, candidate).await?;
            let row = if candidate.encrypted() {
                sqlx::query(AssertSqlSafe(format!("SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1 FOR UPDATE"))).bind(COLLECTION_ID).fetch_one(&mut *tx).await?
            } else {
                sqlx::query(AssertSqlSafe(format!("SELECT record_id,record_revision,path,exact_markdown,file_mtime FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1 FOR UPDATE"))).bind(COLLECTION_ID).fetch_one(&mut *tx).await?
            };
            let id: Uuid = row.get("record_id");
            let revision: String = row.get("record_revision");
            let envelope = if candidate.encrypted() {
                let ciphertext: Vec<u8> = row.get("exact_ciphertext");
                serde_json::from_slice::<ExactEnvelope>(&decrypt_exact(
                    id,
                    &revision,
                    &ciphertext,
                )?)?
            } else {
                ExactEnvelope {
                    path: row.get("path"),
                    document: row.get("exact_markdown"),
                    file_mtime: row
                        .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                }
            };
            let canonical = CanonicalRecordInput {
                stable_id: Some(id.to_string()),
                path: envelope.path,
                file_size: envelope.document.len() as u64,
                file_mtime: Some(envelope.file_mtime),
                document: envelope.document,
            };
            let classification = active.catalog.benchmark_project_record(&canonical)?;
            let allowed_type = classification.types.first().cloned().ok_or_else(|| {
                Error::Invalid("authorization fixture has no canonical type".to_string())
            })?;
            sqlx::query("CREATE TEMP TABLE benchmark_authorization_grants (scope_id uuid PRIMARY KEY,epoch bigint NOT NULL,allowed_types text[] NOT NULL,can_read boolean NOT NULL,can_mutate boolean NOT NULL) ON COMMIT DROP").execute(&mut *tx).await?;
            let scope_id = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0100);
            sqlx::query("INSERT INTO benchmark_authorization_grants VALUES ($1,7,$2,true,true)")
                .bind(scope_id)
                .bind(vec![allowed_type.clone()])
                .execute(&mut *tx)
                .await?;
            let current_projection_authorized = if candidate.projected() {
                let projection_row = sqlx::query(AssertSqlSafe(format!("SELECT p.record_revision,p.catalog_revision,p.generation_id,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest,(p.record_revision=r.record_revision AND p.catalog_revision=c.active_catalog_revision AND p.projection_format_version=c.active_projection_format_version AND p.generation_id=c.active_generation_id AND g.status IN ('building','complete')) AS current FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) JOIN {schema}.record_projections p USING (collection_id,record_id) JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND r.record_id=$2"))).bind(COLLECTION_ID).bind(id).fetch_one(&mut *tx).await?;
                let semantic: sqlx::types::Json<Value> = projection_row.get("semantic_projection");
                let projected = projection_from_row(&projection_row, &semantic.0)?;
                let digest = authority_projection_digest(
                    id,
                    &revision,
                    &active.revision,
                    active.generation_id.unwrap(),
                    &projected,
                    &semantic.0,
                )?;
                projection_row.get::<bool, _>("current")
                    && projection_row.get::<String, _>("projection_digest") == digest
                    && projected.types.contains(&allowed_type)
            } else {
                true
            };
            let scoped_read_allowed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$1 AND epoch=7 AND can_read AND allowed_types && $2)").bind(scope_id).bind(&classification.types).fetch_one(&mut *tx).await?;
            let scoped_mutation_rows = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET updated_at=updated_at WHERE collection_id=$1 AND record_id=$2 AND EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$3 AND epoch=7 AND can_mutate AND allowed_types && $4)"))).bind(COLLECTION_ID).bind(id).bind(scope_id).bind(&classification.types).execute(&mut *tx).await?.rows_affected();
            sqlx::query("UPDATE benchmark_authorization_grants SET epoch=8,can_read=false,can_mutate=false WHERE scope_id=$1 AND epoch=7").bind(scope_id).execute(&mut *tx).await?;
            let identity_revalidated_for_revoke: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT count(*) FROM {schema}.records WHERE collection_id=$1 AND record_id=$2"
            )))
            .bind(COLLECTION_ID)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            let revoked_read_allowed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$1 AND epoch=7 AND can_read AND allowed_types && $2)").bind(scope_id).bind(&classification.types).fetch_one(&mut *tx).await?;
            let revoked_read_denied = identity_revalidated_for_revoke == 1 && !revoked_read_allowed;
            let revoked_mutation_rows = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET updated_at=updated_at WHERE collection_id=$1 AND record_id=$2 AND EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$3 AND epoch=7 AND can_mutate AND allowed_types && $4)"))).bind(COLLECTION_ID).bind(id).bind(scope_id).bind(&classification.types).execute(&mut *tx).await?.rows_affected();
            let (
                stale_fallback_checked,
                stale_narrowing_checked,
                stale_widening_checked,
                absent_fallback_checked,
            ) = if candidate.projected() {
                sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET catalog_revision='sha256:stale',types=ARRAY[]::text[],projection_digest='corrupt' WHERE collection_id=$1 AND record_id=$2"))).bind(COLLECTION_ID).bind(id).execute(&mut *tx).await?;
                let fallback = active.catalog.benchmark_project_record(&canonical)?;
                let fallback_scope = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0101);
                let widening_scope = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0102);
                sqlx::query("INSERT INTO benchmark_authorization_grants VALUES ($1,9,$2,true,false),($3,9,ARRAY['benchmark-admin']::text[],true,false)").bind(fallback_scope).bind(vec![allowed_type.clone()]).bind(widening_scope).execute(&mut *tx).await?;
                let narrowing: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$1 AND epoch=9 AND can_read AND allowed_types && $2)").bind(fallback_scope).bind(&fallback.types).fetch_one(&mut *tx).await?;
                sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET types=ARRAY['benchmark-admin']::text[] WHERE collection_id=$1 AND record_id=$2"))).bind(COLLECTION_ID).bind(id).execute(&mut *tx).await?;
                let widening_allowed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$1 AND epoch=9 AND can_read AND allowed_types && $2)").bind(widening_scope).bind(&fallback.types).fetch_one(&mut *tx).await?;
                let widening = !widening_allowed;
                sqlx::query(AssertSqlSafe(format!("DELETE FROM {schema}.record_projections WHERE collection_id=$1 AND record_id=$2"))).bind(COLLECTION_ID).bind(id).execute(&mut *tx).await?;
                let absent_types = active.catalog.benchmark_project_record(&canonical)?.types;
                let absent: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM benchmark_authorization_grants WHERE scope_id=$1 AND epoch=9 AND can_read AND allowed_types && $2)").bind(fallback_scope).bind(&absent_types).fetch_one(&mut *tx).await?;
                (
                    fallback.types == classification.types,
                    narrowing,
                    widening,
                    absent,
                )
            } else {
                (true, true, true, true)
            };
            let corrupt_exact_fails_closed = if candidate.encrypted() {
                decrypt_exact(id, &revision, &[0_u8; 16]).is_err()
            } else {
                active
                    .catalog
                    .benchmark_project_record(&CanonicalRecordInput {
                        stable_id: Some(id.to_string()),
                        path: String::new(),
                        file_size: 0,
                        file_mtime: None,
                        document: "---\ntype: [\n---\n".to_string(),
                    })
                    .map_or(true, |projection| projection.types.is_empty())
            };
            tx.rollback().await?;
            if !scoped_read_allowed
                || scoped_mutation_rows != 1
                || !revoked_read_denied
                || revoked_mutation_rows != 0
                || !current_projection_authorized
                || !stale_fallback_checked
                || !stale_narrowing_checked
                || !stale_widening_checked
                || !absent_fallback_checked
                || !corrupt_exact_fails_closed
            {
                return Err(Error::Invalid(
                    "authorization state-machine assertion failed".to_string(),
                ));
            }
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"authorization.stale_projection","outcome":"success","authorization_classification":"current-projection-or-canonical-fallback-fail-closed","identity_first_lookup":true,"scoped_read_allowed":scoped_read_allowed,"scoped_mutation_rows":scoped_mutation_rows,"revoked_read_denied":revoked_read_denied,"revoked_mutation_rows":revoked_mutation_rows,"stale_projection_canonical_fallback":stale_fallback_checked,"corrupt_exact_fail_closed":corrupt_exact_fails_closed,"transaction_released":true,"notes":{"current_projection_authorized":current_projection_authorized,"identity_first_lookup":true,"scoped_read_allowed":scoped_read_allowed,"scoped_mutation_rows":scoped_mutation_rows,"revoked_read_denied":revoked_read_denied,"revoked_mutation_rows":revoked_mutation_rows,"stale_projection_canonical_fallback":stale_fallback_checked,"stale_narrowing_checked":stale_narrowing_checked,"stale_widening_checked":stale_widening_checked,"absent_projection_canonical_fallback":absent_fallback_checked,"corrupt_exact_fail_closed":corrupt_exact_fails_closed}})
            );
        }
        ExerciseOperation::CasLoss => {
            let schema = candidate.schema();
            let before_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT head FROM {schema}.collections WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            let prepared = sqlx::query(AssertSqlSafe(format!("SELECT record_id,record_revision FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"))).bind(COLLECTION_ID).fetch_one(&pool).await?;
            let id: Uuid = prepared.get("record_id");
            let old_revision: String = prepared.get("record_revision");
            let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
            let run_racer = |winner: &'static str,
                             racer_pool: PgPool,
                             racer_barrier: std::sync::Arc<tokio::sync::Barrier>,
                             expected: String| {
                let sql = format!("UPDATE {schema}.records SET record_revision=$3 WHERE collection_id=$1 AND record_id=$2 AND record_revision=$4");
                tokio::spawn(async move {
                    racer_barrier.wait().await;
                    sqlx::query(AssertSqlSafe(sql))
                        .bind(COLLECTION_ID)
                        .bind(id)
                        .bind(winner)
                        .bind(expected)
                        .execute(&racer_pool)
                        .await
                        .map(|result| result.rows_affected())
                })
            };
            let prepared_write = run_racer(
                "sha256:prepared-race-winner",
                pool.clone(),
                barrier.clone(),
                old_revision.clone(),
            );
            let concurrent_write = run_racer(
                "sha256:concurrent-race-winner",
                pool.clone(),
                barrier.clone(),
                old_revision.clone(),
            );
            barrier.wait().await;
            let prepared_rows = prepared_write
                .await
                .map_err(|error| Error::Invalid(format!("CAS task failed: {error}")))??;
            let concurrent_rows = concurrent_write
                .await
                .map_err(|error| Error::Invalid(format!("CAS task failed: {error}")))??;
            let rows = prepared_rows + concurrent_rows;
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET record_revision=$3 WHERE collection_id=$1 AND record_id=$2 AND record_revision IN ('sha256:prepared-race-winner','sha256:concurrent-race-winner')"))).bind(COLLECTION_ID).bind(id).bind(&old_revision).execute(&pool).await?;
            let after_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT head FROM {schema}.collections WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            if rows != 1 || before_head != after_head {
                return Err(Error::Invalid(
                    "record_cas_loss_was_not_fail_closed".to_string(),
                ));
            }
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"write.cas_loss","outcome":"success","failure_stage":"record-cas","recovery_state":"one-winner-one-rejected-restored","rows_selected":rows,"final_head":after_head,"transaction_released":true,"notes":{"prepared_rows":prepared_rows,"concurrent_rows":concurrent_rows,"single_winner":true,"head_unchanged":true}})
            );
        }
        ExerciseOperation::Supersession => {
            let schema = candidate.schema();
            let prepared = sqlx::query(AssertSqlSafe(format!("SELECT active_catalog_revision,head FROM {schema}.collections WHERE collection_id=$1"))).bind(COLLECTION_ID).fetch_one(&pool).await?;
            let prepared_revision: String = prepared.get("active_catalog_revision");
            let before_head: i64 = prepared.get("head");
            let superseded_revision = "sha256:benchmark-superseded";
            let concurrent_pool = pool.clone();
            let transition_sql = format!(
                "UPDATE {schema}.collections SET active_catalog_revision=$2 WHERE collection_id=$1"
            );
            let concurrent_transition = tokio::spawn(async move {
                sqlx::query(AssertSqlSafe(transition_sql))
                    .bind(COLLECTION_ID)
                    .bind(superseded_revision)
                    .execute(&concurrent_pool)
                    .await
            });
            let transition_rows = concurrent_transition
                .await
                .map_err(|error| {
                    Error::Invalid(format!("catalog transition task failed: {error}"))
                })??
                .rows_affected();
            let mut validation = pool.begin().await?;
            let current: String = sqlx::query_scalar(AssertSqlSafe(format!("SELECT active_catalog_revision FROM {schema}.collections WHERE collection_id=$1 FOR UPDATE"))).bind(COLLECTION_ID).fetch_one(&mut *validation).await?;
            let rejected = current != prepared_revision;
            validation.rollback().await?;
            let restored = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.collections SET active_catalog_revision=$2 WHERE collection_id=$1 AND active_catalog_revision=$3"))).bind(COLLECTION_ID).bind(&prepared_revision).bind(superseded_revision).execute(&pool).await?.rows_affected();
            let after_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT head FROM {schema}.collections WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            if transition_rows != 1 || !rejected || restored != 1 || before_head != after_head {
                return Err(Error::Invalid(
                    "catalog_supersession_was_not_fail_closed".to_string(),
                ));
            }
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"write.catalog_supersession","outcome":"success","failure_stage":"catalog-superseded-before-settlement","recovery_state":"concurrent-transition-rejected-and-restored","final_head":after_head,"transaction_released":true,"notes":{"transition_rows":transition_rows,"prepared_revision":prepared_revision,"observed_revision":current,"head_unchanged":true}})
            );
        }
    }
    Ok(())
}

