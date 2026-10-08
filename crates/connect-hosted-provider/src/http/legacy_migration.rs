//! Internal routes for migrating hosted collections to mdbase-next, and collection
//! deletion, which the migration's retention guard constrains.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::ApiResult;

use super::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetLegacyMigrationState {
    state: String,
    #[serde(default)]
    retain_until: Option<DateTime<Utc>>,
    /// Required true for `migrated` → `active`: the runbook verified the reverse export at R.
    #[serde(default)]
    reverse_verified: bool,
    /// On rollback to `active`: the replicas revoked at H8, restored in the same
    /// transaction.
    #[serde(default)]
    restore_replica_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreReplicas {
    replica_ids: Vec<Uuid>,
}

pub(super) fn legacy_migration_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/internal/v1/collections/{collection_id}/legacy-migration",
            put(set_legacy_migration_state).get(legacy_migration_drain),
        )
        .route(
            "/internal/v1/collections/{collection_id}/legacy-migration/restore-replicas",
            post(restore_replicas),
        )
}

async fn set_legacy_migration_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<SetLegacyMigrationState>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let status = state
        .provider
        .set_legacy_migration_state(
            collection_id,
            &input.state,
            input.retain_until,
            input.reverse_verified,
            &input.restore_replica_ids,
        )
        .await?;
    Ok(Json(json!(status)))
}

async fn legacy_migration_drain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let drain = state.provider.legacy_migration_drain(collection_id).await?;
    Ok(Json(json!(drain)))
}

async fn restore_replicas(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<RestoreReplicas>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let restored = state
        .provider
        .restore_migration_revoked_replicas(collection_id, &input.replica_ids)
        .await?;
    Ok(Json(json!({ "restored": restored })))
}

pub(super) async fn delete_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state.provider.delete_collection(collection_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
