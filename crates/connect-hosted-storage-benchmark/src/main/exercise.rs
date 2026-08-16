async fn load_exact_point(
    pool: &PgPool,
    candidate: Candidate,
) -> Result<(Uuid, String, usize, usize), Error> {
    let schema = candidate.schema();
    if candidate.encrypted() {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(pool)
        .await?;
        let id: Uuid = row.get("record_id");
        let revision: String = row.get("record_revision");
        let ciphertext: Vec<u8> = row.get("exact_ciphertext");
        let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
        let envelope: ExactEnvelope = serde_json::from_slice(&plaintext)?;
        let expected_revision =
            format!("sha256:{:x}", Sha256::digest(envelope.document.as_bytes()));
        if expected_revision != revision || envelope.path.is_empty() {
            return Err(Error::Invalid(
                "point_read_exact_validation_failed".to_string(),
            ));
        }
        Ok((id, revision, ciphertext.len(), plaintext.len()))
    } else {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT record_id,record_revision,exact_markdown FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(pool)
        .await?;
        let document: String = row.get("exact_markdown");
        let revision: String = row.get("record_revision");
        let expected_revision = format!("sha256:{:x}", Sha256::digest(document.as_bytes()));
        if expected_revision != revision {
            return Err(Error::Invalid(
                "point_read_exact_validation_failed".to_string(),
            ));
        }
        Ok((row.get("record_id"), revision, 0, document.len()))
    }
}

async fn write_one_record(
    pool: &PgPool,
    candidate: Candidate,
    _fixture_catalog: &CompiledCatalog,
    operation: ExerciseOperation,
    repetition: usize,
    race: Option<WriteRace>,
) -> Result<(), Error> {
    let schema = candidate.schema();
    let mut preparation = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *preparation)
        .await?;
    let active = load_active_catalog(&mut preparation, candidate).await?;
    preparation.commit().await?;
    let row = if candidate == Candidate::A {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.exact_ciphertext FROM {schema}.records r WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    } else if candidate.encrypted() {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.exact_ciphertext,p.path,p.file_mtime FROM {schema}.records r LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    } else {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.path,r.exact_markdown,r.file_mtime FROM {schema}.records r WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    };
    let id: Uuid = row.get("record_id");
    let old_revision: String = row.get("record_revision");
    let old_content_bytes: i64 = row.get("content_bytes");
    let old_ciphertext = candidate
        .encrypted()
        .then(|| row.get::<Vec<u8>, _>("exact_ciphertext"));
    let mut envelope = if let Some(ciphertext) = &old_ciphertext {
        serde_json::from_slice::<ExactEnvelope>(&decrypt_exact(id, &old_revision, ciphertext)?)?
    } else {
        ExactEnvelope {
            path: row.get("path"),
            file_mtime: row
                .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            document: row.get("exact_markdown"),
        }
    };
    match operation {
        ExerciseOperation::BodyWrite => {
            envelope
                .document
                .push_str(&format!("\nbenchmark body write {repetition}\n"));
        }
        ExerciseOperation::FrontmatterWrite => {
            let marker = "benchmark_write_sample:";
            let replacement = format!("{marker} {repetition}");
            if let Some(start) = envelope.document.find(marker) {
                let end = envelope.document[start..]
                    .find('\n')
                    .map_or(envelope.document.len(), |offset| start + offset);
                envelope.document.replace_range(start..end, &replacement);
            } else if envelope.document.starts_with("---\n") {
                envelope.document.insert_str(4, &format!("{replacement}\n"));
            }
        }
        ExerciseOperation::PathWrite => {
            let parent = envelope
                .path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            envelope.path = if parent.is_empty() {
                format!("benchmark-{id}-{repetition}.md")
            } else {
                format!("{parent}/benchmark-{id}-{repetition}.md")
            };
        }
        _ => unreachable!("write operation filtered by caller"),
    }
    envelope.file_mtime = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let revision = format!("sha256:{:x}", Sha256::digest(envelope.document.as_bytes()));
    let canonical = CanonicalRecordInput {
        stable_id: Some(id.to_string()),
        path: envelope.path.clone(),
        file_size: envelope.document.len() as u64,
        file_mtime: Some(envelope.file_mtime.clone()),
        document: envelope.document.clone(),
    };
    let projection = candidate
        .projected()
        .then(|| active.catalog.benchmark_project_record(&canonical))
        .transpose()?;
    let semantic = projection.as_ref().map(semantic_projection);
    let state = active
        .generation_id
        .map(|generation_id| (active.revision.clone(), generation_id));
    let projection_digest = state
        .as_ref()
        .zip(projection.as_ref())
        .zip(semantic.as_ref())
        .map(
            |(((catalog_revision, generation_id), projection), semantic)| {
                authority_projection_digest(
                    id,
                    &revision,
                    catalog_revision,
                    *generation_id,
                    projection,
                    semantic,
                )
            },
        )
        .transpose()?;
    let exact = if candidate.encrypted() {
        encrypt_exact(
            id,
            &revision,
            &serde_json::to_vec(&json!({
                "path":envelope.path,"file_mtime":envelope.file_mtime,"document":envelope.document
            }))?,
        )?
    } else {
        Vec::new()
    };
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(pool)
        .await?;
    let started = Instant::now();
    if race == Some(WriteRace::RecordRevision) {
        let racer_pool = pool.clone();
        let racer_sql = format!("UPDATE {schema}.records SET record_revision='sha256:concurrent-prepared-mutation-race' WHERE collection_id=$1 AND record_id=$2 AND record_revision=$3");
        let expected_revision = old_revision.clone();
        tokio::spawn(async move {
            sqlx::query(AssertSqlSafe(racer_sql))
                .bind(COLLECTION_ID)
                .bind(id)
                .bind(expected_revision)
                .execute(&racer_pool)
                .await
        })
        .await
        .map_err(|error| Error::Invalid(format!("record race task failed: {error}")))??;
    } else if race == Some(WriteRace::CatalogSupersession) {
        let racer_pool = pool.clone();
        let racer_sql = format!("UPDATE {schema}.collections SET active_catalog_revision='sha256:concurrent-catalog-race' WHERE collection_id=$1 AND active_catalog_revision=$2");
        let expected = active.revision.clone();
        tokio::spawn(async move {
            sqlx::query(AssertSqlSafe(racer_sql))
                .bind(COLLECTION_ID)
                .bind(expected)
                .execute(&racer_pool)
                .await
        })
        .await
        .map_err(|error| Error::Invalid(format!("catalog race task failed: {error}")))??;
    }
    let mut tx = pool.begin().await?;
    let locked = if candidate.projected() {
        sqlx::query(AssertSqlSafe(format!("SELECT c.active_catalog_revision,c.active_generation_id,g.status FROM {schema}.collections c JOIN {schema}.projection_generations g ON g.collection_id=c.collection_id AND g.generation_id=c.active_generation_id WHERE c.collection_id=$1 FOR UPDATE OF c,g")))
            .bind(COLLECTION_ID).fetch_one(&mut *tx).await?
    } else {
        sqlx::query(AssertSqlSafe(format!("SELECT active_catalog_revision,NULL::uuid AS active_generation_id,'complete'::text AS status FROM {schema}.collections WHERE collection_id=$1 FOR UPDATE")))
            .bind(COLLECTION_ID).fetch_one(&mut *tx).await?
    };
    let locked_revision: String = locked.get("active_catalog_revision");
    let locked_generation: Option<Uuid> = locked.get("active_generation_id");
    let locked_status: String = locked.get("status");
    if locked_revision != active.revision
        || locked_generation != active.generation_id
        || (candidate.projected() && locked_status != "building" && locked_status != "complete")
    {
        tx.rollback().await?;
        if race == Some(WriteRace::CatalogSupersession) {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.collections SET active_catalog_revision=$2 WHERE collection_id=$1 AND active_catalog_revision='sha256:concurrent-catalog-race'"))).bind(COLLECTION_ID).bind(&active.revision).execute(pool).await?;
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"write.catalog_supersession","outcome":"success","failure_stage":"catalog-superseded-before-settlement","recovery_state":"real-prepared-mutation-rejected-and-restored","transaction_released":true,"notes":{"prepared_mutation_path":true,"versions_settled":0,"changes_settled":0,"projections_settled":0}})
            );
            return Ok(());
        }
        return Err(Error::Invalid("catalog_superseded".to_string()));
    }
    let sequence: i64 = sqlx::query_scalar(AssertSqlSafe(format!("UPDATE {schema}.collections SET head=head+1,content_bytes=content_bytes-$2+$3 WHERE collection_id=$1 RETURNING head")))
        .bind(COLLECTION_ID).bind(old_content_bytes).bind(envelope.document.len() as i64).fetch_one(&mut *tx).await?;
    let record_update = if candidate.encrypted() {
        let path_assignment = if operation == ExerciseOperation::PathWrite {
            ",path_token=$6"
        } else {
            ""
        };
        let mut query = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET record_revision=$3,content_bytes=$4,exact_ciphertext=$5,sequence=$7,updated_at=clock_timestamp(){path_assignment} WHERE collection_id=$1 AND record_id=$2 AND record_revision=$8")))
            .bind(COLLECTION_ID).bind(id).bind(&revision).bind(envelope.document.len() as i64).bind(&exact);
        if operation == ExerciseOperation::PathWrite {
            query = query.bind(path_token(&envelope.path));
        } else {
            query = query.bind(Vec::<u8>::new());
        }
        query
            .bind(sequence)
            .bind(&old_revision)
            .execute(&mut *tx)
            .await?
    } else {
        sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET path=$3,record_revision=$4,content_bytes=$5,exact_markdown=$6,file_mtime=$7,sequence=$8,updated_at=clock_timestamp() WHERE collection_id=$1 AND record_id=$2 AND record_revision=$9")))
            .bind(COLLECTION_ID).bind(id).bind(&envelope.path).bind(&revision).bind(envelope.document.len() as i64).bind(&envelope.document).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(sequence).bind(&old_revision).execute(&mut *tx).await?
    };
    if record_update.rows_affected() != 1 {
        tx.rollback().await?;
        if race == Some(WriteRace::RecordRevision) {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET record_revision=$3 WHERE collection_id=$1 AND record_id=$2 AND record_revision='sha256:concurrent-prepared-mutation-race'"))).bind(COLLECTION_ID).bind(id).bind(&old_revision).execute(pool).await?;
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"write.cas_loss","outcome":"success","failure_stage":"record-cas-after-preparation","recovery_state":"real-prepared-mutation-rejected-and-restored","transaction_released":true,"notes":{"prepared_mutation_path":true,"versions_settled":0,"changes_settled":0,"projections_settled":0,"collection_head_rolled_back":true}})
            );
            return Ok(());
        }
        return Err(Error::Invalid("record write CAS lost".to_string()));
    }
    if candidate.encrypted() {
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,exact_ciphertext) VALUES ($1,$2,$3,$4,$5)"))).bind(COLLECTION_ID).bind(id).bind(sequence).bind(&revision).bind(&exact).execute(&mut *tx).await?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,before_ciphertext,after_ciphertext,record_revision) VALUES ($1,$2,$3,$4,$5,$6)"))).bind(COLLECTION_ID).bind(sequence).bind(id).bind(old_ciphertext).bind(&exact).bind(&revision).execute(&mut *tx).await?;
    } else {
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,path,exact_markdown,projection) VALUES ($1,$2,$3,$4,$5,$6,$7)"))).bind(COLLECTION_ID).bind(id).bind(sequence).bind(&revision).bind(&envelope.path).bind(&envelope.document).bind(sqlx::types::Json(semantic.as_ref().unwrap())).execute(&mut *tx).await?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,before_record,after_record,record_revision) VALUES ($1,$2,$3,NULL,$4,$5)"))).bind(COLLECTION_ID).bind(sequence).bind(id).bind(sqlx::types::Json(json!({"path":envelope.path,"document":envelope.document,"projection":semantic}))).bind(&revision).execute(&mut *tx).await?;
    }
    if candidate.projected() {
        let projection = projection.as_ref().unwrap();
        let updated = if operation == ExerciseOperation::BodyWrite {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET record_revision=$3,file_size=$4,file_mtime=$5,projection_digest=$6,updated_at=clock_timestamp() WHERE collection_id=$1 AND record_id=$2 AND record_revision=$7 AND catalog_revision=$8 AND generation_id=$9"))).bind(COLLECTION_ID).bind(id).bind(&revision).bind(envelope.document.len() as i64).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(projection_digest.as_ref().unwrap()).bind(&old_revision).bind(&active.revision).bind(active.generation_id.unwrap()).execute(&mut *tx).await?.rows_affected()
        } else {
            0
        };
        if updated == 0 {
            sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.record_projections (collection_id,record_id,record_revision,catalog_revision,projection_format_version,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (collection_id,record_id) DO UPDATE SET record_revision=excluded.record_revision,catalog_revision=excluded.catalog_revision,projection_format_version=excluded.projection_format_version,generation_id=excluded.generation_id,path=excluded.path,types=excluded.types,file_size=excluded.file_size,file_mtime=excluded.file_mtime,semantic_projection=excluded.semantic_projection,projection_digest=excluded.projection_digest,updated_at=clock_timestamp()")))
                .bind(COLLECTION_ID).bind(id).bind(&revision).bind(&active.revision).bind(active.generation_id.unwrap()).bind(&envelope.path).bind(&projection.types).bind(envelope.document.len() as i64).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(sqlx::types::Json(semantic.as_ref().unwrap())).bind(projection_digest.as_ref().unwrap()).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(pool)
    .await?;
    println!(
        "{}",
        json!({"candidate":format!("{candidate:?}"),"operation":match operation {ExerciseOperation::BodyWrite=>"write.body_only",ExerciseOperation::FrontmatterWrite=>"write.frontmatter",ExerciseOperation::PathWrite=>"write.path",_=>unreachable!()},"repetition":repetition,"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"wal_bytes":wal,"record_id":id,"record_revision":revision,"sequence":sequence,"narrow_projection_update":operation==ExerciseOperation::BodyWrite})
    );
    Ok(())
}

async fn rebuild_projections(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    fail_after_batches: Option<usize>,
    batch_delay_ms: u64,
) -> Result<(), Error> {
    let result = rebuild_projections_inner(
        database_url,
        candidate,
        fixture_dir,
        fail_after_batches,
        batch_delay_ms,
    )
    .await;
    if let Err(error) = &result {
        if candidate.projected() {
            if let Ok(pool) = PgPool::connect(database_url).await {
                let code = match error {
                    Error::Invalid(value) => {
                        value.split_whitespace().next().unwrap_or("rebuild_failed")
                    }
                    _ => "rebuild_failed",
                };
                let schema = candidate.schema();
                let _ = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.projection_generations SET last_error_code=$3,last_error_at=clock_timestamp() WHERE collection_id=$1 AND generation_id=$2")))
                    .bind(COLLECTION_ID).bind(REBUILD_GENERATION_ID).bind(code).execute(&pool).await;
                pool.close().await;
            }
        }
    }
    result
}

async fn rebuild_projections_inner(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    fail_after_batches: Option<usize>,
    batch_delay_ms: u64,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let resource_bytes = std::fs::read(fixture_dir.join("resources-v2.ndjson"))?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources-v2.ndjson"))?;
    let catalog_revision = catalog.resource_revision().to_string();
    let schema = candidate.schema();
    let started = Instant::now();
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(&pool)
        .await?;

    if candidate == Candidate::A {
        let encrypted = encrypt_exact(COLLECTION_ID, &catalog_revision, &resource_bytes)?;
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {schema}.collections SET active_catalog_revision=$2,resources_ciphertext=$3 WHERE collection_id=$1"
        )))
        .bind(COLLECTION_ID)
        .bind(&catalog_revision)
        .bind(encrypted)
        .execute(&pool)
        .await?;
        println!(
            "{}",
            json!({"candidate":"A","outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_rebuilt":0,"completion_proof":true,"recovery_state":"not-applicable"})
        );
        return Ok(());
    }

    let source_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT head FROM {schema}.collections WHERE collection_id=$1"
    )))
    .bind(COLLECTION_ID)
    .fetch_one(&pool)
    .await?;
    let generation_inserted = sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.projection_generations (collection_id,generation_id,target_catalog_revision,projection_format_version,status,source_head) VALUES ($1,$2,$3,1,'building',$4) ON CONFLICT (collection_id,generation_id) DO NOTHING"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(&catalog_revision)
    .bind(source_head)
    .execute(&pool)
    .await?
    .rows_affected()
        == 1;
    let active_generation: Uuid = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT active_generation_id FROM {schema}.collections WHERE collection_id=$1"
    )))
    .bind(COLLECTION_ID)
    .fetch_one(&pool)
    .await?;
    if active_generation != REBUILD_GENERATION_ID {
        if !generation_inserted {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.projection_generations SET status='abandoned',last_error_code='generation_superseded',last_error_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE collection_id=$1 AND generation_id=$2 AND status='building'")))
                .bind(COLLECTION_ID).bind(REBUILD_GENERATION_ID).execute(&pool).await?;
            return Err(Error::Invalid("rebuild_generation_superseded".to_string()));
        }
        let mut transition = pool.begin().await?;
        if candidate.encrypted() {
            let encrypted = encrypt_exact(COLLECTION_ID, &catalog_revision, &resource_bytes)?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.collections SET active_catalog_revision=$2,active_generation_id=$3,resources_ciphertext=$4 WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .bind(&catalog_revision)
            .bind(REBUILD_GENERATION_ID)
            .bind(encrypted)
            .execute(&mut *transition)
            .await?;
        } else {
            let resources_json = resource_bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(serde_json::from_slice::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.collections SET active_catalog_revision=$2,active_generation_id=$3,resources_document=$4 WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .bind(&catalog_revision)
            .bind(REBUILD_GENERATION_ID)
            .bind(sqlx::types::Json(resources_json))
            .execute(&mut *transition)
            .await?;
        }
        transition.commit().await?;
    }
    let claimed = sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET lease_owner=$3,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_count=attempt_count+1 WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND (lease_owner IS NULL OR lease_expires_at<clock_timestamp() OR lease_owner=$3)"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(REBUILD_LEASE_ID)
    .execute(&pool)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(Error::Invalid(
            "rebuild generation lease is held by another worker".to_string(),
        ));
    }
    let checkpoint: Option<Uuid> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT checkpoint_record_id FROM {schema}.projection_generations WHERE collection_id=$1 AND generation_id=$2"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&pool)
    .await?;
    let mut terminal_checkpoint = checkpoint;
    let mut rebuilt = 0_u64;
    let mut batches = 0_usize;
    let source_sql = if candidate.encrypted() {
        format!(
            "SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 AND ($2::uuid IS NULL OR record_id>$2) ORDER BY record_id LIMIT 128"
        )
    } else {
        format!(
            "SELECT r.record_id,r.record_revision,r.exact_markdown,r.path,r.file_mtime FROM {schema}.records r WHERE r.collection_id=$1 AND ($2::uuid IS NULL OR r.record_id>$2) ORDER BY r.record_id LIMIT 128"
        )
    };
    'source_pages: loop {
        let page_started = Instant::now();
        let mut read_tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *read_tx)
            .await?;
        let mut source = sqlx::query(AssertSqlSafe(source_sql.clone()))
            .bind(COLLECTION_ID)
            .bind(terminal_checkpoint)
            .fetch(&mut *read_tx);
        let mut projected = Vec::with_capacity(128);
        let mut source_bytes = 0_usize;
        while let Some(record) = source.try_next().await? {
            let id: Uuid = record.get("record_id");
            let revision: String = record.get("record_revision");
            let (envelope, record_source_bytes) = if candidate.encrypted() {
                let ciphertext: Vec<u8> = record.get("exact_ciphertext");
                (
                    serde_json::from_slice::<ExactEnvelope>(&decrypt_exact(
                        id,
                        &revision,
                        &ciphertext,
                    )?)?,
                    ciphertext.len(),
                )
            } else {
                let document: String = record.get("exact_markdown");
                let bytes = document.len();
                (
                    ExactEnvelope {
                        path: record.get("path"),
                        file_mtime: record
                            .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        document,
                    },
                    bytes,
                )
            };
            if record_source_bytes > 4_194_304 {
                return Err(Error::Invalid(
                    "rebuild_record_exceeds_batch_bytes".to_string(),
                ));
            }
            if !projected.is_empty() && source_bytes + record_source_bytes > 4_194_304 {
                break;
            }
            source_bytes += record_source_bytes;
            let canonical = CanonicalRecordInput {
                stable_id: Some(id.to_string()),
                path: envelope.path,
                file_size: envelope.document.len() as u64,
                file_mtime: Some(envelope.file_mtime),
                document: envelope.document,
            };
            let projection = catalog.benchmark_project_record(&canonical)?;
            let semantic = semantic_projection(&projection);
            let projection_digest = authority_projection_digest(
                id,
                &revision,
                &catalog_revision,
                REBUILD_GENERATION_ID,
                &projection,
                &semantic,
            )?;
            projected.push(RebuildRow {
                id,
                revision,
                path: projection.path,
                types: projection.types,
                file_size: projection.file.size as i64,
                file_mtime: chrono::DateTime::parse_from_rfc3339(&projection.file.mtime)
                    .map_err(|error| Error::Invalid(format!("invalid fixture mtime: {error}")))?
                    .with_timezone(&chrono::Utc),
                semantic,
                projection_digest,
                source_bytes: record_source_bytes,
            });
            if projected.len() == 128 {
                break;
            }
        }
        drop(source);
        read_tx.commit().await?;
        if projected.is_empty() {
            break;
        }
        if page_started.elapsed() > Duration::from_millis(30_000) {
            return Err(Error::Invalid(
                "rebuild_batch_deadline_exceeded".to_string(),
            ));
        }
        let updated = write_rebuild_batch(&pool, schema, &catalog_revision, &projected).await?;
        if updated != projected.len() as u64 {
            continue 'source_pages;
        }
        rebuilt += updated;
        terminal_checkpoint = projected.last().map(|row| row.id);
        batches += 1;
        if batch_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(batch_delay_ms)).await;
        }
        if fail_after_batches == Some(batches) {
            return Err(Error::Invalid(format!(
                "injected_rebuild_failure after {batches} committed batches"
            )));
        }
    }

    let mut tx = pool.begin().await?;
    let state = sqlx::query(AssertSqlSafe(format!(
        "SELECT c.active_catalog_revision,c.active_generation_id,c.head,g.status,g.source_head,g.lease_owner,(g.lease_expires_at>clock_timestamp()) AS lease_valid FROM {schema}.collections c JOIN {schema}.projection_generations g ON g.collection_id=c.collection_id AND g.generation_id=$2 WHERE c.collection_id=$1 FOR UPDATE OF c,g"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&mut *tx)
    .await?;
    if state.get::<String, _>("active_catalog_revision") != catalog_revision
        || state.get::<Uuid, _>("active_generation_id") != REBUILD_GENERATION_ID
        || state.get::<String, _>("status") != "building"
        || state.get::<Option<Uuid>, _>("lease_owner") != Some(REBUILD_LEASE_ID)
        || !state.get::<bool, _>("lease_valid")
        || state.get::<i64, _>("head") != source_head
        || state.get::<i64, _>("source_head") != source_head
    {
        return Err(Error::Invalid("rebuild_completion_cas_lost".to_string()));
    }
    let stale: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT count(*) FROM {schema}.records r LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 AND (p.record_id IS NULL OR p.record_revision<>r.record_revision OR p.catalog_revision<>$2 OR p.projection_format_version<>1 OR p.generation_id<>$3)"
    )))
    .bind(COLLECTION_ID)
    .bind(&catalog_revision)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&mut *tx)
    .await?;
    if stale != 0 {
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {schema}.projection_generations SET checkpoint_record_id=NULL,last_error_code='completion_proof_failed',last_error_at=clock_timestamp() WHERE collection_id=$1 AND generation_id=$2"
        )))
        .bind(COLLECTION_ID)
        .bind(REBUILD_GENERATION_ID)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(Error::Invalid(format!(
            "rebuild completion proof found {stale} stale rows"
        )));
    }
    let completed = sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET status='complete',completed_at=clock_timestamp(),source_head=$3,lease_owner=NULL,lease_expires_at=NULL WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND lease_owner=$4"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(source_head)
    .bind(REBUILD_LEASE_ID)
    .execute(&mut *tx)
    .await?;
    if completed.rows_affected() != 1 {
        return Err(Error::Invalid("rebuild_completion_cas_lost".to_string()));
    }
    tx.commit().await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(&pool)
    .await?;
    println!(
        "{}",
        json!({"candidate":format!("{candidate:?}"),"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_rebuilt":rebuilt,"batches":batches,"checkpoint_record_id":terminal_checkpoint,"completion_proof":true,"recovery_state":if checkpoint.is_some() {"resumed"} else {"fresh"},"wal_bytes":wal})
    );
    Ok(())
}

async fn write_rebuild_batch(
    pool: &PgPool,
    schema: &str,
    catalog_revision: &str,
    rows: &[RebuildRow],
) -> Result<u64, Error> {
    if rows.len() > 128 || rows.iter().map(|row| row.source_bytes).sum::<usize>() > 4_194_304 {
        return Err(Error::Invalid("rebuild_batch_budget_exceeded".to_string()));
    }
    let mut tx = pool.begin().await?;
    let ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    sqlx::query(AssertSqlSafe(format!(
        "SELECT record_id FROM {schema}.records WHERE collection_id=$1 AND record_id=ANY($2) FOR NO KEY UPDATE"
    )))
    .bind(COLLECTION_ID)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    let state = sqlx::query(AssertSqlSafe(format!(
        "SELECT c.active_catalog_revision,c.active_generation_id,g.status,g.lease_owner,(g.lease_expires_at>clock_timestamp()) AS lease_valid FROM {schema}.collections c JOIN {schema}.projection_generations g ON g.collection_id=c.collection_id AND g.generation_id=$2 WHERE c.collection_id=$1 FOR UPDATE OF c,g"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&mut *tx)
    .await?;
    if state.get::<String, _>("active_catalog_revision") != catalog_revision
        || state.get::<Uuid, _>("active_generation_id") != REBUILD_GENERATION_ID
        || state.get::<String, _>("status") != "building"
        || state.get::<Option<Uuid>, _>("lease_owner") != Some(REBUILD_LEASE_ID)
        || !state.get::<bool, _>("lease_valid")
    {
        return Err(Error::Invalid("rebuild_batch_fenced".to_string()));
    }
    let mut upsert = QueryBuilder::<Postgres>::new(format!(
        "INSERT INTO {schema}.record_projections (collection_id,record_id,record_revision,catalog_revision,projection_format_version,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) SELECT "
    ));
    upsert.push_bind(COLLECTION_ID);
    upsert.push(",v.record_id,v.record_revision,v.catalog_revision,1,v.generation_id,v.path,v.types,v.file_size,v.file_mtime,v.semantic_projection,v.projection_digest FROM (");
    upsert.push_values(rows, |mut b, row| {
        b.push_bind(row.id)
            .push_bind(&row.revision)
            .push_bind(catalog_revision)
            .push_bind(REBUILD_GENERATION_ID)
            .push_bind(&row.path)
            .push_bind(&row.types)
            .push_bind(row.file_size)
            .push_bind(row.file_mtime)
            .push_bind(sqlx::types::Json(&row.semantic))
            .push_bind(&row.projection_digest);
    });
    upsert.push(format!(
        ") AS v(record_id,record_revision,catalog_revision,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) JOIN {schema}.records r ON r.collection_id="
    ));
    upsert.push_bind(COLLECTION_ID);
    upsert.push(" AND r.record_id=v.record_id AND r.record_revision=v.record_revision ON CONFLICT (collection_id,record_id) DO UPDATE SET record_revision=excluded.record_revision,catalog_revision=excluded.catalog_revision,projection_format_version=excluded.projection_format_version,generation_id=excluded.generation_id,path=excluded.path,types=excluded.types,file_size=excluded.file_size,file_mtime=excluded.file_mtime,semantic_projection=excluded.semantic_projection,projection_digest=excluded.projection_digest,updated_at=clock_timestamp()");
    let updated = upsert.build().execute(&mut *tx).await?.rows_affected();
    if updated != rows.len() as u64 {
        tx.rollback().await?;
        return Ok(updated);
    }
    let checkpoint = rows.last().expect("non-empty rebuild batch").id;
    let checkpointed = sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET checkpoint_record_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND lease_owner=$4"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(checkpoint)
    .bind(REBUILD_LEASE_ID)
    .execute(&mut *tx)
    .await?;
    if checkpointed.rows_affected() != 1 {
        return Err(Error::Invalid("rebuild_checkpoint_cas_lost".to_string()));
    }
    tx.commit().await?;
    Ok(updated)
}
