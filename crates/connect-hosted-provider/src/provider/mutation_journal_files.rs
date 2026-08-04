use super::mutation_journal::HostedMutationClaim;
use super::*;

const FILE_CONTROL_REQUEST_NAMESPACE: Uuid =
    Uuid::from_u128(0x3cde_967c_d51b_5f64_9a67_bbd2_f41a_9aa4);

impl HostedProvider {
    pub(crate) async fn run_file_control_mutation<T, F, Fut>(
        &self,
        collection_id: Uuid,
        token: &str,
        action: &'static str,
        public_request_id: Uuid,
        request: &impl Serialize,
        execute: F,
    ) -> ApiResult<T>
    where
        T: Serialize + serde::de::DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ApiResult<T>>,
    {
        let input = serde_json::to_value(request).map_err(|error| {
            ApiError::internal(format!("File control request could not serialize: {error}"))
        })?;
        let request_id = file_control_request_id(action, public_request_id);
        let replica = match self.authenticate_for_file(collection_id, token).await {
            Ok(replica) => replica,
            Err(authentication_error) => {
                let replay = self
                    .replay_retired_operation_mutation(
                        collection_id,
                        token,
                        "file_control",
                        request_id,
                        &input,
                        authentication_error,
                    )
                    .await?;
                return decode_file_control_result(replay);
            }
        };
        let claim = self
            .claim_operation_mutation(collection_id, &replica, "file_control", request_id, &input)
            .await?;
        let lease = match claim {
            HostedMutationClaim::Terminal(result) => {
                return decode_file_control_result(result?);
            }
            HostedMutationClaim::Live => {
                return Err(ApiError::conflict(
                    "pending_mutation_unresolved",
                    "The file mutation is still owned by an active request handler.",
                )
                .with_details(json!({
                    "request_id": public_request_id,
                    "operation": action,
                })));
            }
            HostedMutationClaim::Owned {
                lease,
                applied_result,
                ..
            } => {
                if let Some(result) = applied_result {
                    self.complete_operation_mutation(collection_id, &lease, &result)
                        .await?;
                    return decode_file_control_result(result?);
                }
                lease
            }
        };
        // Each file control has a durable inner lifecycle keyed by its public
        // transfer/mutation identity. Re-executing after journal takeover
        // resumes that lifecycle or replays its receipt; it never starts a
        // second logical effect.
        let result = execute().await;
        let stored_result = match &result {
            Ok(value) => serde_json::to_value(value).map_err(|error| {
                ApiError::internal(format!("File control result could not serialize: {error}"))
            }),
            Err(error) => Err(error.clone()),
        };
        self.complete_operation_mutation(collection_id, &lease, &stored_result)
            .await?;
        result
    }
}

fn file_control_request_id(action: &str, public_request_id: Uuid) -> Uuid {
    let name = format!("{action}\0{public_request_id}");
    Uuid::new_v5(&FILE_CONTROL_REQUEST_NAMESPACE, name.as_bytes())
}

fn decode_file_control_result<T: serde::de::DeserializeOwned>(value: Value) -> ApiResult<T> {
    serde_json::from_value(value).map_err(|error| {
        ApiError::internal(format!(
            "Stored file control receipt could not deserialize: {error}"
        ))
    })
}
