use super::*;
use crate::HostedExecutionBudgetManifest;

impl HostedProvider {
    pub(super) async fn collection_key(
        &self,
        collection_id: Uuid,
        wrapped: &[u8],
    ) -> ApiResult<zeroize::Zeroizing<[u8; 32]>> {
        self.crypto.unwrap_data_key(wrapped, collection_id).await
    }

    pub(super) async fn working_set(&self, collection_id: Uuid) -> ApiResult<WorkingSetSlot> {
        let containment = &HostedExecutionBudgetManifest::published().temporary_containment;
        let maximum_entries = usize::try_from(containment.working_set_collections_per_process)
            .map_err(|_| ApiError::internal("Hosted working-set capacity is invalid."))?;
        let maximum_age = Duration::from_millis(containment.working_set_maximum_age_ms);
        let now = Instant::now();
        let mut registry = self.working_sets.lock().await;

        let expired = registry
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                (Arc::strong_count(&entry.slot) == 1
                    && now.saturating_duration_since(entry.last_used) >= maximum_age)
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        for id in expired {
            evict_working_set(&mut registry, id, "age");
        }

        if let Some(entry) = registry.entries.get_mut(&collection_id) {
            entry.last_used = now;
            return Ok(entry.slot.clone());
        }

        while registry.entries.len() >= maximum_entries {
            let candidate = registry
                .entries
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.slot) == 1)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(id, _)| *id);
            let Some(candidate) = candidate else {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "hosted_working_set_capacity",
                    "The hosted compatibility runtime is busy; retry the request.",
                )
                .with_details(json!({ "budget_kind": "scan" })));
            };
            evict_working_set(&mut registry, candidate, "capacity");
        }

        let slot = Arc::new(Mutex::new(None));
        registry.entries.insert(
            collection_id,
            WorkingSetRegistryEntry {
                slot: slot.clone(),
                last_used: now,
            },
        );
        Ok(slot)
    }

    pub(super) async fn remove_working_set(&self, collection_id: Uuid) {
        let mut registry = self.working_sets.lock().await;
        evict_working_set(&mut registry, collection_id, "invalidation");
    }
}

fn evict_working_set(registry: &mut WorkingSetRegistryState, collection_id: Uuid, reason: &str) {
    let Some(entry) = registry.entries.remove(&collection_id) else {
        return;
    };
    let (plaintext_bytes, age_ms) = entry
        .slot
        .try_lock()
        .ok()
        .and_then(|cached| {
            cached.as_ref().map(|cached| {
                (
                    cached.plaintext_bytes,
                    cached.created_at.elapsed().as_millis() as u64,
                )
            })
        })
        .unwrap_or((0, 0));
    let memory = crate::HostedProcessMemory::capture();
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "hosted_working_set_evicted",
        reason,
        plaintext_bytes,
        age_ms,
        rss_bytes = memory.rss_bytes.unwrap_or(0),
        pss_bytes = memory.pss_bytes.unwrap_or(0),
        cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
        cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
        "privacy-safe hosted provider metric"
    );
}
