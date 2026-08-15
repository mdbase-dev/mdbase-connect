use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const PUBLISHED_MANIFEST: &str = include_str!("../../../config/hosted-execution-budgets.json");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedExecutionBudgetManifest {
    pub schema_version: u32,
    pub revision: String,
    pub published_at: String,
    pub capacity_basis: HostedExecutionCapacityBasis,
    pub defaults: HostedExecutionBudgets,
    pub hard_maxima: HostedExecutionBudgets,
    pub entitlements: BTreeMap<String, HostedExecutionEntitlement>,
    pub temporary_containment: TemporaryExecutionContainment,
    pub acceptance: HostedExecutionAcceptance,
    pub budget_kinds: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedExecutionCapacityBasis {
    pub provider_memory_mi_b: u64,
    pub database_pool_connections: u64,
    pub notes: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedExecutionBudgets {
    pub page_items: u64,
    pub page_plaintext_bytes: u64,
    pub record_batch_items: u64,
    pub record_batch_ciphertext_bytes: u64,
    pub simultaneously_decrypted_bytes: u64,
    pub decryption_parallelism: u64,
    pub scanned_records: u64,
    pub scanned_ciphertext_bytes: u64,
    pub top_k_entries: u64,
    pub maximum_offset: u64,
    pub groups: u64,
    pub aggregation_state_bytes: u64,
    pub diagnostics_count: u64,
    pub diagnostics_bytes: u64,
    pub result_items: u64,
    pub result_bytes: u64,
    pub cursor_bytes: u64,
    pub snapshot_lifetime_ms: u64,
    pub operation_deadline_ms: u64,
    pub active_scan_permits_per_process: u64,
    pub accounted_execution_bytes_per_operation: u64,
    pub accounted_execution_bytes_per_process: u64,
    pub cursor_idle_ttl_ms: u64,
    pub cursor_hard_ttl_ms: u64,
    pub cursor_count_per_collection: u64,
    pub cursor_bytes_per_collection: u64,
    pub cursor_count_per_account: u64,
    pub cursor_bytes_per_account: u64,
    pub cursor_count_global: u64,
    pub cursor_bytes_global: u64,
    pub cursor_construction_bytes_per_process: u64,
    pub cursor_build_permits_per_process: u64,
    pub temporary_page_buffer_bytes_per_process: u64,
    pub cancellation_cleanup_ms: u64,
    pub cursor_cleanup_interval_ms: u64,
    pub cursor_deletion_bound_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedExecutionEntitlement {
    pub test_only: bool,
    pub scanned_records: u64,
    pub scanned_ciphertext_bytes: u64,
    pub snapshot_lifetime_ms: u64,
    pub operation_deadline_ms: u64,
    pub active_scan_permits_per_process: u64,
    pub accounted_execution_bytes_per_process: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryExecutionContainment {
    pub deletion_marker: String,
    pub working_set_collections_per_process: u64,
    pub working_set_plaintext_bytes_per_process: u64,
    pub working_set_plaintext_bytes_per_collection: u64,
    pub working_set_maximum_age_ms: u64,
    pub query_result_cache_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedExecutionAcceptance {
    pub steady_process_rss_bytes: u64,
    pub point_read_p95_ms: u64,
    pub exact_sync_mutation_p95_ms: u64,
    pub common_bounded_query_p95_ms: u64,
    pub million_record_full_scan_ms: u64,
    pub point_read_p95_during_scans_ms: u64,
    pub maximum_scan_pool_fraction: f64,
    pub staging_soak_minutes_per_slice: u64,
    pub final_staging_soak_minutes: u64,
    pub minimum_successful_operations_per_supported_shape: u64,
    pub semantic_mismatch_tolerance: u64,
    pub security_mismatch_tolerance: u64,
    pub ambiguous_mutation_outcome_tolerance: u64,
}

impl HostedExecutionBudgetManifest {
    pub fn published() -> &'static Self {
        static MANIFEST: OnceLock<HostedExecutionBudgetManifest> = OnceLock::new();
        MANIFEST.get_or_init(|| {
            let manifest: Self = serde_json::from_str(PUBLISHED_MANIFEST)
                .expect("the published hosted execution budget manifest must parse");
            manifest
                .validate()
                .expect("the published hosted execution budget manifest must be valid");
            manifest
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported hosted execution budget schema".to_string());
        }
        if self.revision.trim().is_empty() {
            return Err("hosted execution budget revision is empty".to_string());
        }
        validate_positive_limit_set("defaults", &self.defaults)?;
        validate_positive_limit_set("hardMaxima", &self.hard_maxima)?;
        validate_default_maxima(&self.defaults, &self.hard_maxima)?;

        let required_kinds = BTreeSet::from([
            "cursor",
            "diagnostics",
            "groups",
            "ordering",
            "result",
            "scan",
            "time",
        ]);
        let actual_kinds = self
            .budget_kinds
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if actual_kinds != required_kinds {
            return Err("hosted execution budget kinds are incomplete or unknown".to_string());
        }
        if !(0.0..=1.0).contains(&self.acceptance.maximum_scan_pool_fraction)
            || self.acceptance.maximum_scan_pool_fraction == 0.0
        {
            return Err("maximum scan pool fraction must be in (0, 1]".to_string());
        }
        if self.defaults.cursor_idle_ttl_ms > self.defaults.cursor_hard_ttl_ms {
            return Err("default cursor idle TTL exceeds hard TTL".to_string());
        }
        if self.defaults.cursor_bytes > self.defaults.cursor_bytes_per_collection
            || self.defaults.cursor_bytes_per_collection > self.defaults.cursor_bytes_per_account
            || self.defaults.cursor_bytes_per_account > self.defaults.cursor_bytes_global
        {
            return Err("default durable cursor byte quotas are not monotonic".to_string());
        }
        if self.temporary_containment.query_result_cache_enabled {
            return Err("the temporary hosted query-result cache must remain disabled".to_string());
        }
        if self.temporary_containment.deletion_marker.trim().is_empty() {
            return Err("temporary containment needs an explicit deletion marker".to_string());
        }
        let large = self
            .entitlements
            .get("large_fixture_v1")
            .ok_or_else(|| "large fixture entitlement is missing".to_string())?;
        if !large.test_only
            || large.scanned_records != 1_000_000
            || large.active_scan_permits_per_process != 1
        {
            return Err("large fixture entitlement is not safely bounded".to_string());
        }
        if large.scanned_records > self.hard_maxima.scanned_records
            || large.scanned_ciphertext_bytes > self.hard_maxima.scanned_ciphertext_bytes
            || large.snapshot_lifetime_ms > self.hard_maxima.snapshot_lifetime_ms
            || large.operation_deadline_ms > self.hard_maxima.operation_deadline_ms
        {
            return Err("large fixture entitlement exceeds a hard maximum".to_string());
        }
        Ok(())
    }
}

fn validate_positive_limit_set(name: &str, budgets: &HostedExecutionBudgets) -> Result<(), String> {
    let value = serde_json::to_value(budgets)
        .map_err(|error| format!("serialize {name} hosted budgets: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("{name} hosted budgets are not an object"))?;
    for (key, value) in object {
        if value.as_u64() == Some(0) {
            return Err(format!("{name}.{key} must be greater than zero"));
        }
    }
    Ok(())
}

fn validate_default_maxima(
    defaults: &HostedExecutionBudgets,
    maxima: &HostedExecutionBudgets,
) -> Result<(), String> {
    let defaults = serde_json::to_value(defaults)
        .map_err(|error| format!("serialize default hosted budgets: {error}"))?;
    let maxima = serde_json::to_value(maxima)
        .map_err(|error| format!("serialize maximum hosted budgets: {error}"))?;
    let defaults = defaults
        .as_object()
        .ok_or_else(|| "default hosted budgets are not an object".to_string())?;
    let maxima = maxima
        .as_object()
        .ok_or_else(|| "maximum hosted budgets are not an object".to_string())?;
    for (key, default) in defaults {
        let default = default
            .as_u64()
            .ok_or_else(|| format!("defaults.{key} is not an integer"))?;
        let maximum = maxima
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| format!("hardMaxima.{key} is missing or not an integer"))?;
        if default > maximum {
            return Err(format!("defaults.{key} exceeds hardMaxima.{key}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_manifest_is_valid_and_sized_for_the_large_fixture() {
        let manifest = HostedExecutionBudgetManifest::published();
        assert_eq!(manifest.revision, "hosted-execution-v1");
        assert_eq!(manifest.defaults.scanned_records, 100_000);
        assert_eq!(manifest.hard_maxima.scanned_records, 1_000_000);
        assert_eq!(
            manifest.entitlements["large_fixture_v1"].active_scan_permits_per_process,
            1
        );
        assert!(!manifest.temporary_containment.query_result_cache_enabled);
    }

    #[test]
    fn rejects_a_default_above_the_hard_maximum() {
        let mut manifest: HostedExecutionBudgetManifest =
            serde_json::from_str(PUBLISHED_MANIFEST).unwrap();
        manifest.defaults.result_bytes = manifest.hard_maxima.result_bytes + 1;
        assert!(manifest.validate().is_err());
    }
}
