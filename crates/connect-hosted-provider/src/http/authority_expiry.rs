use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AuthorityTransferBinding {
    collection_id: Uuid,
    authority_epoch: u64,
}

pub(super) async fn reconcile_authority_import_cancellation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<AuthorityTransferBinding>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .reconcile_authority_import_cancellation(id, input.collection_id, input.authority_epoch)
        .await?;
    Ok(Json(
        json!({ "transfer_id": id, "collection_id": input.collection_id,
        "authority_epoch": input.authority_epoch, "cancelled": true }),
    ))
}

pub(super) async fn expire_authority_transfer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<AuthorityTransferBinding>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    let transfer = state
        .provider
        .expire_authority_transfer(id, input.collection_id, input.authority_epoch)
        .await?;
    Ok(Json(serde_json::to_value(transfer).map_err(|error| {
        ApiError::internal(format!("Authority transfer could not serialize: {error}"))
    })?))
}

pub(super) async fn expire_authority_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<AuthorityTransferBinding>,
) -> ApiResult<Json<Value>> {
    state.authorize_internal(&headers)?;
    state
        .provider
        .expire_authority_import(id, input.collection_id, input.authority_epoch)
        .await?;
    Ok(Json(
        json!({ "transfer_id": id, "collection_id": input.collection_id,
        "authority_epoch": input.authority_epoch, "expired": true }),
    ))
}
