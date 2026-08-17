use std::time::{Duration, Instant};

use mdbase_connect_hosted_provider::{ApiResult, HostedProvider};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{remaining_cutover_time, CutoverArguments};

async fn cutover_lock_owned(connection: &mut PgConnection, owner_token: Uuid) -> ApiResult<bool> {
    let application_name = format!("mdbase-candidate-b-cutover/{owner_token}");
    sqlx::query_scalar(
        r#"WITH lock_key AS (
             SELECT hashtextextended('mdbase-candidate-b-cutover-v1', 0) AS value
           )
           SELECT current_setting('application_name') = $1
             AND EXISTS (
               SELECT 1
               FROM pg_locks, lock_key
               WHERE locktype = 'advisory'
                 AND pid = pg_backend_pid()
                 AND granted
                 AND classid = (((lock_key.value >> 32) & 4294967295)::bigint)::oid
                 AND objid = ((lock_key.value & 4294967295)::bigint)::oid
                 AND objsubid = 1
             )
             AND EXISTS (
               SELECT 1
               FROM hosted_provider_runtime_control
               WHERE singleton = true
                 AND query_admission_suspended = true
                 AND admission_fence_token = $2
                 AND admission_fence_kind = 'cutover'
                 AND admission_owner_expires_at > clock_timestamp()
             )"#,
    )
    .bind(application_name)
    .bind(owner_token)
    .fetch_one(connection)
    .await
    .map_err(Into::into)
}

pub(super) async fn run_cutover(
    provider: &HostedProvider,
    cutover_lock: &mut PgConnection,
    started: Instant,
    arguments: CutoverArguments,
) -> ApiResult<(bool, Value)> {
    let deadline = Duration::from_secs(arguments.max_seconds);
    let mut after = None;
    let mut pages_visited = 0_u32;
    let mut collections_verified = 0_u32;
    let mut batches_advanced = 0_u64;

    loop {
        if !cutover_lock_owned(cutover_lock, arguments.owner_token).await? {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_lock_lost",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        provider
            .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
            .await?;
        let (_, complete) = provider
            .migrate_legacy_sync_receipts_batch(100, remaining_cutover_time(started, deadline))
            .await?;
        if complete {
            break;
        }
    }

    loop {
        if !cutover_lock_owned(cutover_lock, arguments.owner_token).await? {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_lock_lost",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        if started.elapsed() >= deadline {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_time_budget_exceeded",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        if pages_visited >= arguments.max_pages {
            return Ok((
                false,
                cutover_outcome(
                    "projection_cutover_page_budget_exceeded",
                    false,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    after,
                    None,
                    &[],
                ),
            ));
        }
        provider
            .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
            .await?;
        let plan = provider
            .projection_index_plan(after, arguments.page_limit)
            .await?;
        pages_visited += 1;
        if !plan.migration_ledger_valid || !plan.schema_valid {
            return Ok((
                false,
                json!({
                    "outcome": "projection_cutover_schema_invalid",
                    "migration_ledger_valid": plan.migration_ledger_valid,
                    "schema_valid": plan.schema_valid,
                    "complete_inventory": false,
                    "pages_visited": pages_visited,
                    "collections_verified": collections_verified,
                    "batches_advanced": batches_advanced,
                    "next_after": after,
                }),
            ));
        }

        for entry in &plan.collections {
            if collections_verified >= arguments.max_collections {
                return Ok((
                    false,
                    cutover_outcome(
                        "projection_cutover_collection_budget_exceeded",
                        false,
                        pages_visited,
                        collections_verified,
                        batches_advanced,
                        after,
                        Some(entry.collection_id),
                        &[],
                    ),
                ));
            }
            provider
                .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                .await?;
            let mut status = provider
                .request_projection_indexing(
                    entry.collection_id,
                    entry.head,
                    entry.resource_revision.clone(),
                )
                .await?;
            let mut collection_batches = 0_u32;
            while !status.ready {
                if !cutover_lock_owned(cutover_lock, arguments.owner_token).await? {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_lock_lost",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                if started.elapsed() >= deadline {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_time_budget_exceeded",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                if collection_batches >= arguments.batches_per_collection
                    || batches_advanced >= arguments.max_batches
                {
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_batch_budget_exceeded",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &[],
                        ),
                    ));
                }
                let Some(generation) = status.building_generation.as_ref() else {
                    let failures = status
                        .latest_terminal_error_code
                        .clone()
                        .into_iter()
                        .collect::<Vec<_>>();
                    return Ok((
                        false,
                        cutover_outcome(
                            "projection_cutover_generation_unavailable",
                            false,
                            pages_visited,
                            collections_verified,
                            batches_advanced,
                            after,
                            Some(entry.collection_id),
                            &failures,
                        ),
                    ));
                };
                provider
                    .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                    .await?;
                provider
                    .advance_projection_generation(entry.collection_id, generation.generation_id)
                    .await?;
                collection_batches += 1;
                batches_advanced += 1;
                status = provider.projection_status(entry.collection_id).await?;
            }

            provider
                .configure_cutover_statement_timeout(remaining_cutover_time(started, deadline))
                .await?;
            let verification = provider
                .verify_projection_index(entry.collection_id)
                .await?;
            if !verification.verified {
                return Ok((
                    false,
                    cutover_outcome(
                        "projection_cutover_verification_failed",
                        false,
                        pages_visited,
                        collections_verified,
                        batches_advanced,
                        after,
                        Some(entry.collection_id),
                        &verification.failures,
                    ),
                ));
            }
            collections_verified += 1;
        }

        let Some(next_after) = plan.next_after else {
            return Ok((
                true,
                cutover_outcome(
                    "complete",
                    true,
                    pages_visited,
                    collections_verified,
                    batches_advanced,
                    None,
                    None,
                    &[],
                ),
            ));
        };
        after = Some(next_after);
    }
}

#[allow(clippy::too_many_arguments)]
fn cutover_outcome(
    outcome: &'static str,
    complete_inventory: bool,
    pages_visited: u32,
    collections_verified: u32,
    batches_advanced: u64,
    next_after: Option<Uuid>,
    blocked_collection_id: Option<Uuid>,
    failures: &[String],
) -> Value {
    json!({
        "outcome": outcome,
        "complete_inventory": complete_inventory,
        "pages_visited": pages_visited,
        "collections_verified": collections_verified,
        "batches_advanced": batches_advanced,
        "next_after": next_after,
        "blocked_collection_id": blocked_collection_id,
        "failures": failures,
    })
}
