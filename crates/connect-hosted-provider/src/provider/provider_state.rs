use super::*;

impl HostedProvider {
    pub(super) fn collection_key(
        &self,
        collection_id: Uuid,
        wrapped: &[u8],
    ) -> ApiResult<[u8; 32]> {
        self.crypto
            .unwrap_data_key(wrapped, &collection_key_aad(collection_id))
    }

    pub(super) async fn working_set(&self, collection_id: Uuid) -> WorkingSetSlot {
        let mut working_sets = self.working_sets.lock().await;
        working_sets
            .entry(collection_id)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }
}
