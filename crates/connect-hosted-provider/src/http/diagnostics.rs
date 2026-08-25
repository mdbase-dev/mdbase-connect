use axum::{extract::State, middleware, routing::get, Json, Router};
use serde_json::{json, Value};

use crate::error::ApiResult;
use mdbase_connect_protocol::{ConnectContractSupport, COLLABORATION_CONTRACT_VERSION};

use super::{authorize_internal_request, AppState};

pub(super) fn diagnostic_routes(state: AppState) -> Router<AppState> {
    // The privacy-safe drain diagnostic remains internally authenticated but
    // deliberately bypasses data admission so a fenced operator can prove all
    // query resources have drained.
    let internal = Router::new()
        .route("/internal/v1/query-activity", get(query_activity))
        .route("/internal/v1/diagnostics", get(diagnostics))
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
    let readiness = state.provider.ready().await?;
    let contract_support = advertised_contract_support(state.provider.collaboration_enabled());
    Ok(Json(json!({
        "status": "ready",
        "provider": {
            "version": env!("CARGO_PKG_VERSION"),
            "capabilities": mdbase_connect_protocol::HOSTED_PROVIDER_CAPABILITIES,
            "contract_support": contract_support,
        },
        "notifications": readiness.notifications,
        "projections": readiness.projections
    })))
}

fn advertised_contract_support(collaboration_enabled: bool) -> ConnectContractSupport {
    let mut support = ConnectContractSupport::default();
    if collaboration_enabled {
        support.collaboration.push(COLLABORATION_CONTRACT_VERSION);
    }
    support
}

async fn query_activity(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "query_activity": state.provider.hosted_query_activity()
    }))
}

/// Point-in-time operational state in one request.
///
/// Deliberately infallible: every section carries its own success or failure,
/// so an unhealthy database yields partial state rather than an unanswerable
/// request. Like the rest of this router it bypasses admission, because an
/// operator needs it most when the provider is fenced.
async fn diagnostics(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "diagnostics": state.provider.hosted_diagnostics().await
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_advertises_collaboration_only_when_enabled() {
        assert!(advertised_contract_support(false).collaboration.is_empty());
        assert_eq!(
            advertised_contract_support(true).collaboration,
            vec![COLLABORATION_CONTRACT_VERSION]
        );
    }
}
