//! Bounded, content-free Analytics Engine events. The binding is optional for
//! local tests; ops must bind METRICS before LAB/staging traffic.
use worker::{AnalyticsEngineDataPointBuilder, AnalyticsEngineDataset, Env};

pub struct Metrics(Option<AnalyticsEngineDataset>);

fn method_label(method: &str) -> &'static str {
    const METHODS: &[&str] = &[
        "hello",
        "append",
        "read",
        "head",
        "put_object",
        "commit_object",
        "get_object",
        "has_objects",
        "put_snapshot",
        "get_snapshot",
        "endorse_snapshot",
        "subscribe",
        "unsubscribe",
        "stream_join",
        "stream_leave",
        "stream_send",
        "create_log",
        "set_quota",
        "delete_log",
        "revoke_device_credentials",
        "export",
        "export_objects",
        "backup_begin",
        "backup_page",
        "backup_finish",
        "backup_abort",
        "backup_registry_begin",
        "backup_registry_page",
        "backup_registry_finish",
        "backup_registry_abort",
        "backup_registry_merge",
        "restore_aux_begin",
        "restore_aux_page",
        "registry_record_collection_deletion",
        "registry_collection_deletions",
        "registry_collection_deletion",
        "import",
        "import_object",
        "import_snapshot",
        "compact",
        "gc",
    ];
    METHODS
        .iter()
        .copied()
        .find(|m| *m == method)
        .unwrap_or("other")
}

impl Metrics {
    pub fn new(env: &Env) -> Self {
        Self(env.analytics_engine("METRICS").ok())
    }

    /// blob1=schema, blob2=event, blob3=method, blob4=outcome, blob5=transport;
    /// double1=duration_ms, double2=value (event count or repaired item count).
    /// One constant index avoids identifiers/content in analytics dimensions.
    pub fn event(
        &self,
        event: &str,
        method: &str,
        outcome: &str,
        transport: &str,
        ms: i64,
        value: u64,
    ) {
        let Some(dataset) = &self.0 else { return };
        let result = AnalyticsEngineDataPointBuilder::new()
            .indexes(["logsvc-v1"])
            .blobs(["logsvc-v1", event, method_label(method), outcome, transport])
            .doubles([ms.max(0) as f64, value as f64])
            .write_to(dataset);
        if result.is_err() {
            // Telemetry failure must never turn an acknowledged commit into an
            // apparent request failure. Do not log request or binding contents.
            worker::console_error!("{{\"event\":\"logsvc_metrics_write_failed\"}}");
        }
    }
}
