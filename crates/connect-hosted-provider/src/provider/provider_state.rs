use super::*;
impl HostedProvider {
    pub(crate) fn collaboration_enabled(&self) -> bool {
        self.limits.hosted_collaboration_enabled
    }

    /// Database URL for the dedicated wake-listener lane only. Never logged.
    pub(crate) fn database_url(&self) -> &str {
        &self.database_url
    }

    pub(crate) fn collaboration_max_update_bytes(&self) -> u64 {
        self.limits.collaboration.max_update_bytes.min(
            mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES
                .try_into()
                .unwrap_or(u64::MAX),
        )
    }

    /// Upper bound for awareness selection offsets, expressed in UTF-16 code
    /// units against the configured document byte limit.
    pub(crate) fn collaboration_max_document_units(&self) -> u32 {
        u32::try_from(self.limits.collaboration.max_document_bytes).unwrap_or(u32::MAX)
    }

    pub(crate) fn collaboration_awareness_ttl(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.limits.collaboration.awareness_ttl_seconds)
    }

    pub(super) async fn collection_key(
        &self,
        collection_id: Uuid,
        wrapped: &[u8],
    ) -> ApiResult<zeroize::Zeroizing<[u8; 32]>> {
        self.crypto.unwrap_data_key(wrapped, collection_id).await
    }
}
