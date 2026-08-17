use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::AppState;

#[derive(Debug, Deserialize)]
struct IndexProjectionRequest {
    expected_head: u64,
    expected_resource_revision: String,
    confirmation: String,
}

#[derive(Debug, Deserialize)]
struct AdvanceProjectionRequest {
    generation_id: Uuid,
}

pub(super) fn projection_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/internal/v1/collections/{collection_id}/projection",
            get(projection_status),
        )
        .route(
            "/internal/v1/collections/{collection_id}/projection/index",
            post(index_projection),
        )
        .route(
            "/internal/v1/collections/{collection_id}/projection/advance",
            post(advance_projection),
        )
}

async fn projection_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let status = state.provider.projection_status(collection_id).await?;
    Ok(Json(json!({ "projection": status })))
}

async fn index_projection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<IndexProjectionRequest>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let expected_confirmation = format!(
        "index-projection:{collection_id}:{}:{}",
        input.expected_head, input.expected_resource_revision
    );
    if input.confirmation != expected_confirmation {
        return Err(ApiError::bad_request(
            "projection_index_confirmation_invalid",
            "The projection index confirmation does not match the expected binding.",
        ));
    }
    let status = state
        .provider
        .request_projection_indexing(
            collection_id,
            input.expected_head,
            input.expected_resource_revision,
        )
        .await?;
    Ok(Json(json!({ "projection": status })))
}

async fn advance_projection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<AdvanceProjectionRequest>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let batch = state
        .provider
        .advance_projection_generation(collection_id, input.generation_id)
        .await?;
    let status = state.provider.projection_status(collection_id).await?;
    Ok(Json(json!({ "batch": batch, "projection": status })))
}
