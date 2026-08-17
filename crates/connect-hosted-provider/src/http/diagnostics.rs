use axum::{extract::State, middleware, routing::get, Json, Router};
use serde_json::{json, Value};

use crate::error::ApiResult;

use super::{authorize_internal_request, AppState};

pub(super) fn diagnostic_routes(state: AppState) -> Router<AppState> {
    // The privacy-safe drain diagnostic remains internally authenticated but
    // deliberately bypasses data admission so a fenced operator can prove all
    // query resources have drained.
    let internal = Router::new()
        .route("/internal/v1/query-activity", get(query_activity))
        .route_layer(middleware::from_fn_with_state(
            state,
            authorize_internal_request,
        ));
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .merge(internal)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let notifications = state.provider.ready().await?;
    Ok(Json(json!({
        "status": "ready",
        "provider": {
            "version": env!("CARGO_PKG_VERSION"),
            "capabilities": mdbase_connect_protocol::HOSTED_PROVIDER_CAPABILITIES,
            "contract_support": mdbase_connect_protocol::ConnectContractSupport::default(),
        },
        "notifications": notifications
    })))
}

async fn query_activity(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "query_activity": state.provider.hosted_query_activity()
    }))
}
