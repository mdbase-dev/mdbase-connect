use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, OriginalUri, Path, Query, Request, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE, ORIGIN},
        HeaderMap, HeaderName, Method, StatusCode, Uri,
    },
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use mdbase_connect_protocol::{
    AuthorityImportManifest, AuthorityImportRecordPage, ContractSetupChoice, GrantSummary,
    OperationRequest, OperationResponse, SyncChangesPage, SyncMutation, SyncMutationReceipt,
    SyncSession, SyncSnapshotPage, TypePackProvision, AUTHORITY_PROOF_NONCE_HEADER,
    AUTHORITY_PROOF_SIGNATURE_HEADER, AUTHORITY_PROOF_TIMESTAMP_HEADER,
    AUTHORITY_PROOF_VERSION_HEADER, CONTROL_PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use tower_http::{
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    provider::{
        validate_limit, AuthorityRequestProof, HostedProvider, PrepareAuthorityImport,
        PrepareAuthorityTransfer, RegisterReplica, UpdateApplicationReplica,
    },
};

const MAX_BODY_BYTES: usize = 3 * 1024 * 1024;
// Record imports are paged, but a page can contain several large canonical
// documents. Provider quotas and the concurrency gate bound parsed work.
const MAX_IMPORT_BODY_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone)]
pub struct AppState {
    provider: HostedProvider,
    internal_token_hash: [u8; 32],
    request_slots: Arc<Semaphore>,
}

impl AppState {
    pub fn new(provider: HostedProvider, internal_token: &str) -> ApiResult<Self> {
        if internal_token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_internal_token",
                "The provider internal credential must contain at least 32 characters.",
            ));
        }
        Ok(Self {
            provider,
            internal_token_hash: Sha256::digest(internal_token.as_bytes()).into(),
            request_slots: Arc::new(Semaphore::new(128)),
        })
    }

    fn authorize_internal(&self, headers: &HeaderMap) -> ApiResult<()> {
        let token = bearer(headers)?;
        let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        if bool::from(candidate.ct_eq(&self.internal_token_hash)) {
            Ok(())
        } else {
            Err(ApiError::unauthorized(
                "invalid_internal_token",
                "The provider internal credential is invalid.",
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
struct CreateCollectionRequest {
    collection_id: Uuid,
    template: String,
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct RenameCollectionRequest {
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct RotateTokenRequest {
    token: String,
    token_ttl_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CompactRequest {
    through: u64,
}

#[derive(Debug, Deserialize)]
struct ProvisionTypePacksRequest {
    type_packs: Vec<TypePackProvision>,
    #[serde(flatten)]
    extensions: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct ContractSetupRequest {
    type_packs: Vec<TypePackProvision>,
    #[serde(default)]
    contract_setups: Vec<ContractSetupChoice>,
}

#[derive(Debug, Deserialize)]
struct CompleteAuthorityTransferRequest {
    manifest_digest: String,
}

#[derive(Debug, Deserialize)]
struct CompleteAuthorityImportRequest {
    manifest_digest: String,
    source_revision: String,
}

#[derive(Debug, Deserialize)]
struct SnapshotQuery {
    snapshot_id: Uuid,
    page: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChangesQuery {
    after: u64,
    limit: Option<u32>,
}

pub fn app(state: AppState) -> Router {
    let request_id_header = HeaderName::from_static("x-request-id");
    // Preflight requests contain no bearer credential. Actual application
    // requests are bound to the origin stored with that provider capability.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static(AUTHORITY_PROOF_VERSION_HEADER),
            HeaderName::from_static(AUTHORITY_PROOF_TIMESTAMP_HEADER),
            HeaderName::from_static(AUTHORITY_PROOF_NONCE_HEADER),
            HeaderName::from_static(AUTHORITY_PROOF_SIGNATURE_HEADER),
        ])
        .allow_methods([Method::GET, Method::POST])
        .max_age(std::time::Duration::from_secs(600));
    let internal = Router::new()
        .route("/internal/v1/collections", post(create_collection))
        .route(
            "/internal/v1/collections/{collection_id}",
            patch(rename_collection).delete(delete_collection),
        )
        .route(
            "/internal/v1/collections/{collection_id}/usage",
            get(collection_usage),
        )
        .route(
            "/internal/v1/collections/{collection_id}/replicas",
            get(list_replicas).post(register_replica),
        )
        .route(
            "/internal/v1/collections/{collection_id}/compact",
            post(compact_collection),
        )
        .route(
            "/internal/v1/collections/{collection_id}/type-packs/provision",
            post(provision_type_packs),
        )
        .route(
            "/internal/v1/collections/{collection_id}/contract-setup",
            post(setup_contracts),
        )
        .route(
            "/internal/v1/collections/{collection_id}/types",
            get(collection_type_candidates),
        )
        .route(
            "/internal/v1/collections/{collection_id}/authority-transfers",
            post(prepare_authority_transfer),
        )
        .route(
            "/internal/v1/authority-transfers/{transfer_id}",
            post(complete_authority_transfer).delete(abort_authority_transfer),
        )
        .route(
            "/internal/v1/authority-imports",
            post(prepare_authority_import),
        )
        .route(
            "/internal/v1/authority-imports/{import_id}",
            post(complete_authority_import).delete(abort_authority_import),
        )
        .route(
            "/internal/v1/collections/{collection_id}/notification-grants/{grant_id}",
            put(upsert_notification_grant).delete(revoke_notification_grant),
        )
        .route(
            "/internal/v1/replicas/{replica_id}/token",
            post(rotate_replica_token),
        )
        .route(
            "/internal/v1/replicas/{replica_id}/policy",
            patch(update_replica_policy),
        )
        .route("/internal/v1/replicas/{replica_id}", delete(revoke_replica))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            authorize_internal_request,
        ));
    let sync = Router::new()
        .route(
            "/v1/authorities/{collection_id}/sync/sessions",
            post(open_session),
        )
        .route(
            "/v1/authorities/{collection_id}/sync/snapshot",
            get(snapshot),
        )
        .route("/v1/authorities/{collection_id}/sync/changes", get(changes))
        .route(
            "/v1/authorities/{collection_id}/sync/mutations",
            post(mutate),
        )
        .route_layer(middleware::from_fn(require_bearer_request));
    let operations = Router::new()
        .route(
            "/v1/authorities/{collection_id}/operations/{operation}",
            post(operation),
        )
        .route_layer(middleware::from_fn(require_bearer_request));
    let imports = Router::new()
        .route(
            "/v1/authority-imports/{import_id}/manifest",
            put(put_authority_import_manifest),
        )
        .route(
            "/v1/authority-imports/{import_id}/records",
            put(put_authority_import_records),
        )
        .route(
            "/v1/authority-imports/{import_id}/finalize",
            post(finalize_authority_import),
        )
        .layer(DefaultBodyLimit::max(MAX_IMPORT_BODY_BYTES))
        .route_layer(middleware::from_fn(require_bearer_request));
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .merge(internal)
        .merge(sync)
        .merge(operations)
        .merge(imports)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors)
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            limit_concurrent_requests,
        ))
        .with_state(state)
}

async fn limit_concurrent_requests(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> ApiResult<Response> {
    let _permit = state
        .request_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "provider_busy",
                "The hosted provider is busy; retry with backoff.",
            )
        })?;
    Ok(next.run(request).await)
}

async fn authorize_internal_request(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> ApiResult<Response> {
    state.authorize_internal(request.headers())?;
    Ok(next.run(request).await)
}

async fn require_bearer_request(request: Request, next: Next) -> ApiResult<Response> {
    bearer(request.headers())?;
    Ok(next.run(request).await)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let notifications = state.provider.ready().await?;
    Ok(Json(json!({
        "status": "ready",
        "notifications": notifications
    })))
}

async fn create_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateCollectionRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    state.authorize_internal(&headers)?;
    let collection = state
        .provider
        .create_collection(input.collection_id, &input.template, &input.display_name)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "collection": collection })),
    ))
}

async fn rename_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<RenameCollectionRequest>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .rename_collection(collection_id, &input.display_name)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn collection_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let usage = state.provider.collection_usage(collection_id).await?;
    Ok(Json(json!({ "usage": usage })))
}

async fn upsert_notification_grant(
    State(state): State<AppState>,
    Path((collection_id, grant_id)): Path<(Uuid, Uuid)>,
    Json(grant): Json<GrantSummary>,
) -> ApiResult<Json<Value>> {
    if grant.id != grant_id {
        return Err(ApiError::bad_request(
            "notification_grant_mismatch",
            "The notification grant ID does not match the request path.",
        ));
    }
    state
        .provider
        .upsert_notification_grant(collection_id, grant)
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn revoke_notification_grant(
    State(state): State<AppState>,
    Path((_collection_id, grant_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    state.provider.revoke_notification_grant(grant_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn delete_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state.provider.delete_collection(collection_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn register_replica(
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

async fn list_replicas(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let replicas = state.provider.replica_statuses(collection_id).await?;
    Ok(Json(json!({ "replicas": replicas })))
}

async fn rotate_replica_token(
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

async fn revoke_replica(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(replica_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state.provider.revoke_replica(replica_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_replica_policy(
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

async fn compact_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<CompactRequest>,
) -> ApiResult<StatusCode> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .compact_through(collection_id, input.through)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn prepare_authority_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<PrepareAuthorityTransfer>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let transfer = state
        .provider
        .prepare_authority_transfer(collection_id, input)
        .await?;
    Ok(Json(serde_json::to_value(transfer).map_err(|error| {
        ApiError::internal(format!("Authority transfer could not serialize: {error}"))
    })?))
}

async fn complete_authority_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transfer_id): Path<Uuid>,
    Json(input): Json<CompleteAuthorityTransferRequest>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let transfer = state
        .provider
        .complete_authority_transfer(transfer_id, &input.manifest_digest)
        .await?;
    Ok(Json(serde_json::to_value(transfer).map_err(|error| {
        ApiError::internal(format!("Authority transfer could not serialize: {error}"))
    })?))
}

async fn abort_authority_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(transfer_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let transfer = state.provider.abort_authority_transfer(transfer_id).await?;
    Ok(Json(serde_json::to_value(transfer).map_err(|error| {
        ApiError::internal(format!("Authority transfer could not serialize: {error}"))
    })?))
}

async fn prepare_authority_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PrepareAuthorityImport>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let import = state.provider.prepare_authority_import(input).await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn complete_authority_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
    Json(input): Json<CompleteAuthorityImportRequest>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let import = state
        .provider
        .complete_authority_import(import_id, &input.manifest_digest, &input.source_revision)
        .await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn abort_authority_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let import = state.provider.abort_authority_import(import_id).await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn put_authority_import_manifest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
    Json(manifest): Json<AuthorityImportManifest>,
) -> ApiResult<Json<Value>> {
    let import = state
        .provider
        .put_authority_import_manifest(import_id, bearer(&headers)?, manifest)
        .await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn put_authority_import_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
    Json(page): Json<AuthorityImportRecordPage>,
) -> ApiResult<Json<Value>> {
    let import = state
        .provider
        .put_authority_import_records(import_id, bearer(&headers)?, page)
        .await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn finalize_authority_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(import_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let import = state
        .provider
        .finalize_authority_import(import_id, bearer(&headers)?)
        .await?;
    Ok(Json(serde_json::to_value(import).map_err(|error| {
        ApiError::internal(format!("Authority import could not serialize: {error}"))
    })?))
}

async fn open_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<SyncSession>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::POST, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .open_session(collection_id, token, origin)
            .await?,
    ))
}

async fn snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    Query(query): Query<SnapshotQuery>,
) -> ApiResult<Json<SyncSnapshotPage>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::GET, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .snapshot(
                collection_id,
                token,
                query.snapshot_id,
                query.page.as_deref(),
                origin,
            )
            .await?,
    ))
}

async fn changes(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    Query(query): Query<ChangesQuery>,
) -> ApiResult<Json<SyncChangesPage>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let limit = validate_limit(query.limit)?;
    let proof = request_proof(&headers, Method::GET, &uri, &[])?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    Ok(Json(
        state
            .provider
            .changes(collection_id, token, query.after, limit, origin)
            .await?,
    ))
}

async fn mutate(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<Json<SyncMutationReceipt>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::POST, &uri, &body)?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    let mutation = serde_json::from_slice::<SyncMutation>(&body).map_err(|_| {
        ApiError::bad_request("invalid_json", "The hosted mutation body is invalid.")
    })?;
    Ok(Json(
        state
            .provider
            .mutate(collection_id, token, mutation, origin)
            .await?,
    ))
}

async fn provision_type_packs(
    State(state): State<AppState>,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<ProvisionTypePacksRequest>,
) -> ApiResult<Json<Value>> {
    if input.type_packs.len() > 20 {
        return Err(ApiError::bad_request(
            "too_many_type_pack_provisions",
            "An application may provision at most 20 type packs.",
        ));
    }
    if !input.extensions.is_empty() {
        return Err(ApiError::bad_request(
            "contract_setup_upgrade_required",
            "This contract setup request requires the dedicated contract-setup endpoint.",
        ));
    }
    let (contracts, _) = state
        .provider
        .provision_type_packs(collection_id, input.type_packs, Vec::new())
        .await?;
    Ok(Json(json!({ "contracts": contracts })))
}

async fn setup_contracts(
    State(state): State<AppState>,
    Path(collection_id): Path<Uuid>,
    Json(input): Json<ContractSetupRequest>,
) -> ApiResult<Json<Value>> {
    if input.type_packs.len() > 20 {
        return Err(ApiError::bad_request(
            "too_many_type_pack_provisions",
            "An application may provision at most 20 type packs.",
        ));
    }
    if input.contract_setups.len() > 20 {
        return Err(ApiError::bad_request(
            "too_many_contract_setups",
            "An application may configure at most 20 contracts.",
        ));
    }
    let (contracts, contract_setups) = state
        .provider
        .provision_type_packs(collection_id, input.type_packs, input.contract_setups)
        .await?;
    Ok(Json(json!({
        "contracts": contracts,
        "contract_setups": contract_setups,
    })))
}

async fn collection_type_candidates(
    State(state): State<AppState>,
    Path(collection_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let types = state
        .provider
        .collection_type_candidates(collection_id)
        .await?;
    Ok(Json(json!({ "types": types })))
}

async fn operation(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path((collection_id, operation)): Path<(Uuid, String)>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::POST, &uri, &body)?;
    state
        .provider
        .authorize_request(collection_id, token, origin, proof.as_ref())
        .await?;
    let request = serde_json::from_slice::<OperationRequest>(&body).map_err(|_| {
        ApiError::bad_request("invalid_json", "The hosted operation body is invalid.")
    })?;
    if request.protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(ApiError::bad_request(
            "unsupported_protocol_version",
            format!(
                "Operation protocol {} is unsupported; expected {}.",
                request.protocol_version, CONTROL_PROTOCOL_VERSION
            ),
        ));
    }
    let result = state
        .provider
        .operation(
            collection_id,
            token,
            &operation,
            request.request_id,
            request.input,
            origin,
        )
        .await?;
    Ok(Json(
        serde_json::to_value(OperationResponse {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: request.request_id,
            ok: true,
            result: Some(result),
            problem: None,
        })
        .map_err(|error| {
            ApiError::internal(format!(
                "Hosted operation response could not serialize: {error}"
            ))
        })?,
    ))
}

fn request_origin(headers: &HeaderMap) -> Option<&str> {
    headers.get(ORIGIN).and_then(|value| value.to_str().ok())
}

fn request_proof(
    headers: &HeaderMap,
    method: Method,
    uri: &Uri,
    body: &[u8],
) -> ApiResult<Option<AuthorityRequestProof>> {
    let values = [
        header_text(headers, AUTHORITY_PROOF_VERSION_HEADER),
        header_text(headers, AUTHORITY_PROOF_TIMESTAMP_HEADER),
        header_text(headers, AUTHORITY_PROOF_NONCE_HEADER),
        header_text(headers, AUTHORITY_PROOF_SIGNATURE_HEADER),
    ];
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    let [Some(version), Some(timestamp), Some(nonce), Some(signature)] = values else {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof is incomplete.",
        ));
    };
    let version = version.parse::<u32>().map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof version is invalid.",
        )
    })?;
    let timestamp = timestamp.parse::<i64>().map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof timestamp is invalid.",
        )
    })?;
    let nonce = Uuid::parse_str(nonce).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof nonce is invalid.",
        )
    })?;
    if signature.is_empty() {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        ));
    }
    Ok(Some(AuthorityRequestProof {
        version,
        timestamp,
        nonce,
        signature: signature.to_string(),
        method: method.to_string(),
        target: uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or_else(|| uri.path())
            .to_string(),
        body: body.to_vec(),
    }))
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            ApiError::unauthorized("missing_bearer_token", "A bearer credential is required.")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_credentials_are_checked_by_digest() {
        let hash: [u8; 32] = Sha256::digest(b"a-long-test-token-that-is-over-32-characters").into();
        assert!(bool::from(hash.ct_eq(&hash)));
        let other: [u8; 32] = Sha256::digest(b"another-long-test-token-that-is-different").into();
        assert!(!bool::from(hash.ct_eq(&other)));
    }

    #[test]
    fn collection_creation_requires_a_display_name() {
        assert!(
            serde_json::from_value::<CreateCollectionRequest>(serde_json::json!({
                "collection_id": Uuid::new_v4(),
                "template": "tasknotes"
            }))
            .is_err()
        );
        let input: CreateCollectionRequest = serde_json::from_value(serde_json::json!({
            "collection_id": Uuid::new_v4(),
            "template": "mdbase",
            "display_name": "Worklog"
        }))
        .unwrap();
        assert_eq!(input.display_name, "Worklog");
    }
}
