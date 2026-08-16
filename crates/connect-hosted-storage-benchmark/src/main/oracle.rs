fn project_all(fixture_dir: &Path) -> Result<(), Error> {
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id),
            path: record.path,
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime),
            document: record.document,
        };
        serde_json::to_writer(&mut output, &catalog.benchmark_project_record(&canonical)?)?;
        output.write_all(b"\n")?;
    }
    Ok(())
}

fn project_record(fixture_dir: &Path, record_index: usize) -> Result<(), Error> {
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let line = BufReader::new(File::open(fixture_dir.join("records.ndjson"))?)
        .lines()
        .nth(record_index)
        .ok_or_else(|| Error::Invalid(format!("record index does not exist: {record_index}")))??;
    let record: RecordLine = serde_json::from_str(&line)?;
    let canonical = CanonicalRecordInput {
        stable_id: Some(record.record_id),
        path: record.path,
        file_size: record.document.len() as u64,
        file_mtime: Some(record.file_mtime),
        document: record.document,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&catalog.benchmark_project_record(&canonical)?)?
    );
    Ok(())
}

fn run_oracle(
    fixture_dir: &Path,
    workload_path: &Path,
    output: &Path,
    mdbase_revision: &str,
    mdbase_dirty: bool,
) -> Result<(), Error> {
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let mut facts = contract
        .query_workloads
        .iter()
        .map(|workload| (workload.id.clone(), Vec::new()))
        .collect::<HashMap<_, _>>();
    let mut provider_facts = HashMap::<String, Vec<Fact>>::new();
    for workload in &contract.query_workloads {
        for scan in &workload.provider_scans {
            provider_facts.insert(format!("{}:{}", workload.id, scan.id), Vec::new());
        }
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
        for workload in &contract.query_workloads {
            if workload
                .candidate_ir
                .evaluate_canonical(&projection, &classified.body)
            {
                facts
                    .get_mut(&workload.id)
                    .expect("workload accumulator exists")
                    .push(result_fact(
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
                    provider_facts
                        .get_mut(&format!("{}:{}", workload.id, scan.id))
                        .expect("provider accumulator exists")
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
    }

    let mut workloads = BTreeMap::new();
    for workload in &contract.query_workloads {
        workloads.insert(
            workload.id.clone(),
            expected_workload(
                workload,
                facts.remove(&workload.id).expect("workload facts exist"),
                &mut provider_facts,
            )?,
        );
    }
    let artifact = ExpectedArtifact {
        schema_version: 2,
        oracle: format!("mdbase-rs-{}@{mdbase_revision}", mdbase::VERSION),
        workloads,
        mutations: mutation_oracles(),
    };
    let generated = serde_json::to_value(&artifact)?;
    let seed_path = fixture_dir.join("expected-results.json");
    let seed: Value = serde_json::from_reader(File::open(&seed_path)?)?;
    let mut normalized = seed.clone();
    normalized["oracle"] = generated["oracle"].clone();
    if normalized != generated {
        return Err(Error::SeedMismatch(first_json_difference(
            "$",
            &normalized,
            &generated,
        )));
    }
    let mut artifact_bytes = serde_json::to_vec_pretty(&artifact)?;
    artifact_bytes.push(b'\n');
    File::create(output)?.write_all(&artifact_bytes)?;
    let manifest_path = fixture_dir.join("fixture-manifest.json");
    let mut manifest: Value = serde_json::from_reader(File::open(&manifest_path)?)?;
    manifest["expectedResultsSha256"] =
        Value::String(format!("{:x}", Sha256::digest(&artifact_bytes)));
    manifest["oracle"] = json!({
        "engine": format!("mdbase-rs-{}", mdbase::VERSION),
        "revision": mdbase_revision,
        "dirty": mdbase_dirty,
        "independentSeedVerified": true
    });
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    manifest_bytes.push(b'\n');
    File::create(manifest_path)?.write_all(&manifest_bytes)?;
    Ok(())
}

fn run_oracle_v2(
    fixture_dir: &Path,
    workload_path: &Path,
    output: &Path,
    mdbase_revision: &str,
) -> Result<(), Error> {
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources-v2.ndjson"))?;
    let mut facts = contract
        .query_workloads
        .iter()
        .map(|workload| (workload.id.clone(), Vec::new()))
        .collect::<HashMap<_, _>>();
    let mut provider_facts = HashMap::<String, Vec<Fact>>::new();
    for workload in &contract.query_workloads {
        for scan in &workload.provider_scans {
            provider_facts.insert(format!("{}:{}", workload.id, scan.id), Vec::new());
        }
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
        for workload in &contract.query_workloads {
            if workload
                .candidate_ir
                .evaluate_canonical(&projection, &classified.body)
            {
                facts
                    .get_mut(&workload.id)
                    .expect("workload exists")
                    .push(result_fact(
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
                    provider_facts
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
    }
    let mut workloads = BTreeMap::new();
    for workload in &contract.query_workloads {
        workloads.insert(
            workload.id.clone(),
            expected_workload(
                workload,
                facts.remove(&workload.id).expect("facts exist"),
                &mut provider_facts,
            )?,
        );
    }
    let artifact = ExpectedArtifact {
        schema_version: 2,
        oracle: format!(
            "mdbase-rs-{}@{mdbase_revision}-resources-v2",
            mdbase::VERSION
        ),
        workloads,
        mutations: mutation_oracles(),
    };
    let mut bytes = serde_json::to_vec_pretty(&artifact)?;
    bytes.push(b'\n');
    File::create(output)?.write_all(&bytes)?;
    Ok(())
}

fn compile_fixture_catalog(path: &Path) -> Result<CompiledCatalog, Error> {
    let bytes = std::fs::read(path)?;
    compile_catalog_bytes(&bytes)
}

fn compile_catalog_bytes(bytes: &[u8]) -> Result<CompiledCatalog, Error> {
    let mut configuration_document = None;
    let mut types = Vec::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let resource: ResourceLine = serde_json::from_slice(line)?;
        match resource.kind.as_str() {
            "configuration" => configuration_document = Some(resource.document),
            "type" => {
                let parsed = parse_document(&resource.document);
                let FrontmatterState::Mapping(mapping) = parsed.frontmatter_state() else {
                    return Err(Error::Invalid(format!(
                        "type resource has invalid frontmatter: {}",
                        resource.path
                    )));
                };
                let definition = serde_json::to_value(mapping)?;
                let schema = definition
                    .pointer("/schema/value")
                    .cloned()
                    .ok_or_else(|| {
                        Error::Invalid(format!("type has no schema: {}", resource.path))
                    })?;
                types.push(ResolvedTypeResource {
                    path: resource.path,
                    revision: format!("sha256:{:x}", Sha256::digest(resource.document.as_bytes())),
                    definition,
                    schema,
                });
            }
            other => {
                return Err(Error::Invalid(format!(
                    "unsupported resource kind: {other}"
                )))
            }
        }
    }
    CompiledCatalog::compile(CatalogInput {
        resource_revision: format!("sha256:{:x}", Sha256::digest(bytes)),
        configuration_document: configuration_document
            .ok_or_else(|| Error::Invalid("missing configuration resource".to_string()))?,
        types,
        contracts: Vec::new(),
    })
    .map_err(Error::from)
}

fn result_fact(
    workload: &Workload,
    record: &RecordLine,
    revision: &str,
    body: &str,
    projection: &BenchmarkProjection,
) -> Result<Fact, Error> {
    let response = workload
        .response_fields
        .iter()
        .map(|path| {
            Ok((
                path.clone(),
                response_field(path, record, revision, body, projection),
            ))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let response_bytes = serde_jcs::to_vec(&response)?;
    let response_without_body = response
        .iter()
        .filter(|(path, _)| path != "body" && path != "document")
        .cloned()
        .collect::<Vec<_>>();
    Ok(Fact {
        record_id: record.record_id.clone(),
        path: record.path.clone(),
        sort: workload
            .order
            .iter()
            .map(|order| response_field(&order.field, record, revision, body, projection))
            .collect(),
        response_digest: format!("{:x}", Sha256::digest(response_bytes)),
        response_digest_without_body: format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(&response_without_body)?)
        ),
        client_residual: workload
            .client_residual
            .as_ref()
            .is_none_or(|expression| expression.evaluate_canonical(projection, body)),
        residual_match: workload
            .canonical_residual
            .as_ref()
            .is_none_or(|expression| expression.evaluate_canonical(projection, body)),
        group: workload
            .group
            .iter()
            .map(|group| response_field(&group.field, record, revision, body, projection))
            .collect(),
        types: projection.types.clone(),
        status: projection.effective_frontmatter.get("status").cloned(),
        relationships: projection.relationships.clone(),
        source_identity: projection
            .effective_frontmatter
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn response_field(
    path: &str,
    record: &RecordLine,
    revision: &str,
    body: &str,
    projection: &BenchmarkProjection,
) -> Value {
    match path {
        "body" => Value::String(body.to_string()),
        "revision" | "document_revision" => Value::String(revision.to_string()),
        "document" => Value::String(record.document.clone()),
        "relationships" => serde_json::to_value(&projection.relationships).unwrap(),
        value if value.starts_with("groups.") || value.starts_with("meta.") => Value::Null,
        _ => projection_field(projection, path).unwrap_or(Value::Null),
    }
}

fn projection_field(projection: &BenchmarkProjection, path: &str) -> Option<Value> {
    let value = serde_json::to_value(projection).ok()?;
    path.split('.')
        .try_fold(&value, |current, segment| current.get(segment))
        .cloned()
}

fn expected_workload(
    workload: &Workload,
    candidate_facts: Vec<Fact>,
    provider_facts: &mut HashMap<String, Vec<Fact>>,
) -> Result<Value, Error> {
    let provider_scans = if workload.provider_scans.is_empty() {
        vec![provider_scan_value(
            "candidate",
            workload.response_fields.iter().any(|field| field == "body"),
            candidate_facts.clone(),
            &workload.page,
            &workload.order,
        )]
    } else {
        workload
            .provider_scans
            .iter()
            .map(|scan| {
                provider_scan_value(
                    &scan.id,
                    scan.include_body,
                    provider_facts
                        .remove(&format!("{}:{}", workload.id, scan.id))
                        .expect("provider facts exist"),
                    &scan.page,
                    &scan.order,
                )
            })
            .collect()
    };
    let canonical_residual_matches = candidate_facts
        .iter()
        .filter(|fact| fact.residual_match)
        .count();
    let mut facts = candidate_facts
        .iter()
        .filter(|fact| fact.residual_match && fact.client_residual)
        .cloned()
        .collect::<Vec<_>>();
    let client_residual_matches = facts.len();
    match workload
        .consumer_transform
        .as_ref()
        .map(|value| value.kind.as_str())
    {
        Some("readerContentMergeBySource") => facts = reader_merge(facts),
        Some("picklePendingByResponseMultiplicity") => facts = pickle_transform(facts, true),
        Some("pickleAllRequestsWithResponseMultiplicity") => facts = pickle_transform(facts, false),
        Some(other) => {
            return Err(Error::Invalid(format!(
                "unknown consumer transform: {other}"
            )))
        }
        None => {}
    }
    let acceptable = acceptable_outcomes(workload);
    if !workload.group.is_empty() {
        let mut groups = BTreeMap::<String, usize>::new();
        for fact in &facts {
            *groups
                .entry(serde_json::to_string(&fact.group)?)
                .or_default() += 1;
        }
        let digest_values = groups
            .iter()
            .map(|(key, count)| format!("{key}:{count}"))
            .collect::<Vec<_>>();
        return Ok(json!({
            "canonicalOutcome": "success",
            "acceptableRunOutcomes": acceptable,
            "providerScans": provider_scans,
            "candidateRows": candidate_facts.len(),
            "canonicalResidualMatches": canonical_residual_matches,
            "clientResidualMatches": client_residual_matches,
            "consumerResultCount": facts.len(),
            "totalMatches": facts.len(),
            "groups": groups.into_iter().map(|(key, count)| json!({"key": serde_json::from_str::<Value>(&key).unwrap(), "count": count})).collect::<Vec<_>>(),
            "completenessDigest": digest_values_lines(&digest_values)
        }));
    }
    facts.sort_by(|left, right| compare_facts(left, right, &workload.order));
    let selected = select_page_domain(&facts, &workload.page);
    let pages = page_facts(&selected, &workload.page);
    Ok(json!({
        "canonicalOutcome": "success",
        "acceptableRunOutcomes": acceptable,
        "providerScans": provider_scans,
        "candidateRows": candidate_facts.len(),
        "canonicalResidualMatches": canonical_residual_matches,
        "clientResidualMatches": client_residual_matches,
        "consumerResultCount": facts.len(),
        "totalMatches": facts.len(),
        "returned": selected.len(),
        "pageCount": pages.len(),
        "pages": pages,
        "firstRecordId": selected.first().map(|fact| fact.record_id.clone()),
        "lastRecordId": selected.last().map(|fact| fact.record_id.clone()),
        "orderedRecordIdsDigest": digest_values_lines(&selected.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>()),
        "responseFieldsDigest": digest_values_lines(&selected.iter().map(|fact| fact.response_digest.clone()).collect::<Vec<_>>())
    }))
}

fn provider_scan_value(
    id: &str,
    include_body: bool,
    mut facts: Vec<Fact>,
    page: &Page,
    order: &[Order],
) -> Value {
    if !include_body {
        for fact in &mut facts {
            fact.response_digest = fact.response_digest_without_body.clone();
        }
    }
    facts.sort_by(|left, right| compare_facts(left, right, order));
    let selected = select_page_domain(&facts, page);
    json!({
        "id": id,
        "rows": facts.len(),
        "includeBody": include_body,
        "pages": page_facts(&selected, page),
        "orderedRecordIdsDigest": digest_values_lines(&selected.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>())
    })
}

fn reader_merge(facts: Vec<Fact>) -> Vec<Fact> {
    let mut merged = BTreeMap::<String, (Vec<String>, Vec<String>)>::new();
    for fact in facts {
        let source = if fact.types.iter().any(|value| value == "reader-source") {
            fact.source_identity
        } else {
            fact.relationships
                .iter()
                .find(|value| value.kind == "source")
                .map(|value| value.target.clone())
        };
        let Some(source) = source else { continue };
        let entry = merged.entry(source).or_default();
        entry
            .0
            .push(if fact.types.iter().any(|value| value == "reader-source") {
                "source-note".to_string()
            } else {
                "annotation".to_string()
            });
        entry.1.push(fact.response_digest);
    }
    merged
        .into_iter()
        .map(|(source, (mut kinds, mut digests))| {
            kinds.sort();
            kinds.dedup();
            digests.sort();
            let response_digest = format!(
                "{:x}",
                Sha256::digest(
                    serde_jcs::to_vec(
                        &json!({"source": source, "kinds": kinds, "records": digests})
                    )
                    .unwrap()
                )
            );
            Fact {
                record_id: source.clone(),
                path: source.clone(),
                sort: vec![Value::String(source)],
                response_digest,
                response_digest_without_body: String::new(),
                client_residual: true,
                residual_match: true,
                group: vec![],
                types: vec![],
                status: None,
                relationships: vec![],
                source_identity: None,
            }
        })
        .collect()
}

fn pickle_transform(facts: Vec<Fact>, pending_only: bool) -> Vec<Fact> {
    let mut responses = HashMap::<String, usize>::new();
    for fact in facts.iter().filter(|fact| !is_pickle_request(fact)) {
        if let Some(target) = fact
            .relationships
            .iter()
            .find(|value| value.kind == "request")
            .map(|value| value.target.clone())
        {
            *responses.entry(target).or_default() += 1;
        }
    }
    facts
        .into_iter()
        .filter(is_pickle_request)
        .filter_map(|mut fact| {
            let count = responses.get(&fact.path).copied().unwrap_or_default();
            if pending_only {
                if fact.status.as_ref().and_then(Value::as_str) == Some("cancelled") || count != 0 {
                    return None;
                }
            } else {
                fact.response_digest = format!(
                    "{:x}",
                    Sha256::digest(format!("{}:{count}", fact.response_digest).as_bytes())
                );
            }
            Some(fact)
        })
        .collect()
}

fn is_pickle_request(fact: &Fact) -> bool {
    fact.types.iter().any(|value| value == "pickle_request")
}

fn acceptable_outcomes(workload: &Workload) -> Vec<String> {
    workload
        .acceptable_run_outcomes
        .iter()
        .cloned()
        .chain(
            workload
                .acceptable_budget_kinds
                .iter()
                .map(|kind| format!("budget:{kind}")),
        )
        .chain(
            workload
                .acceptable_error_codes
                .iter()
                .map(|code| format!("error:{code}")),
        )
        .collect()
}

fn compare_facts(left: &Fact, right: &Fact, order: &[Order]) -> Ordering {
    for (index, specification) in order.iter().enumerate() {
        let compared = compare_values(&left.sort[index], &right.sort[index], &specification.nulls);
        if compared != Ordering::Equal {
            return if specification.direction == "desc" {
                compared.reverse()
            } else {
                compared
            };
        }
    }
    left.record_id.cmp(&right.record_id)
}

fn compare_values(left: &Value, right: &Value, nulls: &str) -> Ordering {
    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => {
            if nulls == "first" {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (_, Value::Null) => {
            if nulls == "first" {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (Value::Number(left), Value::Number(right)) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(Ordering::Equal),
        (Value::String(left), Value::String(right)) => left.cmp(right),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

fn select_page_domain<'a>(facts: &'a [Fact], page: &Page) -> Vec<&'a Fact> {
    let first_limit = page.limit.or(page.first_limit).unwrap_or(facts.len());
    let start = page.offset.min(facts.len());
    let end = if page.repeat_to_completion {
        facts.len()
    } else {
        start.saturating_add(first_limit).min(facts.len())
    };
    facts[start..end].iter().collect()
}

fn page_facts(selected: &[&Fact], page: &Page) -> Vec<Value> {
    let first_limit = page.limit.or(page.first_limit).unwrap_or(selected.len());
    let subsequent_limit = page.subsequent_limit.unwrap_or(first_limit);
    let mut output = Vec::new();
    let mut start = 0;
    while start < selected.len() {
        let limit = if output.is_empty() {
            first_limit
        } else {
            subsequent_limit
        };
        let values = &selected[start..start.saturating_add(limit).min(selected.len())];
        output.push(json!({
            "page": output.len(),
            "count": values.len(),
            "firstRecordId": values.first().map(|fact| fact.record_id.clone()),
            "lastRecordId": values.last().map(|fact| fact.record_id.clone()),
            "orderedRecordIdsDigest": digest_values_lines(&values.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>()),
            "responseFieldsDigest": digest_values_lines(&values.iter().map(|fact| fact.response_digest.clone()).collect::<Vec<_>>())
        }));
        start += limit;
    }
    output
}

fn digest_values_lines(values: &[String]) -> String {
    let mut digest = Sha256::new();
    for value in values {
        digest.update(value.as_bytes());
        digest.update(b"\n");
    }
    format!("sha256:{:x}", digest.finalize())
}

fn mutation_oracles() -> Value {
    json!({
        "point.exact_read": { "targetIndex": 1, "assertion": "exact document and canonical read envelope" },
        "write.body_only": { "targetIndex": 2, "append": "\nBenchmark body-only update.\n", "semanticPayloadChanged": false, "bindingAndFileFactsChanged": true },
        "write.frontmatter": { "targetIndex": 3, "patch": { "status": "done", "tags": ["hosted", "benchmark-updated"], "projects": ["project-7"] }, "semanticPayloadChanged": true },
        "write.path": { "targetIndex": 60, "destination": "notes/renamed-benchmark-note.md", "semanticPayloadChanged": true },
        "write.resource_rebuild": { "fromCatalogVersion": 1, "toCatalogVersion": 2, "defaultPatch": { "benchmark_generation": 2 } },
        "write.recovery": { "targetIndex": 4, "failureStages": ["before_exact_write", "after_exact_write", "after_projection_write", "before_checkpoint", "after_checkpoint"] },
        "authorization.stale_projection": { "targetIndex": 5, "assertion": "current projection or exact canonical fallback; otherwise fail closed" }
    })
}

fn first_json_difference(path: &str, left: &Value, right: &Value) -> String {
    if left == right {
        return "no difference".to_string();
    }
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys()) {
                if left.get(key) != right.get(key) {
                    return first_json_difference(
                        &format!("{path}.{key}"),
                        left.get(key).unwrap_or(&Value::Null),
                        right.get(key).unwrap_or(&Value::Null),
                    );
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().max(right.len()) {
                if left.get(index) != right.get(index) {
                    return first_json_difference(
                        &format!("{path}[{index}]"),
                        left.get(index).unwrap_or(&Value::Null),
                        right.get(index).unwrap_or(&Value::Null),
                    );
                }
            }
        }
        _ => {}
    }
    format!("{path}: seed={left} oracle={right}")
}

