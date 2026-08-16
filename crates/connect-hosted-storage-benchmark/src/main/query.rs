#[derive(Deserialize)]
struct ExactEnvelope {
    path: String,
    file_mtime: String,
    document: String,
}

struct ActiveCatalog {
    catalog: CompiledCatalog,
    revision: String,
    generation_id: Option<Uuid>,
}

async fn load_active_catalog(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    candidate: Candidate,
) -> Result<ActiveCatalog, Error> {
    let schema = candidate.schema();
    if candidate == Candidate::A {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT active_catalog_revision,resources_ciphertext FROM {schema}.collections WHERE collection_id=$1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(&mut **transaction)
        .await?;
        let revision: String = row.get("active_catalog_revision");
        let ciphertext: Vec<u8> = row.get("resources_ciphertext");
        let bytes = decrypt_exact(COLLECTION_ID, &revision, &ciphertext)?;
        return Ok(ActiveCatalog {
            catalog: compile_catalog_bytes(&bytes)?,
            revision,
            generation_id: None,
        });
    }
    if candidate.encrypted() {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT active_catalog_revision,active_generation_id,resources_ciphertext FROM {schema}.collections WHERE collection_id=$1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(&mut **transaction)
        .await?;
        let revision: String = row.get("active_catalog_revision");
        let ciphertext: Vec<u8> = row.get("resources_ciphertext");
        let bytes = decrypt_exact(COLLECTION_ID, &revision, &ciphertext)?;
        Ok(ActiveCatalog {
            catalog: compile_catalog_bytes(&bytes)?,
            revision,
            generation_id: Some(row.get("active_generation_id")),
        })
    } else {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT active_catalog_revision,active_generation_id,resources_document FROM {schema}.collections WHERE collection_id=$1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(&mut **transaction)
        .await?;
        let resources: sqlx::types::Json<Vec<Value>> = row.get("resources_document");
        let mut bytes = Vec::new();
        for resource in resources.0 {
            serde_json::to_writer(&mut bytes, &resource)?;
            bytes.push(b'\n');
        }
        Ok(ActiveCatalog {
            catalog: compile_catalog_bytes(&bytes)?,
            revision: row.get("active_catalog_revision"),
            generation_id: Some(row.get("active_generation_id")),
        })
    }
}

struct ScanResult {
    facts: Vec<Fact>,
    sql_rows: usize,
    documents_decrypted: usize,
    ciphertext_bytes: u64,
    plaintext_bytes: u64,
    decrypted_bytes_peak: u64,
    retained_fact_bytes: u64,
    accounted_bytes_peak: u64,
    terminal_budget: Option<&'static str>,
    cancelled: bool,
}

struct ScanLimits {
    records: usize,
    bytes: u64,
    accounted_bytes: u64,
    top_k_entries: usize,
}

#[allow(clippy::too_many_arguments)]
async fn execute_scan(
    transaction: &mut sqlx::Transaction<'_, Postgres>,
    candidate: Candidate,
    active: &ActiveCatalog,
    workload: &Workload,
    expression: &CandidateExpression,
    include_body: bool,
    limits: &ScanLimits,
    started: Instant,
    deadline: Duration,
    cancellation_probe: bool,
) -> Result<ScanResult, Error> {
    let schema = candidate.schema();
    let predicate = if candidate == Candidate::A {
        "TRUE".to_string()
    } else {
        compile_candidate_sql(expression, candidate).unwrap_or_else(|| "TRUE".to_string())
    };
    let needs_exact = include_body
        || expression_needs_body(expression)
        || workload
            .canonical_residual
            .as_ref()
            .is_some_and(expression_needs_body)
        || workload
            .client_residual
            .as_ref()
            .is_some_and(expression_needs_body);
    let current = "p.record_revision=r.record_revision AND p.catalog_revision=c.active_catalog_revision AND p.projection_format_version=c.active_projection_format_version AND p.generation_id=c.active_generation_id AND g.status IN ('building','complete')";
    let sql = if candidate == Candidate::A {
        format!("SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id")
    } else if candidate.encrypted() {
        let exact = if needs_exact {
            "r.exact_ciphertext".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_ciphertext END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_ciphertext,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    } else {
        let exact = if needs_exact {
            "r.exact_markdown".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_markdown END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_markdown,r.path AS exact_path,r.file_mtime AS exact_file_mtime,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    };
    let mut rows = sqlx::query(AssertSqlSafe(sql))
        .bind(COLLECTION_ID)
        .fetch(&mut **transaction);
    let mut result = ScanResult {
        facts: Vec::new(),
        sql_rows: 0,
        documents_decrypted: 0,
        ciphertext_bytes: 0,
        plaintext_bytes: 0,
        decrypted_bytes_peak: 0,
        retained_fact_bytes: 0,
        accounted_bytes_peak: 0,
        terminal_budget: None,
        cancelled: false,
    };
    loop {
        let Some(remaining) = deadline.checked_sub(started.elapsed()) else {
            if cancellation_probe {
                result.cancelled = true;
            } else {
                result.terminal_budget = Some("time");
            }
            break;
        };
        let row = match tokio::time::timeout(remaining, rows.try_next()).await {
            Ok(row) => row?,
            Err(_) if cancellation_probe => {
                result.cancelled = true;
                break;
            }
            Err(_) => {
                result.terminal_budget = Some("time");
                break;
            }
        };
        let Some(row) = row else { break };
        result.sql_rows += 1;
        if result.sql_rows > limits.records {
            result.terminal_budget = Some("scan");
            break;
        }
        let id: Uuid = row.get("record_id");
        let revision: String = row.get("record_revision");
        let (record, body, projection) = if candidate == Candidate::A {
            let ciphertext: Vec<u8> = row.get("exact_ciphertext");
            result.ciphertext_bytes += ciphertext.len() as u64;
            let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
            result.decrypted_bytes_peak = result.decrypted_bytes_peak.max(plaintext.len() as u64);
            result.plaintext_bytes += plaintext.len() as u64;
            result.documents_decrypted += 1;
            let envelope: ExactEnvelope = serde_json::from_slice(&plaintext)?;
            let canonical = CanonicalRecordInput {
                stable_id: Some(id.to_string()),
                path: envelope.path.clone(),
                file_size: envelope.document.len() as u64,
                file_mtime: Some(envelope.file_mtime.clone()),
                document: envelope.document.clone(),
            };
            let classified = active.catalog.classify_record(&canonical)?;
            let projection = active.catalog.benchmark_project_record(&canonical)?;
            (
                RecordLine {
                    record_id: id.to_string(),
                    path: envelope.path,
                    document: envelope.document,
                    file_mtime: envelope.file_mtime,
                },
                classified.body,
                projection,
            )
        } else {
            let projection_current: bool = row.get("projection_current");
            let current_projection = if projection_current {
                let semantic: sqlx::types::Json<Value> = row.get("semantic_projection");
                let projection = projection_from_row(&row, &semantic.0)?;
                let digest = authority_projection_digest(
                    id,
                    &revision,
                    &active.revision,
                    active
                        .generation_id
                        .expect("projected candidate generation"),
                    &projection,
                    &semantic.0,
                )?;
                let stored: String = row.get("projection_digest");
                if digest != stored {
                    return Err(Error::Invalid(format!(
                        "projection digest verification failed for {id}"
                    )));
                }
                Some(projection)
            } else {
                None
            };
            let fetch_exact = needs_exact || current_projection.is_none();
            let exact = if fetch_exact {
                if candidate.encrypted() {
                    let ciphertext = row
                        .try_get::<Option<Vec<u8>>, _>("exact_ciphertext")?
                        .ok_or_else(|| {
                            Error::Invalid("required exact ciphertext was not selected".to_string())
                        })?;
                    result.ciphertext_bytes += ciphertext.len() as u64;
                    let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
                    result.decrypted_bytes_peak =
                        result.decrypted_bytes_peak.max(plaintext.len() as u64);
                    result.plaintext_bytes += plaintext.len() as u64;
                    result.documents_decrypted += 1;
                    Some(serde_json::from_slice::<ExactEnvelope>(&plaintext)?)
                } else {
                    let document = row
                        .try_get::<Option<String>, _>("exact_markdown")?
                        .ok_or_else(|| {
                            Error::Invalid("required exact markdown was not selected".to_string())
                        })?;
                    result.plaintext_bytes += document.len() as u64;
                    Some(ExactEnvelope {
                        path: row.get("exact_path"),
                        file_mtime: row
                            .get::<chrono::DateTime<chrono::Utc>, _>("exact_file_mtime")
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        document,
                    })
                }
            } else {
                None
            };
            let projection = if let Some(projection) = current_projection {
                projection
            } else {
                let envelope = exact.as_ref().expect("stale projection exact fallback");
                active
                    .catalog
                    .benchmark_project_record(&CanonicalRecordInput {
                        stable_id: Some(id.to_string()),
                        path: envelope.path.clone(),
                        file_size: envelope.document.len() as u64,
                        file_mtime: Some(envelope.file_mtime.clone()),
                        document: envelope.document.clone(),
                    })?
            };
            let envelope = exact.unwrap_or_else(|| ExactEnvelope {
                path: projection.path.clone(),
                file_mtime: projection.file.mtime.clone(),
                document: String::new(),
            });
            let body = if envelope.document.is_empty() {
                String::new()
            } else {
                active
                    .catalog
                    .classify_record(&CanonicalRecordInput {
                        stable_id: Some(id.to_string()),
                        path: envelope.path.clone(),
                        file_size: envelope.document.len() as u64,
                        file_mtime: Some(envelope.file_mtime.clone()),
                        document: envelope.document.clone(),
                    })?
                    .body
            };
            (
                RecordLine {
                    record_id: id.to_string(),
                    path: envelope.path,
                    document: envelope.document,
                    file_mtime: envelope.file_mtime,
                },
                body,
                projection,
            )
        };
        if expression.evaluate_canonical(&projection, &body) {
            let fact = result_fact(workload, &record, &revision, &body, &projection)?;
            result.retained_fact_bytes += serde_json::to_vec(&fact)?.len() as u64;
            result.facts.push(fact);
            result.accounted_bytes_peak = result
                .accounted_bytes_peak
                .max(result.retained_fact_bytes + result.decrypted_bytes_peak);
            if result.accounted_bytes_peak > limits.accounted_bytes {
                result.terminal_budget = Some("result");
                break;
            }
            if !workload.order.is_empty()
                && result.facts.len() > limits.top_k_entries + workload.page.offset
            {
                result.terminal_budget = Some("ordering");
                break;
            }
        }
        if result.ciphertext_bytes > limits.bytes || result.plaintext_bytes > limits.bytes {
            result.terminal_budget = Some("scan");
            break;
        }
    }
    drop(rows);
    Ok(result)
}

#[allow(dead_code)]
fn canonical_expected_for_workload(
    fixture_dir: &Path,
    workload: &Workload,
    catalog: &CompiledCatalog,
) -> Result<Value, Error> {
    let mut candidate_facts = Vec::new();
    let mut provider = HashMap::<String, Vec<Fact>>::new();
    for scan in &workload.provider_scans {
        provider.insert(format!("{}:{}", workload.id, scan.id), Vec::new());
    }
    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id.clone()),
            path: record.path.clone(),
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime.clone()),
            document: record.document.clone(),
        };
        let classified = catalog.classify_record(&canonical)?;
        let projection = catalog.benchmark_project_record(&canonical)?;
        if workload
            .candidate_ir
            .evaluate_canonical(&projection, &classified.body)
        {
            candidate_facts.push(result_fact(
                workload,
                &record,
                &classified.revision,
                &classified.body,
                &projection,
            )?);
        }
        for scan in &workload.provider_scans {
            if scan
                .candidate_ir
                .evaluate_canonical(&projection, &classified.body)
            {
                provider
                    .get_mut(&format!("{}:{}", workload.id, scan.id))
                    .expect("provider exists")
                    .push(result_fact(
                        workload,
                        &record,
                        &classified.revision,
                        &classified.body,
                        &projection,
                    )?);
            }
        }
    }
    expected_workload(workload, candidate_facts, &mut provider)
}

fn process_memory_bytes() -> (Option<u64>, Option<u64>) {
    fn field(path: &str, name: &str) -> Option<u64> {
        std::fs::read_to_string(path)
            .ok()?
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                (key == name)
                    .then(|| {
                        value
                            .split_whitespace()
                            .next()?
                            .parse::<u64>()
                            .ok()
                            .map(|kb| kb * 1024)
                    })
                    .flatten()
            })
    }
    (
        field("/proc/self/status", "VmRSS"),
        field("/proc/self/smaps_rollup", "Pss"),
    )
}

async fn query_workload(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    workload_path: &Path,
    workload_id: &str,
    budget_path: &Path,
    large_fixture_entitlement: bool,
) -> Result<(), Error> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(database_url)
        .await?;
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let workload = contract
        .query_workloads
        .iter()
        .find(|value| value.id == workload_id)
        .ok_or_else(|| Error::Invalid(format!("unknown workload: {workload_id}")))?;
    workload.candidate_ir.clone().compile()?;
    for scan in &workload.provider_scans {
        scan.candidate_ir.clone().compile()?;
    }
    let budget: BudgetManifest = serde_json::from_reader(File::open(budget_path)?)?;
    if workload.page.offset > budget.defaults.maximum_offset {
        return emit_preflight_budget(candidate, workload, "ordering");
    }
    let (records, bytes, snapshot_ms, operation_ms) = if large_fixture_entitlement {
        let value = &budget.entitlements.large_fixture_v1;
        (
            value.scanned_records,
            value.scanned_ciphertext_bytes,
            value.snapshot_lifetime_ms,
            value.operation_deadline_ms,
        )
    } else {
        (
            budget.defaults.scanned_records,
            budget.defaults.scanned_ciphertext_bytes,
            budget.defaults.snapshot_lifetime_ms,
            budget.defaults.operation_deadline_ms,
        )
    };
    let limits = ScanLimits {
        records,
        bytes,
        accounted_bytes: budget.defaults.accounted_execution_bytes_per_operation,
        top_k_entries: budget.defaults.top_k_entries,
    };
    let cancellation_probe = workload.id == "sdk.cancel_broad_body_scan";
    let deadline = if cancellation_probe {
        Duration::from_millis(workload.cancel_after_ms.unwrap_or(50))
    } else {
        Duration::from_millis(operation_ms.min(snapshot_ms))
    };
    let mut preparation = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *preparation)
        .await?;
    let prepared = load_active_catalog(&mut preparation, candidate).await?;
    preparation.commit().await?;
    let v1 = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let expected = if prepared.revision == v1.resource_revision() {
        let artifact: Value =
            serde_json::from_reader(File::open(fixture_dir.join("expected-results.json"))?)?;
        artifact["workloads"][workload_id].clone()
    } else {
        let artifact: Value =
            serde_json::from_reader(File::open(fixture_dir.join("expected-results-v2.json"))?)?;
        artifact["workloads"][workload_id].clone()
    };
    let started = Instant::now();
    let pool_wait_started = Instant::now();
    let mut transaction = pool.begin().await?;
    let pool_wait_ms = pool_wait_started.elapsed().as_secs_f64() * 1000.0;
    let observed_pool_occupancy = || {
        usize::try_from(pool.size())
            .unwrap_or(usize::MAX)
            .saturating_sub(pool.num_idle())
    };
    let mut pool_occupancy_samples = vec![observed_pool_occupancy()];
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    pool_occupancy_samples.push(observed_pool_occupancy());
    let active = load_active_catalog(&mut transaction, candidate).await?;
    if active.revision != prepared.revision || active.generation_id != prepared.generation_id {
        return Err(Error::Invalid("catalog_superseded".to_string()));
    }
    let mut provider = HashMap::<String, Vec<Fact>>::new();
    let mut candidate_by_id = HashMap::<String, Fact>::new();
    let mut sql_rows = 0_usize;
    let mut documents_decrypted = 0_usize;
    let mut ciphertext_bytes = 0_u64;
    let mut plaintext_bytes = 0_u64;
    let mut accounted_peak = 0_u64;
    let mut retained_provider_bytes = 0_u64;
    let mut terminal_budget = None;
    let mut cancelled = false;
    if workload.provider_scans.is_empty() {
        let include_body = workload
            .response_fields
            .iter()
            .any(|field| field == "body" || field == "document");
        let result = execute_scan(
            &mut transaction,
            candidate,
            &active,
            workload,
            &workload.candidate_ir,
            include_body,
            &limits,
            started,
            deadline,
            cancellation_probe,
        )
        .await?;
        pool_occupancy_samples.push(observed_pool_occupancy());
        sql_rows += result.sql_rows;
        documents_decrypted += result.documents_decrypted;
        ciphertext_bytes += result.ciphertext_bytes;
        plaintext_bytes += result.plaintext_bytes;
        accounted_peak = accounted_peak.max(result.accounted_bytes_peak);
        terminal_budget = result.terminal_budget;
        cancelled = result.cancelled;
        for fact in result.facts {
            candidate_by_id.insert(fact.record_id.clone(), fact);
        }
    } else {
        for scan in &workload.provider_scans {
            let result = execute_scan(
                &mut transaction,
                candidate,
                &active,
                workload,
                &scan.candidate_ir,
                scan.include_body,
                &limits,
                started,
                deadline,
                false,
            )
            .await?;
            pool_occupancy_samples.push(observed_pool_occupancy());
            sql_rows += result.sql_rows;
            documents_decrypted += result.documents_decrypted;
            ciphertext_bytes += result.ciphertext_bytes;
            plaintext_bytes += result.plaintext_bytes;
            accounted_peak = accounted_peak.max(result.accounted_bytes_peak);
            retained_provider_bytes += result.retained_fact_bytes;
            terminal_budget = terminal_budget.or(result.terminal_budget);
            let key = format!("{}:{}", workload.id, scan.id);
            for fact in &result.facts {
                candidate_by_id.insert(fact.record_id.clone(), fact.clone());
            }
            provider.insert(key, result.facts);
            if terminal_budget.is_some() {
                break;
            }
        }
    }
    let retained_candidate_bytes = candidate_by_id
        .values()
        .map(serde_json::to_vec)
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .map(|bytes| bytes.len() as u64)
        .sum::<u64>();
    accounted_peak = accounted_peak.max(retained_provider_bytes + retained_candidate_bytes);
    if accounted_peak > limits.accounted_bytes {
        terminal_budget = Some("result");
    }
    let pool_connections_peak = pool_occupancy_samples.iter().copied().max().unwrap_or(0);
    let pool_connections_average =
        pool_occupancy_samples.iter().sum::<usize>() as f64 / pool_occupancy_samples.len() as f64;
    let snapshot_lifetime_ms = started.elapsed().as_secs_f64() * 1000.0;
    let rows_selected = candidate_by_id.len();
    if cancelled || terminal_budget.is_some() {
        let cleanup_started = Instant::now();
        transaction.rollback().await?;
        let cleanup_ms = cleanup_started.elapsed().as_secs_f64() * 1000.0;
        let (rss, pss) = process_memory_bytes();
        let kind = terminal_budget.unwrap_or("cancelled");
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                "outcome":if cancelled {"cancelled"} else {"budget"},
                "budget_kind":if cancelled {Value::Null} else {Value::String(kind.to_string())},
                "budget_accepted":!cancelled && workload.acceptable_budget_kinds.iter().any(|value| value == kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_selected":rows_selected,"rows_scanned":sql_rows,
                "sql_candidate_rows":sql_rows,"canonical_rows_evaluated":sql_rows,"documents_decrypted":documents_decrypted,
                "ciphertext_bytes":ciphertext_bytes,"plaintext_bytes":plaintext_bytes,"accounted_operator_bytes_peak":accounted_peak,
                "cancellation_cleanup_ms":if cancelled {Some(cleanup_ms)} else {None},"snapshot_lifetime_ms":snapshot_lifetime_ms,
                "provider_rss_bytes":rss,"provider_pss_bytes":pss,"pool_connections_peak":pool_connections_peak,"pool_connections_average":pool_connections_average,
                "pool_wait_ms":pool_wait_ms,"transaction_released":true,"pool_permit_released":true,"plaintext_released":true
            })
        );
        pool.close().await;
        return Ok(());
    }
    transaction.commit().await?;
    let candidate_facts = candidate_by_id.into_values().collect::<Vec<_>>();
    let canonical_fact_count = candidate_facts.len();
    let actual = expected_workload(workload, candidate_facts, &mut provider)?;
    let result_items = actual["returned"]
        .as_u64()
        .unwrap_or_else(|| actual["consumerResultCount"].as_u64().unwrap_or(0));
    let result_bytes = serde_json::to_vec(&actual)?.len() as u64;
    let group_count = actual["groups"].as_array().map_or(0, Vec::len);
    let group_bytes = actual["groups"]
        .as_array()
        .map(serde_json::to_vec)
        .transpose()?
        .map_or(0, |value| value.len() as u64);
    let budget_kind = if group_count > budget.defaults.groups
        || group_bytes > budget.defaults.aggregation_state_bytes
    {
        Some("groups")
    } else if result_items > budget.defaults.result_items
        || result_bytes > budget.defaults.result_bytes
    {
        Some("result")
    } else if canonical_fact_count > budget.defaults.top_k_entries && !workload.order.is_empty() {
        Some("ordering")
    } else {
        None
    };
    if let Some(kind) = budget_kind {
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,"outcome":"budget","budget_kind":kind,
                "budget_accepted":workload.acceptable_budget_kinds.iter().any(|value| value == kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_selected":rows_selected,"rows_scanned":sql_rows,
                "sql_candidate_rows":sql_rows,"canonical_rows_evaluated":sql_rows,"documents_decrypted":documents_decrypted,
                "ciphertext_bytes":ciphertext_bytes,"plaintext_bytes":plaintext_bytes,"result_items":result_items,"result_bytes":result_bytes,
                "accounted_operator_bytes_peak":accounted_peak.max(group_bytes),"snapshot_lifetime_ms":snapshot_lifetime_ms,
                "transaction_released":true,"pool_permit_released":true,"plaintext_released":true
            })
        );
        return Ok(());
    }
    if actual != expected {
        return Err(Error::SeedMismatch(first_json_difference(
            "$", &expected, &actual,
        )));
    }
    let page_boundaries = actual["providerScans"]
        .as_array()
        .map(|scans| {
            scans
                .iter()
                .flat_map(|scan| {
                    scan["pages"].as_array().into_iter().flatten().map(|page| {
                        json!({
                            "scan_id":scan["id"],
                            "page":page["page"],
                            "count":page["count"],
                            "digest":page["orderedRecordIdsDigest"]
                        })
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let (rss, pss) = process_memory_bytes();
    println!(
        "{}",
        json!({
            "candidate":format!("{candidate:?}"),"workload_id":workload_id,"outcome":"success",
            "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_selected":rows_selected,"rows_scanned":sql_rows,
            "sql_candidate_rows":sql_rows,"canonical_rows_evaluated":sql_rows,"documents_decrypted":documents_decrypted,
            "ciphertext_bytes":ciphertext_bytes,"plaintext_bytes":plaintext_bytes,"result_items":result_items,"result_bytes":result_bytes,
            "completeness_digest":actual["orderedRecordIdsDigest"].clone(),"page_boundaries":page_boundaries,
            "accounted_operator_bytes_peak":accounted_peak.max(group_bytes),"snapshot_lifetime_ms":snapshot_lifetime_ms,
            "provider_rss_bytes":rss,"provider_pss_bytes":pss,"pool_connections_peak":pool_connections_peak,"pool_connections_average":pool_connections_average,"pool_wait_ms":pool_wait_ms,
            "transaction_released":true,"pool_permit_released":true,"plaintext_released":true,
            "key_cache_misses":if candidate.encrypted() && documents_decrypted>0 {1} else {0},
            "key_cache_hits":if candidate.encrypted() {documents_decrypted.saturating_sub(1)} else {0},
            "kms_unwraps":if candidate.encrypted() && documents_decrypted>0 {1} else {0},
            "notes":{"key_activity":"deterministic benchmark key-cache model; not an observed external KMS","catalog_revision":active.revision,"generation_id":active.generation_id,"pool_configured_max":4,"pool_occupancy_samples":pool_occupancy_samples}
        })
    );
    Ok(())
}
