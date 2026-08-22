impl HostedProvider {
    pub(super) async fn replay_terminal_operation_mutation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        input: &Value,
    ) -> ApiResult<Option<ApiResult<Value>>> {
        let operation_kind = mdbase_connect_protocol::mutation_operation_identifier(
            operation, input,
        )
        .ok_or_else(|| {
            ApiError::bad_request("invalid_request", "Operation is not a canonical mutation.")
        })?;
        let input_schema_version = mdbase_connect_protocol::operation_input_schema_version(
            operation, input,
        )
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_request",
                "Mutation input schema version is unavailable.",
            )
        })?;
        let input_digest = mdbase_connect_protocol::mutation_fingerprint_bytes(operation, input)
            .map_err(|error| ApiError::bad_request("invalid_request", error.to_string()))?;

        if let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest
               FROM hosted_provider_mutation_tombstones
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        {
            let same = row.get::<String, _>("operation_kind") == operation_kind
                && row.get::<i32, _>("fingerprint_schema_version") == 1
                && row.get::<i32, _>("input_schema_version")
                    == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
                && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
            return Err(if same {
                ApiError::new(
                    StatusCode::GONE,
                    "mutation_recovery_expired",
                    "The mutation is outside the supported online recovery horizon.",
                )
            } else {
                mutation_conflict(request_id)
            });
        }

        let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest, final_receipt_ciphertext
               FROM hosted_provider_mutation_journal
               WHERE replica_id = $1 AND request_id = $2
                 AND state IN ('completed', 'acknowledged', 'abandoned', 'outcome_unknown')"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let same = row.get::<String, _>("operation_kind") == operation_kind
            && row.get::<i32, _>("fingerprint_schema_version") == 1
            && row.get::<i32, _>("input_schema_version")
                == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
            && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
        if !same {
            return Err(mutation_conflict(request_id));
        }
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let receipt: StoredMutationReceipt = self.crypto.decrypt_json(
            &data_key,
            &row.get::<Vec<u8>, _>("final_receipt_ciphertext"),
            &hosted_mutation_receipt_aad(replica.id, request_id),
        )?;
        Ok(Some(receipt.into_result()))
    }
}
