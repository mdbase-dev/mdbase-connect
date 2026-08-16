#[allow(dead_code)]
async fn query_workload_legacy(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    workload_path: &Path,
    workload_id: &str,
    budget_path: &Path,
    large_fixture_entitlement: bool,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let workload = contract
        .query_workloads
        .iter()
        .find(|workload| workload.id == workload_id)
        .ok_or_else(|| Error::Invalid(format!("unknown workload: {workload_id}")))?;
    workload.candidate_ir.clone().compile()?;
    for scan in &workload.provider_scans {
        scan.candidate_ir.clone().compile()?;
    }
    let budget_manifest: BudgetManifest = serde_json::from_reader(File::open(budget_path)?)?;
    let mut scanned_records_limit = budget_manifest.defaults.scanned_records;
    let mut scanned_bytes_limit = budget_manifest.defaults.scanned_ciphertext_bytes;
    let mut snapshot_limit_ms = budget_manifest.defaults.snapshot_lifetime_ms;
    let mut deadline_ms = budget_manifest.defaults.operation_deadline_ms;
    if large_fixture_entitlement {
        let diagnostic = &budget_manifest.entitlements.large_fixture_v1;
        scanned_records_limit = diagnostic.scanned_records;
        scanned_bytes_limit = diagnostic.scanned_ciphertext_bytes;
        snapshot_limit_ms = diagnostic.snapshot_lifetime_ms;
        deadline_ms = diagnostic.operation_deadline_ms;
    }
    if workload.page.offset > budget_manifest.defaults.maximum_offset {
        return emit_preflight_budget(candidate, workload, "ordering");
    }
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let schema = candidate.schema();
    let predicate = if candidate == Candidate::A {
        "TRUE".to_string()
    } else {
        compile_candidate_sql(&workload.candidate_ir, candidate)
            .unwrap_or_else(|| "TRUE".to_string())
    };
    let needs_body = expression_needs_body(&workload.candidate_ir)
        || workload
            .response_fields
            .iter()
            .any(|field| field == "body" || field == "document");
    let current = "p.record_revision=r.record_revision AND p.catalog_revision=c.active_catalog_revision AND p.projection_format_version=c.active_projection_format_version AND p.generation_id=c.active_generation_id AND g.status IN ('building','complete')";
    let sql = if candidate == Candidate::A {
        format!("SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id")
    } else if candidate.encrypted() {
        let exact = if needs_body {
            "r.exact_ciphertext".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_ciphertext END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_ciphertext,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    } else {
        let exact = if needs_body {
            "r.exact_markdown".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_markdown END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_markdown,r.path AS exact_path,r.file_mtime AS exact_file_mtime,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    };
    let started = Instant::now();
    let cancel_after = (workload.id == "sdk.cancel_broad_body_scan")
        .then_some(std::time::Duration::from_millis(50));
    let deadline = cancel_after.unwrap_or(std::time::Duration::from_millis(
        deadline_ms.min(snapshot_limit_ms),
    ));
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let mut database_rows = sqlx::query(AssertSqlSafe(sql))
        .bind(COLLECTION_ID)
        .fetch(&mut *transaction);
    let mut sql_candidate_rows = 0_usize;
    let mut documents_decrypted = 0_usize;
    let mut ciphertext_bytes = 0_u64;
    let mut plaintext_bytes = 0_u64;
    let mut decrypted_bytes_peak = 0_u64;
    let mut canonical_facts = Vec::new();
    let mut terminal_budget = None;
    let mut cancelled = false;
    loop {
        let Some(remaining) = deadline.checked_sub(started.elapsed()) else {
            if cancel_after.is_some() {
                cancelled = true;
            } else {
                terminal_budget = Some("time");
            }
            break;
        };
        let row = match tokio::time::timeout(remaining, database_rows.try_next()).await {
            Ok(result) => result?,
            Err(_) if cancel_after.is_some() => {
                cancelled = true;
                break;
            }
            Err(_) => {
                terminal_budget = Some("time");
                break;
            }
        };
        let Some(row) = row else { break };
        sql_candidate_rows += 1;
        if sql_candidate_rows > scanned_records_limit {
            terminal_budget = Some("scan");
            break;
        }
        let id: Uuid = row.get("record_id");
        let revision: String = row.get("record_revision");
        let (record, body, projection) = if candidate == Candidate::A {
            let ciphertext: Vec<u8> = row.get("exact_ciphertext");
            ciphertext_bytes += ciphertext.len() as u64;
            let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
            decrypted_bytes_peak = decrypted_bytes_peak.max(plaintext.len() as u64);
            plaintext_bytes += plaintext.len() as u64;
            let envelope: ExactEnvelope = serde_json::from_slice(&plaintext)?;
            documents_decrypted += 1;
            let canonical = CanonicalRecordInput {
                stable_id: Some(id.to_string()),
                path: envelope.path.clone(),
                file_size: envelope.document.len() as u64,
                file_mtime: Some(envelope.file_mtime.clone()),
                document: envelope.document.clone(),
            };
            let classified = catalog.classify_record(&canonical)?;
            let projection = catalog.benchmark_project_record(&canonical)?;
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
                let expected_digest = authority_projection_digest(
                    id,
                    &revision,
                    catalog.resource_revision(),
                    GENERATION_ID,
                    &projection,
                    &semantic.0,
                )?;
                let stored_digest: String = row.get("projection_digest");
                if stored_digest != expected_digest {
                    return Err(Error::Invalid(format!(
                        "projection digest verification failed for {id}"
                    )));
                }
                Some(projection)
            } else {
                None
            };
            let row_needs_body = if workload.provider_scans.is_empty() {
                needs_body
            } else {
                current_projection.as_ref().is_none_or(|projection| {
                    workload.provider_scans.iter().any(|scan| {
                        scan.include_body && scan.candidate_ir.evaluate_canonical(projection, "")
                    })
                })
            };
            let mut exact = None;
            if row_needs_body || !projection_current {
                if candidate.encrypted() {
                    let ciphertext: Vec<u8> = row.get("exact_ciphertext");
                    ciphertext_bytes += ciphertext.len() as u64;
                    let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
                    decrypted_bytes_peak = decrypted_bytes_peak.max(plaintext.len() as u64);
                    plaintext_bytes += plaintext.len() as u64;
                    exact = Some(serde_json::from_slice::<ExactEnvelope>(&plaintext)?);
                    documents_decrypted += 1;
                } else {
                    let document: String = row.get("exact_markdown");
                    plaintext_bytes += document.len() as u64;
                    exact = Some(ExactEnvelope {
                        path: row.get("exact_path"),
                        file_mtime: row
                            .get::<chrono::DateTime<chrono::Utc>, _>("exact_file_mtime")
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        document,
                    });
                }
            }
            let projection = if let Some(projection) = current_projection {
                projection
            } else {
                let envelope = exact.as_ref().ok_or_else(|| {
                    Error::Invalid("stale projection fallback has no exact record".to_string())
                })?;
                catalog.benchmark_project_record(&CanonicalRecordInput {
                    stable_id: Some(id.to_string()),
                    path: envelope.path.clone(),
                    document: envelope.document.clone(),
                    file_size: envelope.document.len() as u64,
                    file_mtime: Some(envelope.file_mtime.clone()),
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
                catalog
                    .classify_record(&CanonicalRecordInput {
                        stable_id: Some(id.to_string()),
                        path: envelope.path.clone(),
                        document: envelope.document.clone(),
                        file_size: envelope.document.len() as u64,
                        file_mtime: Some(envelope.file_mtime.clone()),
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
        if workload.candidate_ir.evaluate_canonical(&projection, &body) {
            canonical_facts.push(result_fact(
                workload,
                &record,
                &revision,
                &body,
                &projection,
            )?);
        }
        if ciphertext_bytes > scanned_bytes_limit || plaintext_bytes > scanned_bytes_limit {
            terminal_budget = Some("scan");
            break;
        }
        if decrypted_bytes_peak > budget_manifest.defaults.simultaneously_decrypted_bytes {
            terminal_budget = Some("scan");
            break;
        }
    }
    drop(database_rows);
    let snapshot_lifetime_ms = started.elapsed().as_secs_f64() * 1000.0;
    if cancelled || terminal_budget.is_some() {
        let cleanup_started = Instant::now();
        transaction.rollback().await?;
        pool.close().await;
        let cleanup_ms = cleanup_started.elapsed().as_secs_f64() * 1000.0;
        if cancelled {
            println!(
                "{}",
                json!({
                    "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                    "outcome":"cancelled","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                    "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                    "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                    "plaintext_bytes":plaintext_bytes,"cancellation_cleanup_ms":cleanup_ms,
                    "transaction_released":true,"pool_permit_released":true,"plaintext_released":true,
                    "snapshot_lifetime_ms":snapshot_lifetime_ms
                })
            );
            return Ok(());
        }
        let kind = terminal_budget.expect("checked above");
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                "outcome":"budget","budget_kind":kind,
                "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                "plaintext_bytes":plaintext_bytes,"snapshot_lifetime_ms":snapshot_lifetime_ms,
                "transaction_released":true,"pool_permit_released":true,"plaintext_released":true
            })
        );
        return Ok(());
    }
    transaction.commit().await?;
    let mut provider = HashMap::new();
    for scan in &workload.provider_scans {
        provider.insert(
            format!("{}:{}", workload.id, scan.id),
            canonical_facts
                .iter()
                .filter(|fact| match scan.id.as_str() {
                    "requests" => is_pickle_request(fact),
                    "responses" => !is_pickle_request(fact),
                    _ => true,
                })
                .cloned()
                .collect(),
        );
    }
    let canonical_fact_count = canonical_facts.len();
    let actual = expected_workload(workload, canonical_facts, &mut provider)?;
    let result_items = actual["returned"]
        .as_u64()
        .unwrap_or_else(|| actual["consumerResultCount"].as_u64().unwrap_or(0));
    let result_bytes = serde_json::to_vec(&actual)?.len() as u64;
    let group_count = actual["groups"].as_array().map_or(0, Vec::len);
    let group_bytes = actual["groups"]
        .as_array()
        .map(serde_json::to_vec)
        .transpose()?
        .map_or(0, |bytes| bytes.len() as u64);
    let budget_kind = if group_count > budget_manifest.defaults.groups
        || group_bytes > budget_manifest.defaults.aggregation_state_bytes
    {
        Some("groups")
    } else if result_items > budget_manifest.defaults.result_items
        || result_bytes > budget_manifest.defaults.result_bytes
    {
        Some("result")
    } else if canonical_fact_count > budget_manifest.defaults.top_k_entries
        && !workload.order.is_empty()
    {
        Some("ordering")
    } else {
        None
    };
    if let Some(budget_kind) = budget_kind {
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                "outcome":"budget","budget_kind":budget_kind,
                "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == budget_kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                "plaintext_bytes":plaintext_bytes,"result_items":result_items,"result_bytes":result_bytes,
                "snapshot_lifetime_ms":snapshot_lifetime_ms,"transaction_released":true,
                "pool_permit_released":true,"plaintext_released":true
            })
        );
        return Ok(());
    }
    let expected: Value =
        serde_json::from_reader(File::open(fixture_dir.join("expected-results.json"))?)?;
    let expected_workload = &expected["workloads"][workload_id];
    if &actual != expected_workload {
        return Err(Error::SeedMismatch(first_json_difference(
            "$",
            expected_workload,
            &actual,
        )));
    }
    println!(
        "{}",
        json!({
            "candidate":format!("{candidate:?}"),"workload_id":workload_id,"outcome":"success",
            "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"sql_candidate_rows":sql_candidate_rows,
            "canonical_rows_evaluated":sql_candidate_rows,"documents_decrypted":documents_decrypted,
            "ciphertext_bytes":ciphertext_bytes,"plaintext_bytes":plaintext_bytes,
            "result_items":result_items,"result_bytes":result_bytes,"completeness_digest":actual["orderedRecordIdsDigest"].clone(),
            "accounted_operator_bytes_peak":decrypted_bytes_peak.max(group_bytes),
            "snapshot_lifetime_ms":snapshot_lifetime_ms,"transaction_released":true,
            "pool_permit_released":true,"plaintext_released":true,
            "key_cache_misses":if candidate.encrypted() && documents_decrypted > 0 {1} else {0},
            "key_cache_hits":if candidate.encrypted() {documents_decrypted.saturating_sub(1)} else {0},
            "kms_unwraps":if candidate.encrypted() && documents_decrypted > 0 {1} else {0}
        })
    );
    Ok(())
}

fn emit_preflight_budget(
    candidate: Candidate,
    workload: &Workload,
    budget_kind: &str,
) -> Result<(), Error> {
    println!(
        "{}",
        json!({
            "candidate":format!("{candidate:?}"),"workload_id":workload.id,
            "outcome":"budget","budget_kind":budget_kind,
            "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == budget_kind),
            "elapsed_ms":0.0,"transaction_released":true,"pool_permit_released":true,
            "plaintext_released":true
        })
    );
    Ok(())
}

fn projection_from_row(
    row: &sqlx::postgres::PgRow,
    semantic: &Value,
) -> Result<BenchmarkProjection, Error> {
    let path: String = row.get("path");
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let (basename, extension) = name
        .rsplit_once('.')
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .unwrap_or((name.clone(), String::new()));
    Ok(BenchmarkProjection {
        schema_version: "hosted-benchmark-projection-v1".to_string(),
        path: path.clone(),
        types: row.get("types"),
        file: BenchmarkFileFacts {
            path,
            name,
            basename,
            extension,
            size: row.get::<i64, _>("file_size") as u64,
            mtime: row
                .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
        persisted_frontmatter: value_map(semantic, "persisted_frontmatter")?,
        effective_frontmatter: value_map(semantic, "effective_frontmatter")?,
        relationships: serde_json::from_value(semantic["relationships"].clone())?,
        diagnostics: serde_json::from_value::<Vec<BenchmarkDiagnostic>>(
            semantic["diagnostics"].clone(),
        )?,
    })
}

fn value_map(value: &Value, key: &str) -> Result<serde_json::Map<String, Value>, Error> {
    value
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| Error::Invalid(format!("projection has no {key} object")))
}

fn exact_aad(id: Uuid, revision: &str) -> Vec<u8> {
    format!("mdbase-hosted-benchmark-v1:{COLLECTION_ID}:{id}:{revision}").into_bytes()
}

fn decrypt_exact(id: Uuid, revision: &str, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    if ciphertext.len() < 12 {
        return Err(Error::Invalid("short benchmark ciphertext".to_string()));
    }
    let cipher = Aes256Gcm::new_from_slice(&DATA_KEY)
        .map_err(|_| Error::Invalid("invalid benchmark key".to_string()))?;
    let nonce = Nonce::try_from(&ciphertext[..12])
        .map_err(|_| Error::Invalid("invalid benchmark nonce".to_string()))?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext[12..],
                aad: &exact_aad(id, revision),
            },
        )
        .map_err(|_| Error::Invalid("benchmark decryption failed".to_string()))
}

fn expression_needs_body(expression: &CandidateExpression) -> bool {
    match expression {
        CandidateExpression::BodyContains { .. } => true,
        CandidateExpression::All { all } | CandidateExpression::Any { any: all } => {
            all.iter().any(expression_needs_body)
        }
        CandidateExpression::Not { not } => expression_needs_body(not),
        _ => false,
    }
}

struct SqlCandidate {
    sql: String,
    exact: bool,
}

fn compile_candidate_sql(expression: &CandidateExpression, candidate: Candidate) -> Option<String> {
    compile_sql(expression, candidate).map(|value| value.sql)
}

fn compile_sql(expression: &CandidateExpression, candidate: Candidate) -> Option<SqlCandidate> {
    match expression {
        CandidateExpression::All { all } => {
            let values = all
                .iter()
                .filter_map(|item| compile_sql(item, candidate))
                .collect::<Vec<_>>();
            Some(SqlCandidate {
                sql: if values.is_empty() {
                    "TRUE".to_string()
                } else {
                    format!(
                        "({})",
                        values
                            .iter()
                            .map(|v| v.sql.as_str())
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    )
                },
                exact: values.len() == all.len() && values.iter().all(|v| v.exact),
            })
        }
        CandidateExpression::Any { any } => {
            let values = any
                .iter()
                .map(|item| compile_sql(item, candidate))
                .collect::<Vec<_>>();
            if values.iter().any(Option::is_none) {
                None
            } else {
                let values = values.into_iter().flatten().collect::<Vec<_>>();
                Some(SqlCandidate {
                    sql: format!(
                        "({})",
                        values
                            .iter()
                            .map(|v| v.sql.as_str())
                            .collect::<Vec<_>>()
                            .join(" OR ")
                    ),
                    exact: values.iter().all(|v| v.exact),
                })
            }
        }
        CandidateExpression::Not { not } => compile_sql(not, candidate).and_then(|value| {
            value.exact.then(|| SqlCandidate {
                sql: format!("NOT ({})", value.sql),
                exact: true,
            })
        }),
        CandidateExpression::TypeIn { type_in } => Some(SqlCandidate {
            sql: format!(
                "p.types && ARRAY[{}]::text[]",
                type_in
                    .iter()
                    .map(|v| quote(v))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            exact: true,
        }),
        CandidateExpression::FieldEq { field_eq } => json_compare(&field_eq.0, &field_eq.1, "="),
        CandidateExpression::FieldIn { field_in } => Some(SqlCandidate {
            sql: format!(
                "({})",
                field_in
                    .1
                    .iter()
                    .filter_map(|v| json_compare(&field_in.0, v, "="))
                    .map(|v| v.sql)
                    .collect::<Vec<_>>()
                    .join(" OR ")
            ),
            exact: true,
        }),
        CandidateExpression::FieldContains { field_contains } => {
            json_contains(&field_contains.0, &field_contains.1)
        }
        CandidateExpression::FieldContainsText {
            field_contains_text,
        } => field_text_sql(&field_contains_text.0).map(|field| SqlCandidate {
            sql: format!(
                "lower({field}) LIKE {} ESCAPE E'\\\\'",
                quote(&format!(
                    "%{}%",
                    escape_like(&field_contains_text.1.to_lowercase())
                ))
            ),
            exact: true,
        }),
        CandidateExpression::FieldLt { field_lt } => json_compare(&field_lt.0, &field_lt.1, "<"),
        CandidateExpression::RelationshipTargetEq {
            relationship_target_eq,
        } => Some(SqlCandidate {
            sql: format!(
                "p.semantic_projection @> {}::jsonb",
                quote(&json!({"relationships":[{"target":relationship_target_eq}]}).to_string())
            ),
            exact: true,
        }),
        CandidateExpression::BodyContains { body_contains } if !candidate.encrypted() => {
            Some(SqlCandidate {
                sql: format!(
                    "r.exact_markdown ILIKE {} ESCAPE E'\\\\'",
                    quote(&format!("%{}%", escape_like(body_contains)))
                ),
                exact: true,
            })
        }
        CandidateExpression::BodyContains { .. } => None,
    }
}

fn field_text_sql(path: &str) -> Option<String> {
    if path == "path" {
        Some("p.path".to_string())
    } else if path == "file.basename" {
        Some("regexp_replace(regexp_replace(p.path, '^.*/', ''), '\\.[^.]+$', '')".to_string())
    } else if path == "file.mtime" {
        Some("p.file_mtime::text".to_string())
    } else {
        let parts = path.split('.').collect::<Vec<_>>();
        matches!(
            parts.first(),
            Some(&"persisted_frontmatter") | Some(&"effective_frontmatter")
        )
        .then(|| format!("p.semantic_projection #>> '{{{}}}'", parts.join(",")))
    }
}

fn json_compare(path: &str, value: &Value, operator: &str) -> Option<SqlCandidate> {
    let field = field_text_sql(path)?;
    let sql = match value {
        Value::Number(number) => format!("({field})::numeric {operator} {number}"),
        Value::Bool(boolean) => format!("({field})::boolean {operator} {boolean}"),
        Value::String(string) => format!("{field} {operator} {}", quote(string)),
        _ => return None,
    };
    Some(SqlCandidate { sql, exact: true })
}
fn json_contains(path: &str, value: &Value) -> Option<SqlCandidate> {
    let parts = path.split('.').collect::<Vec<_>>();
    if !matches!(
        parts.first(),
        Some(&"persisted_frontmatter") | Some(&"effective_frontmatter")
    ) {
        return None;
    }
    let mut nested = json!([value]);
    for key in parts.iter().skip(1).rev() {
        nested = json!({*key:nested});
    }
    nested = json!({parts[0]:nested});
    Some(SqlCandidate {
        sql: format!(
            "p.semantic_projection @> {}::jsonb",
            quote(&nested.to_string())
        ),
        exact: true,
    })
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

async fn storage_metrics(database_url: &str, candidate: Candidate) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let rows = sqlx::query("SELECT c.relname,pg_relation_size(c.oid)::bigint AS table_bytes,CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::bigint AS toast_bytes,pg_indexes_size(c.oid)::bigint AS index_bytes,pg_total_relation_size(c.oid)::bigint AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname")
        .bind(candidate.schema()).fetch_all(&pool).await?;
    let relations = rows.iter().map(|row| json!({"relation":row.get::<String,_>("relname"),"table_bytes":row.get::<i64,_>("table_bytes"),"toast_bytes":row.get::<i64,_>("toast_bytes"),"index_bytes":row.get::<i64,_>("index_bytes"),"total_bytes":row.get::<i64,_>("total_bytes")})).collect::<Vec<_>>();
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"candidate":format!("{candidate:?}"),"database_bytes":sqlx::query_scalar::<_,i64>("SELECT pg_database_size(current_database())::bigint").fetch_one(&pool).await?,"relations":relations})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_encryption_binds_identity_revision_and_plaintext_nonce() {
        let id = Uuid::from_u128(7);
        let first = encrypt_exact(id, "sha256:r1", b"first").unwrap();
        let second = encrypt_exact(id, "sha256:r1", b"second").unwrap();
        assert_ne!(&first[..12], &second[..12]);
        assert_eq!(decrypt_exact(id, "sha256:r1", &first).unwrap(), b"first");
        assert!(decrypt_exact(Uuid::from_u128(8), "sha256:r1", &first).is_err());
        assert!(decrypt_exact(id, "sha256:r2", &first).is_err());
    }

    #[test]
    fn sql_like_literals_cannot_become_wildcards() {
        assert_eq!(escape_like(r"10%_done\now"), r"10\%\_done\\now");
        let expression: CandidateExpression = serde_json::from_value(json!({
            "bodyContains": "%_"
        }))
        .unwrap();
        let sql = compile_candidate_sql(&expression, Candidate::CNoGin).unwrap();
        assert!(sql.contains(r"%\%\_%"));
        assert!(sql.contains("ESCAPE"));
    }

    #[test]
    fn typed_json_comparisons_do_not_use_lexicographic_number_order() {
        let number = json_compare("effective_frontmatter.priority", &json!(10), "<").unwrap();
        let boolean = json_compare("effective_frontmatter.archived", &json!(false), "=").unwrap();
        assert!(number.sql.contains("::numeric"));
        assert!(boolean.sql.contains("::boolean"));
    }

    #[test]
    fn frozen_budget_manifest_deserializes_without_raising_defaults() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../config/hosted-execution-budgets.json");
        let manifest: BudgetManifest = serde_json::from_reader(File::open(path).unwrap()).unwrap();
        assert_eq!(manifest.defaults.scanned_records, 100_000);
        assert_eq!(manifest.defaults.operation_deadline_ms, 30_000);
        assert_eq!(manifest.defaults.result_items, 10_000);
        assert_eq!(manifest.defaults.simultaneously_decrypted_bytes, 8_388_608);
    }

    #[test]
    fn projection_digest_rejects_record_and_generation_substitution() {
        let projection = BenchmarkProjection {
            schema_version: "hosted-benchmark-projection-v1".to_string(),
            path: "notes/one.md".to_string(),
            types: vec!["note".to_string()],
            file: BenchmarkFileFacts {
                path: "notes/one.md".to_string(),
                name: "one.md".to_string(),
                basename: "one".to_string(),
                extension: "md".to_string(),
                size: 4,
                mtime: "2026-01-01T00:00:00.000Z".to_string(),
            },
            persisted_frontmatter: Default::default(),
            effective_frontmatter: Default::default(),
            relationships: vec![],
            diagnostics: vec![],
        };
        let semantic = semantic_projection(&projection);
        let first = authority_projection_digest(
            Uuid::from_u128(1),
            "sha256:r1",
            "sha256:c1",
            Uuid::from_u128(2),
            &projection,
            &semantic,
        )
        .unwrap();
        let substituted = authority_projection_digest(
            Uuid::from_u128(3),
            "sha256:r1",
            "sha256:c1",
            Uuid::from_u128(4),
            &projection,
            &semantic,
        )
        .unwrap();
        assert_ne!(first, substituted);
    }
}
