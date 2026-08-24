use super::*;
impl HostedProvider {
    pub(crate) fn collaboration_enabled(&self) -> bool {
        self.limits.hosted_collaboration_enabled
    }

    pub(super) async fn collection_key(
        &self,
        collection_id: Uuid,
        wrapped: &[u8],
    ) -> ApiResult<zeroize::Zeroizing<[u8; 32]>> {
        self.crypto.unwrap_data_key(wrapped, collection_id).await
    }
}
