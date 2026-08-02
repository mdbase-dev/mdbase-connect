use super::*;
use mdbase_connect_protocol::CollectionFileDescriptor;
pub(super) async fn authority_import_row(
    transaction: &mut Transaction<'_, Postgres>,
    import_id: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query(
        r#"SELECT import.id, import.collection_id, import.token_hash,
                  import.next_authority_epoch, import.state AS import_state,
                  import.manifest_ciphertext, import.manifest_digest,
                  import.source_revision, import.source_head,
                  import.expected_record_count, import.restore_state,
                  import.expires_at,
                  collection.wrapped_data_key, collection.max_records,
                  collection.max_content_bytes, collection.max_document_bytes,
                  collection.max_files, collection.max_file_bytes,
                  collection.max_stored_file_bytes, collection.max_single_file_bytes,
                  collection.state AS collection_state
           FROM hosted_provider_authority_imports import
           JOIN hosted_provider_collections collection ON collection.id = import.collection_id
           WHERE import.id = $1 FOR UPDATE"#,
    )
    .bind(import_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "authority_import_not_found",
            "Authority import was not found.",
        )
    })
}

pub(super) fn authorize_authority_import(row: &PgRow, token: &str) -> ApiResult<()> {
    let state = authority_import_state(row, "import_state")?;
    if !state.accepts_upload()
        || row.get::<DateTime<Utc>, _>("expires_at") <= Utc::now()
        || hosted_collection_state(row, "collection_state")? != HostedCollectionState::Importing
    {
        return Err(ApiError::conflict(
            "authority_import_inactive",
            "Authority import is no longer active.",
        ));
    }
    let expected: Vec<u8> = row.get("token_hash");
    let candidate = token_hash(token);
    if expected.len() != candidate.len() || !bool::from(expected.as_slice().ct_eq(&candidate)) {
        return Err(ApiError::unauthorized(
            "invalid_authority_import_token",
            "Authority import credential is invalid.",
        ));
    }
    Ok(())
}

pub(super) fn provider_authority_import(row: &PgRow) -> ApiResult<ProviderAuthorityImport> {
    let state = row
        .try_get::<String, _>("import_state")
        .or_else(|_| row.try_get::<String, _>("state"))?;
    Ok(ProviderAuthorityImport {
        id: row.get("id"),
        collection_id: row.get("collection_id"),
        authority_epoch: number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?,
        state: ProviderAuthorityImportState::try_from(state.as_str())?,
        manifest_digest: row.try_get("manifest_digest").unwrap_or(None),
        source_revision: row.try_get("source_revision").unwrap_or(None),
        source_head: row
            .try_get::<Option<i64>, _>("source_head")
            .unwrap_or(None)
            .map(|value| number(value, "source head"))
            .transpose()?,
        contracts: Vec::new(),
        expires_at: row.get("expires_at"),
    })
}

pub(super) async fn authority_import_contracts(
    provider: &HostedProvider,
    row: &PgRow,
) -> ApiResult<Vec<CollectionContractDescriptor>> {
    let collection_id: Uuid = row.get("collection_id");
    let wrapped_data_key: Vec<u8> = row.get("wrapped_data_key");
    let data_key = provider
        .crypto
        .unwrap_data_key(&wrapped_data_key, collection_id)
        .await?;
    let manifest_ciphertext: Option<Vec<u8>> = row.get("manifest_ciphertext");
    let manifest: AuthorityImportManifest = provider.crypto.decrypt_json(
        &data_key,
        &manifest_ciphertext.ok_or_else(|| {
            ApiError::conflict(
                "authority_import_not_ready",
                "Authority import manifest is missing.",
            )
        })?,
        &authority_import_manifest_aad(row.get("id")),
    )?;
    Ok(manifest.resources.contracts)
}

pub(super) async fn recover_expired_authority_imports_in(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<usize> {
    let expired = sqlx::query(
        r#"SELECT id, collection_id, next_authority_epoch, restore_state
           FROM hosted_provider_authority_imports
           WHERE state IN ('receiving', 'uploaded') AND expires_at <= now()
           FOR UPDATE"#,
    )
    .fetch_all(&mut **transaction)
    .await?;
    for row in &expired {
        sqlx::query(
            r#"INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason)
               SELECT staging_object_key, expected_size, 'expired authority import staging object'
               FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1
               UNION ALL
               SELECT committed_object_key, expected_size, 'expired authority import object'
               FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1
               ON CONFLICT DO NOTHING"#,
        )
        .bind(row.get::<Uuid, _>("id"))
        .execute(&mut **transaction)
        .await?;
        if row.get::<Option<String>, _>("restore_state").as_deref() == Some("transferred") {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'transferred', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(row.get::<Uuid, _>("collection_id"))
            .bind(row.get::<i64, _>("next_authority_epoch") - 1)
            .execute(&mut **transaction)
            .await?;
            sqlx::query("DELETE FROM hosted_provider_authority_imports WHERE id = $1")
                .bind(row.get::<Uuid, _>("id"))
                .execute(&mut **transaction)
                .await?;
        } else {
            sqlx::query(
                "DELETE FROM hosted_provider_collections WHERE id = $1 AND state = 'importing'",
            )
            .bind(row.get::<Uuid, _>("collection_id"))
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(expired.len())
}

pub(super) fn canonicalize_imported_snapshot(
    workspace: &WorkingSet,
    manifest: &AuthorityImportManifest,
    records: &[AuthorityImportRecord],
) -> ApiResult<Vec<AuthoritySnapshotRecord>> {
    let canonical = workspace.snapshot()?;
    if canonical.spec_version != manifest.resources.spec_version
        || canonical.resource_revision != manifest.resources.revision
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported collection resources do not match their declared revision.",
        ));
    }
    let resources = manifest
        .resources
        .documents
        .iter()
        .map(|resource| (resource.path.as_str(), resource))
        .collect::<BTreeMap<_, _>>();
    if resources.len() != canonical.resources.len()
        || canonical.resources.iter().any(|resource| {
            resources
                .get(resource.path.as_str())
                .is_none_or(|declared| {
                    declared.revision != resource.revision
                        || declared.document != resource.document
                        || declared.kind
                            != match resource.kind {
                                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => {
                                    "configuration"
                                }
                                mdbase::runtime::CollectionSnapshotResourceKind::Contract => {
                                    "contract"
                                }
                                mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema",
                                mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
                                mdbase::runtime::CollectionSnapshotResourceKind::View => "view",
                            }
                })
        })
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported resource documents are not canonical.",
        ));
    }
    let declared = records
        .iter()
        .map(|item| (item.path.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    if declared.len() != canonical.records.len()
        || canonical.records.iter().any(|record| {
            declared
                .get(record.path.as_str())
                .is_none_or(|item| item.document != record.document)
        })
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported record documents are not canonical.",
        ));
    }
    canonical
        .records
        .into_iter()
        .map(|record| {
            let uploaded = declared.get(record.path.as_str()).ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_authority_snapshot",
                    "Imported record is missing its stable identity.",
                )
            })?;
            Ok(AuthoritySnapshotRecord {
                record: SyncRecord {
                    record_id: uploaded.record_id,
                    path: record.path,
                    revision: record.revision,
                    frontmatter: record.frontmatter,
                    body: record.body,
                    types: record.types,
                },
                document: record.document,
            })
        })
        .collect()
}

pub(super) fn provider_authority_transfer(row: &PgRow) -> ApiResult<ProviderAuthorityTransfer> {
    Ok(ProviderAuthorityTransfer {
        id: row.get("id"),
        collection_id: row.get("collection_id"),
        replica_id: row.get("replica_id"),
        final_head: number(row.get::<i64, _>("final_head"), "collection head")?,
        authority_epoch: number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?,
        manifest_digest: row.get("manifest_digest"),
        state: authority_transfer_state(row)?,
        expires_at: row.get("expires_at"),
    })
}

pub(super) async fn recover_expired_authority_transfers_in(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<usize> {
    let expired = sqlx::query(
        r#"UPDATE hosted_provider_authority_transfers
           SET state = 'aborted', aborted_at = now()
           WHERE state = 'prepared' AND expires_at <= now()
           RETURNING collection_id"#,
    )
    .fetch_all(&mut **transaction)
    .await?;
    for row in &expired {
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'active', updated_at = now()
               WHERE id = $1 AND state = 'transferring'
                 AND NOT EXISTS (
                   SELECT 1 FROM hosted_provider_authority_transfers
                   WHERE collection_id = $1 AND state = 'prepared'
                 )"#,
        )
        .bind(row.get::<Uuid, _>("collection_id"))
        .execute(&mut **transaction)
        .await?;
    }
    Ok(expired.len())
}

pub(super) fn authority_manifest_digest(
    resources: Vec<(String, String)>,
    records: BTreeMap<Uuid, PersistedRecord>,
    files: Vec<CollectionFileDescriptor>,
) -> String {
    let mut entries = BTreeMap::<(String, String), (String, String)>::new();
    for (path, document) in resources {
        entries.insert(
            ("resource".to_string(), path),
            (String::new(), sha256_hex(document.as_bytes())),
        );
    }
    for persisted in records.into_values() {
        entries.insert(
            ("record".to_string(), persisted.record.path),
            (
                persisted.record.record_id.to_string(),
                sha256_hex(persisted.document.as_bytes()),
            ),
        );
    }
    for file in files {
        entries.insert(
            ("file".to_string(), file.path.clone()),
            (file.file_id.to_string(), authority_file_hash(&file)),
        );
    }
    authority_manifest_digest_from_hashes(entries)
}

pub(super) fn authority_manifest_digest_from_hashes(
    entries: BTreeMap<(String, String), (String, String)>,
) -> String {
    let mut manifest = Sha256::new();
    manifest.update(b"mdbase-authority-manifest-v2\n");
    for ((kind, path), (identity, document_hash)) in entries {
        manifest.update(kind.as_bytes());
        manifest.update(b"\0");
        manifest.update(path.as_bytes());
        manifest.update(b"\0");
        manifest.update(identity.as_bytes());
        manifest.update(b"\0");
        manifest.update(document_hash.as_bytes());
        manifest.update(b"\n");
    }
    hex_digest(&manifest.finalize())
}

pub(super) async fn load_authority_files(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<Vec<CollectionFileDescriptor>> {
    let rows = sqlx::query(
        r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
           FROM hosted_provider_files WHERE collection_id = $1"#,
    )
    .bind(collection_id)
    .fetch_all(&mut **transaction)
    .await?;
    rows.iter()
        .map(|row| {
            super::files::decode_current_file(crypto, data_key, collection_id, row)
                .map(|(file, _, _, _)| file)
        })
        .collect()
}

pub(super) fn sha256_hex(value: &[u8]) -> String {
    hex_digest(&Sha256::digest(value))
}

pub(super) fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
