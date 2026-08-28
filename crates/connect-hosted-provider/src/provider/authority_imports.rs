use super::authority_import_cleanup::{
    authority_import_blob_cleanup, enqueue_authority_import_blob_cleanup,
    expired_authority_import_blob_cleanup,
};
use super::files::{classify_media, validate_content_digest, validate_media_type};
use super::*;
use mdbase_connect_protocol::CollectionFileDescriptor;

impl HostedProvider {
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
        let staged_inventory = sqlx::query(
            r#"SELECT count(*)::bigint AS records,
                      coalesce(sum(content_bytes), 0)::bigint AS exact_bytes
               FROM hosted_provider_authority_import_records
               WHERE import_id = $1"#,
        )
        .bind(import_id)
        .fetch_one(&mut *transaction)
        .await?;
        let resource_bytes = manifest
            .resources
            .documents
            .iter()
            .try_fold(0_u64, |total, resource| {
                total.checked_add(resource.document.len() as u64)
            })
            .ok_or_else(|| {
                ApiError::quota(
                    "hosted_authority_bulk_budget_exceeded",
                    "The authority resource snapshot size overflowed.",
                )
            })?;
        ensure_authority_bulk_budget(
            number(
                staged_inventory.get::<i64, _>("records"),
                "authority import record count",
            )?,
            number(
                staged_inventory.get::<i64, _>("exact_bytes"),
                "authority import exact bytes",
            )?,
            resource_bytes,
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
        let workspace = AuthorityWorkspace::materialize(
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
            return self
                .completed_authority_import_receipt(
                    transaction,
                    &row,
                    row.get("collection_id"),
                    manifest_digest,
                    source_revision,
                )
                .await;
        }
        if !matches!(state.as_str(), "uploaded" | "indexing")
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
        if state == "uploaded" {
            let indexing = sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'indexing', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(collection_id)
            .bind(to_i64(authority_epoch, "authority epoch")?)
            .execute(&mut *transaction)
            .await?;
            if indexing.rows_affected() != 1 {
                return Err(ApiError::conflict(
                    "authority_import_target_unavailable",
                    "Authority import target is no longer pending.",
                ));
            }
            sqlx::query(
                "UPDATE hosted_provider_authority_imports SET state = 'indexing' WHERE id = $1",
            )
            .bind(import_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;

        let binding = sqlx::query(
            "SELECT head, resource_revision FROM hosted_provider_collections WHERE id = $1 AND state IN ('indexing', 'active')",
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import target is no longer indexing.",
            )
        })?;
        let projection = self
            .request_projection_indexing(
                collection_id,
                number(binding.get::<i64, _>("head"), "collection head")?,
                binding.get("resource_revision"),
            )
            .await?;
        let expected_generation_id = if projection.ready {
            projection.active_generation_id
        } else {
            projection
                .building_generation
                .as_ref()
                .map(|generation| generation.generation_id)
        };
        if !projection.ready {
            let generation = projection.building_generation.as_ref().ok_or_else(|| {
                ApiError::internal("Authority import indexing has no building generation.")
            })?;
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::BeforeProjectionAdvance,
            )
            .await;
            match self
                .advance_projection_generation(collection_id, generation.generation_id)
                .await
            {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "projection_lease_unavailable" | "projection_generation_not_building"
                    ) => {}
                Err(error) => return Err(error),
            };
        }

        self.projection_status(collection_id).await?;
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            import_id,
            crate::test_hooks::AuthorityImportHookPoint::BeforeSecondPhaseLock,
        )
        .await;
        self.complete_authority_import_second_phase(
            import_id,
            collection_id,
            manifest_digest,
            source_revision,
            expected_generation_id,
        )
        .await
    }

    async fn complete_authority_import_second_phase(
        &self,
        import_id: Uuid,
        collection_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
        expected_generation_id: Option<Uuid>,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        let state: String = row.get("import_state");
        if state == "completed" {
            return self
                .completed_authority_import_receipt(
                    transaction,
                    &row,
                    collection_id,
                    manifest_digest,
                    source_revision,
                )
                .await;
        }
        let collection_state: String = row.get("collection_state");
        if state != "indexing"
            || row.get::<Uuid, _>("collection_id") != collection_id
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
            || !matches!(collection_state.as_str(), "indexing" | "active")
            || row.get::<i64, _>("collection_authority_epoch")
                != row.get::<i64, _>("next_authority_epoch")
        {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import indexing state changed before completion.",
            ));
        }
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            import_id,
            crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
        )
        .await;
        let generations = lock_authority_import_projection_generations(
            &mut transaction,
            &row,
            expected_generation_id,
        )
        .await?;
        if !locked_authority_import_projection_ready(&row, &generations) {
            if locked_authority_import_projection_building(
                &row,
                &generations,
                expected_generation_id,
            ) {
                let mut result = provider_authority_import(&row)?;
                result.contracts = authority_import_contracts(self, &row).await?;
                transaction.commit().await?;
                return Ok(result);
            }
            let terminal_error_code =
                locked_authority_import_terminal_error(&row, &generations, expected_generation_id);
            return Err(authority_import_projection_handoff_error(
                terminal_error_code.as_deref(),
            ));
        }
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'completed', completed_at = now()
               WHERE id = $1 AND state = 'indexing'
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import indexing state changed before completion.",
            )
        })?;
        let mut result = provider_authority_import(&saved)?;
        result.contracts = authority_import_contracts(self, &row).await?;
        transaction.commit().await?;
        Ok(result)
    }

    async fn completed_authority_import_receipt(
        &self,
        mut transaction: Transaction<'_, Postgres>,
        row: &PgRow,
        collection_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            row.get("id"),
            crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
        )
        .await;
        let active_generation_id = row.get("active_projection_generation_id");
        let generations = lock_authority_import_projection_generations(
            &mut transaction,
            row,
            active_generation_id,
        )
        .await?;
        if !locked_authority_import_projection_ready(row, &generations)
            || row.get::<Uuid, _>("collection_id") != collection_id
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
            || row.get::<String, _>("collection_state") != "active"
            || row.get::<i64, _>("collection_authority_epoch")
                != row.get::<i64, _>("next_authority_epoch")
        {
            return Err(ApiError::conflict(
                "authority_import_not_ready",
                "Completed authority import does not match this snapshot.",
            ));
        }
        let mut result = provider_authority_import(row)?;
        result.contracts = authority_import_contracts(self, row).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn abort_authority_import(
        &self,
        import_id: Uuid,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        let import_state = authority_import_state(&row, "import_state")?;
        if import_state == ProviderAuthorityImportState::Completed {
            return Err(ApiError::conflict(
                "authority_import_completed",
                "Completed authority import cannot be cancelled.",
            ));
        }
        if import_state == ProviderAuthorityImportState::Indexing {
            return Err(ApiError::conflict(
                "authority_import_indexing",
                "An authority import cannot be cancelled after durable indexing begins.",
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
        Ok(result)
    }

    pub async fn recover_expired_authority_imports(&self) -> ApiResult<usize> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r#"SELECT collection_id FROM hosted_provider_authority_imports
               WHERE state IN ('receiving', 'uploaded') AND expires_at <= now()
               FOR UPDATE"#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        let abandoned_files = expired_authority_import_blob_cleanup(&mut transaction).await?;
        let recovered = recover_expired_authority_imports_in(&mut transaction).await?;
        transaction.commit().await?;
        self.abort_authority_import_multipart(abandoned_files).await;
        Ok(recovered)
    }

    pub(super) async fn finalize_indexed_authority_imports(&self, limit: u32) -> ApiResult<u64> {
        let mut finalized = 0_u64;
        let mut after = None;
        for _ in 0..limit.clamp(1, 100) {
            let mut transaction = self.pool.begin().await?;
            let candidate: Option<Uuid> = sqlx::query_scalar(
                r#"SELECT id
                   FROM hosted_provider_authority_imports
                   WHERE state = 'indexing'
                     AND ($1::uuid IS NULL OR id > $1)
                   ORDER BY id
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED"#,
            )
            .bind(after)
            .fetch_optional(&mut *transaction)
            .await?;
            let Some(import_id) = candidate else {
                transaction.commit().await?;
                break;
            };
            after = Some(import_id);
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::BeforeRecoveryFinalizerLock,
            )
            .await;
            let row = authority_import_row(&mut transaction, import_id).await?;
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
            )
            .await;
            let active_generation_id = row.get("active_projection_generation_id");
            let generations = lock_authority_import_projection_generations(
                &mut transaction,
                &row,
                active_generation_id,
            )
            .await?;
            if row.get::<String, _>("import_state") == "indexing"
                && row.get::<i64, _>("collection_authority_epoch")
                    == row.get::<i64, _>("next_authority_epoch")
                && locked_authority_import_projection_ready(&row, &generations)
            {
                let completed = sqlx::query(
                    r#"UPDATE hosted_provider_authority_imports
                       SET state = 'completed', completed_at = now()
                       WHERE id = $1 AND state = 'indexing'"#,
                )
                .bind(import_id)
                .execute(&mut *transaction)
                .await?;
                finalized += completed.rows_affected();
            }
            transaction.commit().await?;
        }
        Ok(finalized)
    }
}

async fn lock_authority_import_projection_generations(
    transaction: &mut Transaction<'_, Postgres>,
    row: &PgRow,
    expected_generation_id: Option<Uuid>,
) -> ApiResult<Vec<PgRow>> {
    let mut generation_ids = vec![
        row.get::<Option<Uuid>, _>("active_projection_generation_id"),
        expected_generation_id,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    generation_ids.sort_unstable();
    generation_ids.dedup();
    if generation_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query(
        r#"SELECT collection_id, generation_id, status, source_head,
                  source_resource_revision, projection_format_version,
                  semantic_engine_version, integrity_epoch,
                  integrity_verified_epoch, last_error_code
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = ANY($2)
           ORDER BY generation_id
           FOR UPDATE NOWAIT"#,
    )
    .bind(row.get::<Uuid, _>("collection_id"))
    .bind(&generation_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| match &error {
        sqlx::Error::Database(database) if database.code().as_deref() == Some("55P03") => {
            ApiError::conflict(
                "projection_lease_unavailable",
                "The projection generation lease is unavailable or fenced.",
            )
        }
        _ => ApiError::from(error),
    })
}

fn locked_generation(generations: &[PgRow], generation_id: Uuid) -> Option<&PgRow> {
    generations
        .iter()
        .find(|generation| generation.get::<Uuid, _>("generation_id") == generation_id)
}

fn locked_authority_import_projection_ready(row: &PgRow, generations: &[PgRow]) -> bool {
    let Some(active_generation_id) = row.get::<Option<Uuid>, _>("active_projection_generation_id")
    else {
        return false;
    };
    let Some(generation) = locked_generation(generations, active_generation_id) else {
        return false;
    };
    let current_format = i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION);
    row.get::<String, _>("collection_state") == "active"
        && generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "complete"
        && row.get::<Option<i64>, _>("active_projection_head")
            == Some(row.get::<i64, _>("collection_head"))
        && generation.get::<i64, _>("source_head") <= row.get::<i64, _>("active_projection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version")) == current_format
        && row.get::<Option<i32>, _>("collection_projection_format_version")
            == Some(generation.get::<i32, _>("projection_format_version"))
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && row.get::<Option<String>, _>("collection_projection_engine_version")
            == Some(generation.get::<String, _>("semantic_engine_version"))
        && generation.get::<i64, _>("integrity_epoch")
            == generation.get::<i64, _>("integrity_verified_epoch")
}

fn locked_authority_import_projection_building(
    row: &PgRow,
    generations: &[PgRow],
    expected_generation_id: Option<Uuid>,
) -> bool {
    let Some(generation_id) = expected_generation_id else {
        return false;
    };
    let Some(generation) = locked_generation(generations, generation_id) else {
        return false;
    };
    generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "building"
        && generation.get::<i64, _>("source_head") == row.get::<i64, _>("collection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version"))
            == i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && generation.get::<i64, _>("integrity_verified_epoch")
            <= generation.get::<i64, _>("integrity_epoch")
}

fn locked_authority_import_terminal_error(
    row: &PgRow,
    generations: &[PgRow],
    expected_generation_id: Option<Uuid>,
) -> Option<String> {
    let generation = locked_generation(generations, expected_generation_id?)?;
    (generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "abandoned"
        && generation.get::<i64, _>("source_head") == row.get::<i64, _>("collection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version"))
            == i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && generation.get::<i64, _>("integrity_verified_epoch")
            <= generation.get::<i64, _>("integrity_epoch"))
    .then(|| generation.get::<Option<String>, _>("last_error_code"))
    .flatten()
}

fn authority_import_projection_handoff_error(terminal_error_code: Option<&str>) -> ApiError {
    match terminal_error_code {
        Some("projection_authority_invalid") => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "projection_authority_invalid",
            "The exact projection authority is invalid.",
        ),
        Some("projection_semantic_failure") => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "projection_semantic_failure",
            "The exact authority could not produce a canonical semantic projection.",
        ),
        Some("projection_state_invalid") => ApiError::conflict(
            "projection_state_invalid",
            "The projection generation entered an invalid terminal state.",
        ),
        Some("projection_record_too_large") => ApiError::quota(
            "projection_record_too_large",
            "One exact record cannot fit the bounded projection rebuild window.",
        ),
        _ => ApiError::conflict(
            "projection_generation_not_building",
            "The requested projection generation is not the current building generation.",
        ),
    }
}
