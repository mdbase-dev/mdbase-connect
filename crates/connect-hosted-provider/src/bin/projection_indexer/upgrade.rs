//! Online semantic engine upgrade. Collections indexed by another engine stay
//! available on exact fallback while each is rebuilt; completing a rebuild
//! binds the new generation atomically, exactly as ordinary indexing does.

use std::time::{Duration, Instant};

use mdbase_connect_hosted_provider::{
    ApiError, ApiResult, HostedProvider, PROJECTION_ENGINE_UPGRADE,
};
use serde_json::{json, Value};
use uuid::Uuid;

use super::UpgradeArguments;

pub(super) async fn run_upgrade(
    provider: &HostedProvider,
    arguments: UpgradeArguments,
) -> ApiResult<(bool, Value)> {
    let started = Instant::now();
    let deadline = Duration::from_secs(arguments.max_seconds);
    let mut after = arguments.after;
    let mut seen = 0_u64;
    let mut current = 0_u64;
    let mut upgraded = 0_u64;
    let mut incomplete = Vec::new();
    loop {
        if started.elapsed() >= deadline {
            return Ok(outcome(
                false, false, after, seen, current, upgraded, incomplete,
            ));
        }
        let plan = provider
            .projection_index_plan(after, arguments.page_limit)
            .await?;
        if !plan.migration_ledger_valid || !plan.schema_valid {
            return Err(ApiError::conflict(
                "projection_index_schema_invalid",
                "Projection indexing requires the exact reviewed migration ledger and schema.",
            ));
        }
        for entry in &plan.collections {
            seen += 1;
            let status = provider.projection_status(entry.collection_id).await?;
            if status.ready {
                current += 1;
                continue;
            }
            match provider
                .upgrade_projection_engine(
                    status,
                    arguments.attempts_per_collection,
                    arguments.batches_per_attempt,
                )
                .await?
            {
                None => upgraded += 1,
                Some(code) => incomplete.push(json!({
                    "collection_id": entry.collection_id,
                    "code": code,
                })),
            }
        }
        after = plan.next_after;
        if after.is_none() {
            let ok = incomplete.is_empty();
            return Ok(outcome(ok, true, None, seen, current, upgraded, incomplete));
        }
    }
}

fn outcome(
    ok: bool,
    complete_inventory: bool,
    next_after: Option<Uuid>,
    seen: u64,
    current: u64,
    upgraded: u64,
    incomplete: Vec<Value>,
) -> (bool, Value) {
    (
        ok,
        json!({
            "protocol": PROJECTION_ENGINE_UPGRADE,
            "complete_inventory": complete_inventory,
            "next_after": next_after,
            "collections_seen": seen,
            "already_current": current,
            "upgraded": upgraded,
            "incomplete": incomplete,
        }),
    )
}
