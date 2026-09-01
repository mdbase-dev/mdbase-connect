impl HostedProvider {
    pub(crate) fn is_valid_query_cursor_release(input: &Value) -> bool {
        input
            .get("release_cursor")
            .and_then(Value::as_str)
            .is_some_and(|cursor| decode_query_cursor(cursor).is_ok())
    }

    pub(super) async fn execute_hosted_query(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_hosted_query_request(
            collection_id,
            replica,
            request_id,
            input,
            HostedQueryRequestKind::Query,
        )
        .await
    }

    pub(super) async fn execute_hosted_canonical_view(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let request_kind = if input
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path.ends_with(".base"))
        {
            HostedQueryRequestKind::ObsidianBase
        } else {
            HostedQueryRequestKind::CanonicalView
        };
        self.execute_hosted_query_request(collection_id, replica, request_id, input, request_kind)
            .await
    }
}
