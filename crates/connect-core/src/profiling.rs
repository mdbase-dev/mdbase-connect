use crate::{CollectionRegistry, ConnectError};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Instant;

/// Transport-free options for profiling the local Connect authority path.
#[derive(Clone, Copy, Debug)]
pub struct ProfileOptions {
    pub scenario: ProfileScenario,
    pub iterations: usize,
    pub concurrency: usize,
}

impl Default for ProfileOptions {
    fn default() -> Self {
        Self {
            scenario: ProfileScenario::All,
            iterations: 3,
            concurrency: 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileScenario {
    Query,
    Views,
    Editor,
    Concurrent,
    All,
}

#[derive(Debug, Serialize)]
pub struct ProfileReport {
    pub tool: &'static str,
    pub version: &'static str,
    pub scenario: &'static str,
    pub iterations: usize,
    pub concurrency: usize,
    pub operations: Vec<ProfileSummary>,
}

#[derive(Debug, Serialize)]
pub struct ProfileSummary {
    pub name: &'static str,
    pub iterations: usize,
    pub total_ms: f64,
    pub min_ms: f64,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub operations_per_second: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests_per_iteration: Option<usize>,
}

/// Run a read-only local-authority workload and return its payload-free report.
pub fn run(options: ProfileOptions, collection_root: &Path) -> Result<ProfileReport, String> {
    if options.iterations == 0 || options.concurrency == 0 {
        return Err("--iterations and --concurrency must be greater than zero".to_string());
    }
    let collection = collection_root
        .canonicalize()
        .map_err(|error| format!("collection could not be resolved: {error}"))?;
    let state = tempfile::tempdir().map_err(|error| error.to_string())?;
    let registry = CollectionRegistry::open(state.path()).map_err(|error| error.to_string())?;
    let registered = registry
        .add(collection)
        .map_err(|error| error.to_string())?;

    // Establish the query cache and find a stable read target outside the
    // measured samples.
    let warmup = query(&registry, registered.id, 1, 0, false, None)?;
    let read_path = warmup
        .pointer("/result/results/0/file/path")
        .or_else(|| warmup.pointer("/result/results/0/path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let record_count = warmup
        .pointer("/result/meta/total_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let mut operations = Vec::new();
    if matches!(
        options.scenario,
        ProfileScenario::Query | ProfileScenario::All
    ) {
        operations.push(run_samples("query_page_200", options.iterations, || {
            query(&registry, registered.id, 200, 0, false, None).map(|_| ())
        })?);
        if let Some(path) = &read_path {
            operations.push(run_samples("read", options.iterations, || {
                ensure_success(registry.operation(registered.id, "read", &json!({"path": path})))
            })?);
        }
    }
    if matches!(
        options.scenario,
        ProfileScenario::Editor | ProfileScenario::All
    ) {
        let mut summary = run_samples("editor_two_pass_index", options.iterations, || {
            editor_index(&registry, registered.id).map(|_| ())
        })?;
        let pages_after_first = record_count.saturating_sub(200).div_ceil(1_000);
        summary.requests_per_iteration = Some(((1 + pages_after_first) * 2) as usize);
        operations.push(summary);
    }
    if matches!(
        options.scenario,
        ProfileScenario::Views | ProfileScenario::All
    ) {
        let listed = registry
            .operation(registered.id, "list_views", &json!({}))
            .map_err(|error| error.to_string())?;
        ensure_output_success(&listed)?;
        let targets = view_targets(&listed);
        if matches!(options.scenario, ProfileScenario::Views) && targets.is_empty() {
            return Err("the collection does not expose any saved views".to_string());
        }
        operations.push(run_samples("view_list", options.iterations, || {
            ensure_success(registry.operation(registered.id, "list_views", &json!({})))
        })?);
        for (format, path, view) in targets {
            let name = if format == "obsidian.base" {
                "view_execute_obsidian"
            } else {
                "view_execute_canonical"
            };
            operations.push(run_samples(name, options.iterations, || {
                ensure_success(registry.operation(
                    registered.id,
                    "execute_view",
                    &json!({"path": path, "view": view, "limit": 200}),
                ))
            })?);
        }
    }
    if matches!(
        options.scenario,
        ProfileScenario::Concurrent | ProfileScenario::All
    ) {
        let mut samples = Vec::with_capacity(options.iterations);
        for _ in 0..options.iterations {
            let barrier = Arc::new(Barrier::new(options.concurrency + 1));
            let handles = (0..options.concurrency)
                .map(|_| {
                    let registry = registry.clone();
                    let barrier = barrier.clone();
                    let collection_id = registered.id;
                    thread::spawn(move || {
                        barrier.wait();
                        query(&registry, collection_id, 200, 0, false, None).map(|_| ())
                    })
                })
                .collect::<Vec<_>>();
            let started = Instant::now();
            barrier.wait();
            for handle in handles {
                handle
                    .join()
                    .map_err(|_| "concurrent query worker panicked".to_string())??;
            }
            samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        let mut summary = summarize("concurrent_query_batch", samples);
        summary.requests_per_iteration = Some(options.concurrency);
        operations.push(summary);
    }

    Ok(ProfileReport {
        tool: "mdbase-profile-connect",
        version: env!("CARGO_PKG_VERSION"),
        scenario: match options.scenario {
            ProfileScenario::Query => "query",
            ProfileScenario::Views => "views",
            ProfileScenario::Editor => "editor",
            ProfileScenario::Concurrent => "concurrent",
            ProfileScenario::All => "all",
        },
        iterations: options.iterations,
        concurrency: options.concurrency,
        operations,
    })
}

fn view_targets(output: &Value) -> Vec<(String, String, String)> {
    let mut targets = Vec::new();
    for format in ["mdbase.view", "obsidian.base"] {
        let Some(document) = output
            .pointer("/result/views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|document| {
                document.pointer("/source/format").and_then(Value::as_str) == Some(format)
            })
        else {
            continue;
        };
        let Some(path) = document.pointer("/source/path").and_then(Value::as_str) else {
            continue;
        };
        let Some(view) = document
            .get("views")
            .and_then(Value::as_array)
            .and_then(|views| views.first())
            .and_then(|view| view.get("id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        targets.push((format.to_string(), path.to_string(), view.to_string()));
    }
    targets
}

fn query(
    registry: &CollectionRegistry,
    collection_id: uuid::Uuid,
    limit: u64,
    offset: u64,
    include_body: bool,
    snapshot: Option<&str>,
) -> Result<Value, String> {
    let mut input = json!({
        "order_by": [{"field": "file.mtime", "direction": "desc"}],
        "limit": limit,
        "offset": offset,
        "include_body": include_body,
    });
    if let Some(snapshot) = snapshot {
        input["snapshot"] = Value::String(snapshot.to_string());
    }
    let output = registry
        .operation(collection_id, "query", &input)
        .map_err(|error| error.to_string())?;
    ensure_output_success(&output)?;
    Ok(output)
}

fn editor_index(registry: &CollectionRegistry, collection_id: uuid::Uuid) -> Result<usize, String> {
    let mut requests = 0;
    let mut snapshot: Option<String> = None;
    for include_body in [false, true] {
        let mut offset = 0_u64;
        loop {
            let limit = if offset == 0 { 200 } else { 1_000 };
            let output = query(
                registry,
                collection_id,
                limit,
                offset,
                include_body,
                snapshot.as_deref(),
            )?;
            if snapshot.is_none() {
                snapshot = output
                    .pointer("/result/meta/snapshot")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            requests += 1;
            let page_size = output
                .pointer("/result/results")
                .and_then(Value::as_array)
                .map_or(0, Vec::len) as u64;
            let has_more = output
                .pointer("/result/meta/has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            offset += page_size;
            if page_size == 0 || !has_more {
                break;
            }
        }
    }
    Ok(requests)
}

fn ensure_success(result: Result<Value, ConnectError>) -> Result<(), String> {
    let output = result.map_err(|error| error.to_string())?;
    ensure_output_success(&output)
}

fn ensure_output_success(output: &Value) -> Result<(), String> {
    if output.get("valid").and_then(Value::as_bool) != Some(false) {
        return Ok(());
    }
    Err(output
        .pointer("/diagnostics/0/message")
        .and_then(Value::as_str)
        .unwrap_or("operation returned an invalid result")
        .to_string())
}

fn run_samples(
    name: &'static str,
    iterations: usize,
    mut operation: impl FnMut() -> Result<(), String>,
) -> Result<ProfileSummary, String> {
    let mut samples = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        let started = Instant::now();
        operation().map_err(|error| format!("{name} iteration {iteration}: {error}"))?;
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    Ok(summarize(name, samples))
}

fn summarize(name: &'static str, mut samples: Vec<f64>) -> ProfileSummary {
    samples.sort_by(|left, right| left.total_cmp(right));
    let total_ms = samples.iter().sum::<f64>();
    let mean_ms = total_ms / samples.len() as f64;
    ProfileSummary {
        name,
        iterations: samples.len(),
        total_ms,
        min_ms: samples[0],
        mean_ms,
        p50_ms: percentile(&samples, 0.50),
        p95_ms: percentile(&samples, 0.95),
        max_ms: *samples.last().unwrap_or(&0.0),
        operations_per_second: if mean_ms == 0.0 {
            0.0
        } else {
            1_000.0 / mean_ms
        },
        requests_per_iteration: None,
    }
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    if samples.len() == 1 {
        return samples[0];
    }
    let position = percentile * (samples.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let weight = position - lower as f64;
    samples[lower] * (1.0 - weight) + samples[upper] * weight
}
