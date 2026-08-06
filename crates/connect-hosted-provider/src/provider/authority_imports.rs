use super::authority_import_cleanup::{
    authority_import_blob_cleanup, enqueue_authority_import_blob_cleanup,
    expired_authority_import_blob_cleanup,
};
use super::files::{classify_media, validate_content_digest, validate_media_type};
use super::*;
use mdbase_connect_protocol::CollectionFileDescriptor;

impl HostedProvider {
    pub async fn prepare_authority_import(
        &self,
        input: PrepareAuthorityImport,
    ) -> ApiResult<ProviderAuthorityImport> {
        if input.token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import credential is invalid.",
            ));
        }
        if input.authority_epoch <= 1 || !(60..=60 * 60).contains(&input.ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import epoch or lifetime is invalid.",
            ));
        }
        // Expiry cascades delete abandoned import targets. Recover first so a
        // replacement target cannot be mistaken for the expired one.
        self.recover_expired_authority_imports().await?;
        let existing_state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(input.collection_id)
        .fetch_optional(&self.pool)
        .await?;
        if existing_state.is_none() {
            self.create_collection(
                input.account_id,
                input.collection_id,
                "mdbase",
                &input.display_name,
                "UTC",
            )
            .await?;
        } else if !matches!(existing_state.as_deref(), Some("importing" | "transferred")) {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection already has an active authority.",
            ));
        }
        let expires_at = Utc::now()
            + chrono::Duration::seconds(to_i64(input.ttl_seconds, "authority import lifetime")?);
        let requested_token_hash = token_hash(&input.token);
        let mut transaction = self.pool.begin().await?;
        if let Some(existing) = sqlx::query(
            r#"SELECT id, collection_id, token_hash, next_authority_epoch, state,
                      manifest_digest, source_revision, source_head, expires_at
               FROM hosted_provider_authority_imports WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let exact = existing.get::<Uuid, _>("collection_id") == input.collection_id
                && existing.get::<i64, _>("next_authority_epoch")
                    == to_i64(input.authority_epoch, "authority epoch")?
                && authority_import_state(&existing, "state")?.accepts_upload();
            if !exact {
                return Err(ApiError::conflict(
                    "authority_import_conflict",
                    "Authority import already exists with different parameters.",
                ));
            }
            let rotated = sqlx::query(
                r#"UPDATE hosted_provider_authority_imports
                   SET token_hash = $2, expires_at = $3
                   WHERE id = $1
                   RETURNING id, collection_id, next_authority_epoch, state,
                             manifest_digest, source_revision, source_head, expires_at"#,
            )
            .bind(input.transfer_id)
            .bind(requested_token_hash)
            .bind(expires_at)
            .fetch_one(&mut *transaction)
            .await?;
            let result = provider_authority_import(&rotated)?;
            transaction.commit().await?;
            return Ok(result);
        }
        // A later epoch supersedes the completed import receipt for this
        // collection. Keeping only the current import preserves the useful
        // collection-level uniqueness without preventing round trips.
        sqlx::query(
            r#"DELETE FROM hosted_provider_authority_imports
               WHERE collection_id = $1 AND state = 'completed'
                 AND next_authority_epoch < $2"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        let collection = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'importing', authority_epoch = $2,
                   display_name = $3, updated_at = now()
               WHERE id = $1 AND state = 'transferred'
               RETURNING id"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(input.display_name.trim())
        .fetch_optional(&mut *transaction)
        .await?;
        let collection = if collection.is_some() {
            collection
        } else {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'importing', authority_epoch = $2,
                       display_name = $3, updated_at = now()
                   WHERE id = $1 AND state = 'active' AND head = 0 AND record_count = 0
                   RETURNING id"#,
            )
            .bind(input.collection_id)
            .bind(to_i64(input.authority_epoch, "authority epoch")?)
            .bind(input.display_name.trim())
            .fetch_optional(&mut *transaction)
            .await?
        };
        if collection.is_none() {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection cannot receive an authority import.",
            ));
        }
        let row = sqlx::query(
            r#"INSERT INTO hosted_provider_authority_imports
                 (id, collection_id, token_hash, next_authority_epoch,
                  restore_state, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(input.transfer_id)
        .bind(input.collection_id)
        .bind(requested_token_hash)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(if existing_state.as_deref() == Some("transferred") {
            Some("transferred")
        } else {
            None
        })
        .bind(expires_at)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&row)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn put_authority_import_manifest(
        &self,
        import_id: Uuid,
        token: &str,
        manifest: AuthorityImportManifest,
    ) -> ApiResult<ProviderAuthorityImport> {
        if manifest.protocol_version != CONTROL_PROTOCOL_VERSION
            || manifest.manifest_digest.len() != 64
            || !manifest
                .manifest_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || manifest.source_revision.is_empty()
            || manifest.resources.documents.is_empty()
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_manifest",
                "Authority import manifest is invalid.",
            ));
        }
        let mut paths = BTreeSet::new();
        for resource in &manifest.resources.documents {
            if !paths.insert(resource.path.as_str())
                || resource.document.len() as u64 > self.limits.max_bytes_per_document
                || !matches!(
                    resource.kind.as_str(),
                    "configuration" | "contract" | "schema" | "type" | "view"
                )
            {
                return Err(ApiError::bad_request(
                    "invalid_authority_import_manifest",
                    "Authority import resources are invalid.",
                ));
            }
        }
        if manifest.file_count != manifest.files.len() as u64 {
            return Err(ApiError::bad_request(
                "invalid_authority_import_manifest",
                "Authority import file count does not match its descriptors.",
            ));
        }
        let mut file_ids = BTreeSet::new();
        let mut file_paths = BTreeSet::new();
        let mut file_bytes = 0_u64;
        for file in &manifest.files {
            validate_hosted_file_path(&file.path)?;
            validate_content_digest(&file.content_digest)?;
            validate_media_type(file.media_type.as_deref())?;
            let path_key = portable_file_path_key(&file.path);
            file_bytes = file_bytes.checked_add(file.size).ok_or_else(|| {
                ApiError::quota(
                    "file_quota_exceeded",
                    "Authority import file size overflowed.",
                )
            })?;
            if file.file_id.is_nil()
                || file.revision.is_empty()
                || file.media_class != classify_media(&file.path).0
                || chrono::DateTime::parse_from_rfc3339(&file.modified_at).is_err()
                || !file_ids.insert(file.file_id)
                || !file_paths.insert(path_key)
                || paths.contains(file.path.as_str())
            {
                return Err(ApiError::bad_request(
                    "invalid_authority_import_manifest",
                    "Authority import file descriptors are invalid or duplicated.",
                ));
            }
        }
        if !manifest
            .resources
            .documents
            .iter()
            .any(|resource| resource.path == "mdbase.yaml" && resource.kind == "configuration")
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_manifest",
                "Authority import must include mdbase.yaml.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if !authority_import_state(&row, "import_state")?.accepts_upload() {
            return Err(ApiError::conflict(
                "authority_import_inactive",
                "An inactive authority import cannot accept another manifest.",
            ));
        }
        if row.get::<Uuid, _>("collection_id") != manifest.collection_id {
            return Err(ApiError::bad_request(
                "authority_import_collection_mismatch",
                "Authority import manifest belongs to another collection.",
            ));
        }
        let max_records = number(row.get::<i64, _>("max_records"), "record quota")?;
        if manifest.record_count > max_records {
            return Err(ApiError::quota(
                "record_quota_exceeded",
                "Authority import exceeds the collection record quota.",
            ));
        }
        if manifest.file_count > number(row.get::<i64, _>("max_files"), "file quota")?
            || file_bytes > number(row.get::<i64, _>("max_file_bytes"), "file byte quota")?
            || file_bytes
                > number(
                    row.get::<i64, _>("max_stored_file_bytes"),
                    "stored file byte quota",
                )?
            || manifest.files.iter().any(|file| {
                file.size > u64::try_from(row.get::<i64, _>("max_single_file_bytes")).unwrap_or(0)
            })
        {
            return Err(ApiError::quota(
                "file_quota_exceeded",
                "Authority import exceeds a collection file quota.",
            ));
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self.crypto.unwrap_data_key(&wrapped, collection_id).await?;
        let previous_digest: Option<String> = row.get("manifest_digest");
        let previous_revision: Option<String> = row.get("source_revision");
        let manifest_changed = previous_digest.as_deref() != Some(&manifest.manifest_digest)
            || previous_revision.as_deref() != Some(&manifest.source_revision);
        let abandoned_files = if manifest_changed {
            let abandoned = authority_import_blob_cleanup(&mut transaction, import_id).await?;
            enqueue_authority_import_blob_cleanup(&mut transaction, import_id).await?;
            sqlx::query(
                "DELETE FROM hosted_provider_authority_import_records WHERE import_id = $1",
            )
            .bind(import_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "DELETE FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1",
            )
            .bind(import_id)
            .execute(&mut *transaction)
            .await?;
            abandoned
        } else {
            Vec::new()
        };
        let ciphertext = self.crypto.encrypt_json(
            &data_key,
            &manifest,
            &authority_import_manifest_aad(import_id),
        )?;
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET manifest_ciphertext = $2, manifest_digest = $3,
                   source_revision = $4, source_head = $5,
                   expected_record_count = $6, expected_file_count = $7, state = 'receiving'
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .bind(ciphertext)
        .bind(&manifest.manifest_digest)
        .bind(&manifest.source_revision)
        .bind(to_i64(manifest.source_head, "source head")?)
        .bind(to_i64(manifest.record_count, "record count")?)
        .bind(to_i64(manifest.file_count, "file count")?)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&saved)?;
        transaction.commit().await?;
        self.abort_authority_import_multipart(abandoned_files).await;
        Ok(result)
    }

    pub async fn put_authority_import_records(
        &self,
        import_id: Uuid,
        token: &str,
        page: AuthorityImportRecordPage,
    ) -> ApiResult<ProviderAuthorityImport> {
        if page.protocol_version != CONTROL_PROTOCOL_VERSION
            || page.records.is_empty()
            || page.records.len() > 200
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_page",
                "Authority import pages must contain between 1 and 200 records.",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for item in &page.records {
            if item.record_id.is_nil()
                || !ids.insert(item.record_id)
                || !paths.insert(item.path.as_str())
                || item.document.len() as u64 > self.limits.max_bytes_per_document
            {
                return Err(ApiError::bad_request(
                    "invalid_authority_import_page",
                    "Authority import page contains invalid or duplicate records.",
                ));
            }
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if authority_import_state(&row, "import_state")? != ProviderAuthorityImportState::Receiving
        {
            return Err(ApiError::conflict(
                "authority_import_finalized",
                "A finalized authority import cannot accept more record pages.",
            ));
        }
        if row
            .get::<Option<Vec<u8>>, _>("manifest_ciphertext")
            .is_none()
        {
            return Err(ApiError::conflict(
                "authority_import_manifest_required",
                "Upload the authority import manifest before record pages.",
            ));
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self.crypto.unwrap_data_key(&wrapped, collection_id).await?;
        sqlx::query(
            "DELETE FROM hosted_provider_authority_import_records
             WHERE import_id = $1 AND page = $2",
        )
        .bind(import_id)
        .bind(to_i64(page.page, "import page")?)
        .execute(&mut *transaction)
        .await?;
        for item in &page.records {
            let ciphertext = self.crypto.encrypt_json(
                &data_key,
                item,
                &authority_import_record_aad(import_id, item.record_id),
            )?;
            let inserted = sqlx::query(
                r#"INSERT INTO hosted_provider_authority_import_records
                     (import_id, page, record_id, path_token, payload_ciphertext, content_bytes)
                   VALUES ($1, $2, $3, $4, $5, $6)"#,
            )
            .bind(import_id)
            .bind(to_i64(page.page, "import page")?)
            .bind(item.record_id)
            .bind(path_token(&data_key, &item.path))
            .bind(ciphertext)
            .bind(to_i64(item.document.len() as u64, "document size")?)
            .execute(&mut *transaction)
            .await;
            if let Err(sqlx::Error::Database(error)) = &inserted {
                if error.is_unique_violation() {
                    return Err(ApiError::conflict(
                        "authority_import_record_conflict",
                        "A record ID or path appears in more than one import page.",
                    ));
                }
            }
            inserted?;
        }
        let result = provider_authority_import(&row)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn finalize_authority_import(
        &self,
        import_id: Uuid,
        token: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if authority_import_state(&row, "import_state")? == ProviderAuthorityImportState::Uploaded {
            let mut result = provider_authority_import(&row)?;
            result.contracts = authority_import_contracts(self, &row).await?;
            transaction.commit().await?;
            return Ok(result);
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self.crypto.unwrap_data_key(&wrapped, collection_id).await?;
        let manifest_ciphertext: Vec<u8> = row
            .get::<Option<Vec<u8>>, _>("manifest_ciphertext")
            .ok_or_else(|| {
                ApiError::conflict(
                    "authority_import_manifest_required",
                    "Authority import manifest has not been uploaded.",
                )
            })?;
        let mut manifest: AuthorityImportManifest = self.crypto.decrypt_json(
            &data_key,
            &manifest_ciphertext,
            &authority_import_manifest_aad(import_id),
        )?;
        let staged = sqlx::query(
            r#"SELECT record_id, payload_ciphertext
               FROM hosted_provider_authority_import_records
               WHERE import_id = $1 ORDER BY page, record_id"#,
        )
        .bind(import_id)
        .fetch_all(&mut *transaction)
        .await?;
        if staged.len() as u64 != manifest.record_count {
            return Err(ApiError::conflict(
                "authority_import_incomplete",
                "Not every authority snapshot record has been uploaded.",
            ));
        }
        let uploaded_records = staged
            .into_iter()
            .map(|record| {
                let record_id: Uuid = record.get("record_id");
                let item: AuthorityImportRecord = self.crypto.decrypt_json(
                    &data_key,
                    record.get("payload_ciphertext"),
                    &authority_import_record_aad(import_id, record_id),
                )?;
                if item.record_id != record_id {
                    return Err(ApiError::internal(
                        "Authority import record identity failed authentication.",
                    ));
                }
                Ok(item)
            })
            .collect::<ApiResult<Vec<_>>>()?;
        let staged_files = sqlx::query(
            r#"SELECT id, file_id, intent_ciphertext, committed_object_key
               FROM hosted_provider_authority_import_file_transfers
               WHERE import_id = $1 AND state = 'committed'
               ORDER BY created_at DESC"#,
        )
        .bind(import_id)
        .fetch_all(&mut *transaction)
        .await?;
        let all_staged_object_keys = staged_files
            .iter()
            .map(|row| row.get::<String, _>("committed_object_key"))
            .collect::<BTreeSet<_>>();
        let mut uploaded_files = BTreeMap::<Uuid, (CollectionFileDescriptor, String)>::new();
        for staged_file in staged_files {
            let file_id: Uuid = staged_file.get("file_id");
            let descriptor: CollectionFileDescriptor = self.crypto.decrypt_json(
                &data_key,
                staged_file.get("intent_ciphertext"),
                &authority_import_file_intent_aad(staged_file.get("id")),
            )?;
            if manifest
                .files
                .iter()
                .any(|declared| declared.file_id == file_id && declared == &descriptor)
            {
                uploaded_files
                    .entry(file_id)
                    .or_insert((descriptor, staged_file.get("committed_object_key")));
            }
        }
        if manifest.files.iter().any(|file| {
            uploaded_files
                .get(&file.file_id)
                .is_none_or(|(uploaded, _)| uploaded != file)
        }) || uploaded_files.len() < manifest.files.len()
        {
            return Err(ApiError::conflict(
                "authority_import_incomplete",
                "Not every authority snapshot file has been uploaded and verified.",
            ));
        }
        for file in &manifest.files {
            let (_, object_key) = uploaded_files
                .get(&file.file_id)
                .expect("file upload was checked");
            self.blob_store
                .verify_object(object_key, file.size, &file.content_digest)
                .await?;
        }
        let workspace = WorkingSet::materialize(
            manifest
                .resources
                .documents
                .iter()
                .map(|resource| (resource.path.clone(), resource.document.clone())),
            uploaded_records.iter().map(|item| StoredDocument {
                record_id: item.record_id,
                path: item.path.clone(),
                document: item.document.clone(),
            }),
        )?;
        let records = canonicalize_imported_snapshot(&workspace, &manifest, &uploaded_records)?;
        let mut physical_paths = manifest
            .resources
            .documents
            .iter()
            .map(|resource| portable_file_path_key(&resource.path))
            .collect::<BTreeSet<_>>();
        if records
            .iter()
            .any(|record| !physical_paths.insert(portable_file_path_key(&record.path)))
            || manifest
                .files
                .iter()
                .any(|file| !physical_paths.insert(portable_file_path_key(&file.path)))
        {
            return Err(ApiError::conflict(
                "authority_import_path_conflict",
                "Authority import records, resources, and files must use distinct portable paths.",
            ));
        }
        if snapshot_manifest_digest(&manifest.resources.documents, &records, &manifest.files)
            != manifest.manifest_digest
        {
            return Err(ApiError::conflict(
                "authority_manifest_mismatch",
                "Uploaded authority snapshot does not match its manifest.",
            ));
        }
        let (types, contracts) = workspace.type_resources()?;
        manifest.resources.types = types;
        manifest.resources.contracts = contracts;
        let canonical_manifest_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &manifest,
            &authority_import_manifest_aad(import_id),
        )?;
        let content_bytes = records.iter().try_fold(0_u64, |total, item| {
            total
                .checked_add(item.document.len() as u64)
                .ok_or_else(|| {
                    ApiError::quota(
                        "content_quota_exceeded",
                        "Authority import content size is too large.",
                    )
                })
        })?;
        let imported_file_bytes = manifest.files.iter().try_fold(0_u64, |total, file| {
            total.checked_add(file.size).ok_or_else(|| {
                ApiError::quota(
                    "file_quota_exceeded",
                    "Authority import file size overflowed.",
                )
            })
        })?;
        let max_content_bytes = number(row.get::<i64, _>("max_content_bytes"), "content quota")?;
        if content_bytes > max_content_bytes {
            return Err(ApiError::quota(
                "content_quota_exceeded",
                "Authority import exceeds the collection content quota.",
            ));
        }
        sqlx::query("DELETE FROM hosted_provider_changes WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_record_versions WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_records WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_resources WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        let old_file_objects = sqlx::query_scalar::<_, String>(
            r#"SELECT object_key FROM hosted_provider_files WHERE collection_id = $1
               UNION
               SELECT object_key FROM hosted_provider_file_versions WHERE collection_id = $1"#,
        )
        .bind(collection_id)
        .fetch_all(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM hosted_provider_file_changes WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_file_versions WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_files WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        let imported_object_keys = uploaded_files
            .values()
            .map(|(_, object_key)| object_key.as_str())
            .collect::<BTreeSet<_>>();
        for object_key in &imported_object_keys {
            sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
                .bind(object_key)
                .execute(&mut *transaction)
                .await?;
        }
        for object_key in old_file_objects {
            if imported_object_keys.contains(object_key.as_str()) {
                continue;
            }
            sqlx::query(
                r#"INSERT INTO hosted_provider_blob_deletions (object_key, reason)
                   VALUES ($1, 'authority import replaced file') ON CONFLICT DO NOTHING"#,
            )
            .bind(&object_key)
            .execute(&mut *transaction)
            .await?;
        }
        for object_key in all_staged_object_keys {
            if imported_object_keys.contains(object_key.as_str()) {
                continue;
            }
            sqlx::query(
                r#"INSERT INTO hosted_provider_blob_deletions (object_key, reason)
                   VALUES ($1, 'unused authority import file') ON CONFLICT DO NOTHING"#,
            )
            .bind(&object_key)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "DELETE FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1 AND committed_object_key = $2",
            )
            .bind(import_id)
            .bind(&object_key)
            .execute(&mut *transaction)
            .await?;
        }
        for resource in &manifest.resources.documents {
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(collection_id)
            .bind(&resource.path)
            .bind(&resource.kind)
            .bind(&resource.revision)
            .bind(self.crypto.encrypt_bytes(
                &data_key,
                resource.document.as_bytes(),
                &resource_document_aad(collection_id, &resource.path),
            )?)
            .execute(&mut *transaction)
            .await?;
        }
        let initial_sequence = (!records.is_empty() || !manifest.files.is_empty()) as u64;
        for item in &records {
            persist_live_record(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                initial_sequence,
                item,
            )
            .await?;
        }
        for file in &manifest.files {
            let (_, object_key) = uploaded_files
                .get(&file.file_id)
                .expect("file upload was checked");
            let payload = super::files::payload_from_descriptor(file);
            let current_ciphertext = self.crypto.encrypt_json(
                &data_key,
                &payload,
                &current_file_aad(collection_id, file.file_id, initial_sequence),
            )?;
            let version_ciphertext = self.crypto.encrypt_json(
                &data_key,
                &payload,
                &file_version_aad(collection_id, file.file_id, initial_sequence),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_files
                     (collection_id, file_id, path_token, revision, size, object_key,
                      payload_ciphertext, sequence)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            )
            .bind(collection_id)
            .bind(file.file_id)
            .bind(path_token(&data_key, &portable_file_path_key(&file.path)))
            .bind(&file.revision)
            .bind(to_i64(file.size, "file size")?)
            .bind(object_key)
            .bind(current_ciphertext)
            .bind(to_i64(initial_sequence, "collection sequence")?)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_file_versions
                     (collection_id, file_id, sequence, revision, size, object_key,
                      payload_ciphertext, deleted)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, false)"#,
            )
            .bind(collection_id)
            .bind(file.file_id)
            .bind(to_i64(initial_sequence, "collection sequence")?)
            .bind(&file.revision)
            .bind(to_i64(file.size, "file size")?)
            .bind(object_key)
            .bind(version_ciphertext)
            .execute(&mut *transaction)
            .await?;
        }
        let resources_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &manifest.resources,
            &resources_aad(collection_id),
        )?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET spec_version = $2, resource_revision = $3,
                   resources_ciphertext = $4, head = $5, retained_after = 0,
                   record_count = $6, content_bytes = $7,
                   file_count = $8, file_bytes = $9, stored_file_bytes = $9,
                   updated_at = now()
               WHERE id = $1 AND state = 'importing'"#,
        )
        .bind(collection_id)
        .bind(&manifest.resources.spec_version)
        .bind(&manifest.resources.revision)
        .bind(resources_ciphertext)
        .bind(to_i64(initial_sequence, "collection head")?)
        .bind(to_i64(records.len() as u64, "record count")?)
        .bind(to_i64(content_bytes, "content size")?)
        .bind(to_i64(manifest.files.len() as u64, "file count")?)
        .bind(to_i64(imported_file_bytes, "file bytes")?)
        .execute(&mut *transaction)
        .await?;
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'uploaded', manifest_ciphertext = $2, uploaded_at = now()
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .bind(canonical_manifest_ciphertext)
        .fetch_one(&mut *transaction)
        .await?;
        let mut result = provider_authority_import(&saved)?;
        result.contracts = manifest.resources.contracts.clone();
        transaction.commit().await?;
        self.working_sets.lock().await.remove(&collection_id);
        Ok(result)
    }

    pub async fn complete_authority_import(
        &self,
        import_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        let state: String = row.get("import_state");
        if state == "completed" {
            if row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
                || row.get::<Option<String>, _>("source_revision").as_deref()
                    != Some(source_revision)
            {
                return Err(ApiError::conflict(
                    "authority_import_not_ready",
                    "Completed authority import does not match this snapshot.",
                ));
            }
            let mut result = provider_authority_import(&row)?;
            result.contracts = authority_import_contracts(self, &row).await?;
            transaction.commit().await?;
            return Ok(result);
        }
        if state != "uploaded"
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
        {
            return Err(ApiError::conflict(
                "authority_import_not_ready",
                "Authority import does not match the fenced source snapshot.",
            ));
        }
        let collection_id: Uuid = row.get("collection_id");
        let authority_epoch = number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?;
        let activated = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'active', authority_epoch = $2, updated_at = now()
               WHERE id = $1 AND state = 'importing'"#,
        )
        .bind(collection_id)
        .bind(to_i64(authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        if activated.rows_affected() != 1 {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import target is no longer pending.",
            ));
        }
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'completed', completed_at = now()
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .fetch_one(&mut *transaction)
        .await?;
        let mut result = provider_authority_import(&saved)?;
        result.contracts = authority_import_contracts(self, &row).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn abort_authority_import(
        &self,
        import_id: Uuid,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        if authority_import_state(&row, "import_state")? == ProviderAuthorityImportState::Completed
        {
            return Err(ApiError::conflict(
                "authority_import_completed",
                "Completed authority import cannot be cancelled.",
            ));
        }
        let result = ProviderAuthorityImport {
            state: ProviderAuthorityImportState::Aborted,
            ..provider_authority_import(&row)?
        };
        let abandoned_files = authority_import_blob_cleanup(&mut transaction, import_id).await?;
        enqueue_authority_import_blob_cleanup(&mut transaction, import_id).await?;
        let collection_id = row.get::<Uuid, _>("collection_id");
        if row.get::<Option<String>, _>("restore_state").as_deref() == Some("transferred") {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'transferred', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(collection_id)
            .bind(row.get::<i64, _>("next_authority_epoch") - 1)
            .execute(&mut *transaction)
            .await?;
            sqlx::query("DELETE FROM hosted_provider_authority_imports WHERE id = $1")
                .bind(import_id)
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query(
                "DELETE FROM hosted_provider_collections WHERE id = $1 AND state = 'importing'",
            )
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.abort_authority_import_multipart(abandoned_files).await;
        self.working_sets.lock().await.remove(&result.collection_id);
        Ok(result)
    }

    pub async fn recover_expired_authority_imports(&self) -> ApiResult<usize> {
        let mut transaction = self.pool.begin().await?;
        let expired = sqlx::query(
            r#"SELECT collection_id FROM hosted_provider_authority_imports
               WHERE state IN ('receiving', 'uploaded') AND expires_at <= now()
               FOR UPDATE"#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        let collection_ids = expired
            .iter()
            .map(|row| row.get::<Uuid, _>("collection_id"))
            .collect::<Vec<_>>();
        let abandoned_files = expired_authority_import_blob_cleanup(&mut transaction).await?;
        let recovered = recover_expired_authority_imports_in(&mut transaction).await?;
        transaction.commit().await?;
        self.abort_authority_import_multipart(abandoned_files).await;
        if recovered > 0 {
            let mut working_sets = self.working_sets.lock().await;
            for collection_id in collection_ids {
                working_sets.remove(&collection_id);
            }
        }
        Ok(recovered)
    }
}
