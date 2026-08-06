use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{error::ApiResult, provider::ProviderAccountLimits};

use super::AppState;

#[derive(Debug, Deserialize)]
struct UpsertAccountRequest {
    entitlement_revision: u64,
    #[serde(flatten)]
    limits: ProviderAccountLimits,
}

#[derive(Debug, Deserialize)]
struct CreateCollectionRequest {
    account_id: Uuid,
    collection_id: Uuid,
    template: String,
    display_name: String,
    timezone: String,
}

pub(super) fn account_routes() -> Router<AppState> {
    Router::new()
        .route("/internal/v1/collections", post(create_collection))
        .route(
            "/internal/v1/accounts/{account_id}",
            put(upsert_account).get(account_usage),
        )
        .route(
            "/internal/v1/accounts/{account_id}/collections/{collection_id}",
            put(reconcile_collection_account),
        )
}

async fn create_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateCollectionRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    state.authorize_internal(&headers)?;
    let collection = state
        .provider
        .create_collection(
            input.account_id,
            input.collection_id,
            &input.template,
            &input.display_name,
            &input.timezone,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "collection": collection })),
    ))
}

async fn upsert_account(
    State(state): State<AppState>,
    Path(account_id): Path<Uuid>,
    Json(input): Json<UpsertAccountRequest>,
) -> ApiResult<Json<Value>> {
    let usage = state
        .provider
        .upsert_account(account_id, input.entitlement_revision, input.limits)
        .await?;
    Ok(Json(json!({ "account": usage })))
}

async fn account_usage(
    State(state): State<AppState>,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let usage = state.provider.account_usage(account_id).await?;
    Ok(Json(json!({ "account": usage })))
}

async fn reconcile_collection_account(
    State(state): State<AppState>,
    Path((account_id, collection_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    state
        .provider
        .reconcile_collection_account(account_id, collection_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_creation_requires_a_display_name() {
        assert!(
            serde_json::from_value::<CreateCollectionRequest>(serde_json::json!({
                "account_id": Uuid::new_v4(),
                "collection_id": Uuid::new_v4(),
                "template": "tasknotes"
            }))
            .is_err()
        );
        let input: CreateCollectionRequest = serde_json::from_value(serde_json::json!({
            "account_id": Uuid::new_v4(),
            "collection_id": Uuid::new_v4(),
            "template": "mdbase",
            "display_name": "Worklog",
            "timezone": "Australia/Melbourne"
        }))
        .unwrap();
        assert_eq!(input.display_name, "Worklog");
    }
}
