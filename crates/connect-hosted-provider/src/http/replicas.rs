use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::AppState;
use crate::{
    error::{ApiError, ApiResult},
    provider::{RegisterReplica, UpdateApplicationReplica},
};

#[derive(Debug, Deserialize)]
pub(super) struct RotateTokenRequest {
    token: String,
    token_ttl_seconds: Option<u64>,
}

pub(super) async fn register_application_replica_v2(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<RegisterReplica>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    require_setup_evidence(input.application_setup_evidence.as_ref())?;
    state
        .provider
        .register_application_replica_v2(collection_id, input)
        .await?;
    Ok(StatusCode::CREATED)
}

pub(super) async fn update_application_replica_v2(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(replica_id): Path<Uuid>,
    Json(input): Json<UpdateApplicationReplica>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    require_setup_evidence(input.application_setup_evidence.as_ref())?;
    state
        .provider
        .update_application_replica_v2(replica_id, input)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn require_setup_evidence(evidence: Option<&Value>) -> ApiResult<()> {
    if evidence.is_none() {
        return Err(ApiError::forbidden(
            "application_declaration_mismatch",
            "V2 application policies require installed setup evidence.",
        ));
    }
    Ok(())
}

pub(super) async fn register_replica(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<RegisterReplica>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .register_replica(collection_id, input)
        .await?;
    Ok(StatusCode::CREATED)
}

pub(super) async fn list_replicas(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let replicas = state.provider.replica_statuses(collection_id).await?;
    Ok(Json(json!({ "replicas": replicas })))
}

pub(super) async fn rotate_replica_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(replica_id): Path<Uuid>,
    Json(input): Json<RotateTokenRequest>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .rotate_replica_token(replica_id, &input.token, input.token_ttl_seconds)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn revoke_replica(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(replica_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state.provider.revoke_replica(replica_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn update_replica_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(replica_id): Path<Uuid>,
    Json(input): Json<UpdateApplicationReplica>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .update_application_replica(replica_id, input)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
