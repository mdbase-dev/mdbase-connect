use super::*;
impl HostedProvider {
    pub(crate) fn collaboration_enabled(&self) -> bool {
        self.limits.hosted_collaboration_enabled
    }

    pub(crate) fn collaboration_max_update_bytes(&self) -> u64 {
        self.limits.collaboration.max_update_bytes.min(
            mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES
                .try_into()
                .unwrap_or(u64::MAX),
        )
    }

    pub(super) async fn collection_key(
        &self,
        collection_id: Uuid,
        wrapped: &[u8],
    ) -> ApiResult<zeroize::Zeroizing<[u8; 32]>> {
        self.crypto.unwrap_data_key(wrapped, collection_id).await
    }
}
