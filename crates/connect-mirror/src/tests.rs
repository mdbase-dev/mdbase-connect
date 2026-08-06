use super::*;
use mdbase_connect_protocol::{
    CollectionFileDescriptor, FileMediaClass, SyncConflict, SyncMutationError, SyncResourceDocument,
};
use std::sync::Mutex;
use tempfile::TempDir;

#[derive(Deserialize)]
struct PortablePathFixtures {
    accepted: Vec<String>,
    rejected: Vec<String>,
    aliases: Vec<PortablePathAlias>,
}

#[derive(Deserialize)]
struct PortablePathAlias {
    left: String,
    right: String,
}

struct FakeAuthority {
    session: SyncSession,
    records: Mutex<BTreeMap<Uuid, SyncRecord>>,
    files: Mutex<BTreeMap<Uuid, (CollectionFileDescriptor, Vec<u8>)>>,
    changes: Mutex<Vec<SyncChange>>,
    mutations: Mutex<Vec<SyncMutation>>,
    receipts: Mutex<HashMap<Uuid, SyncMutationReceipt>>,
    next_receipt: Mutex<Option<SyncMutationReceipt>>,
    lose_next_response: Mutex<bool>,
}

impl FakeAuthority {
    fn new(replica_id: Uuid, mode: SyncReplicaMode, records: Vec<SyncRecord>) -> Self {
        let configuration = "spec_version: 0.3.0\n";
        Self {
            session: SyncSession {
                protocol_version: SYNC_PROTOCOL_VERSION,
                protocol_profile: mdbase_connect_protocol::SYNC_PROTOCOL_PROFILE.to_string(),
                session_id: Uuid::new_v4(),
                replica_id,
                collection_id: Uuid::new_v4(),
                mode,
                scope_epoch: 1,
                retained_after: 0,
                head: 1,
                snapshot_id: Uuid::new_v4(),
                resources: SyncCollectionResources {
                    revision: "resources-1".to_string(),
                    spec_version: "0.3.0".to_string(),
                    types: Vec::new(),
                    contracts: Vec::new(),
                    documents: vec![SyncResourceDocument {
                        path: "mdbase.yaml".to_string(),
                        kind: "configuration".to_string(),
                        revision: format!("sha256:{}", digest(configuration)),
                        document: configuration.to_string(),
                    }],
                },
            },
            records: Mutex::new(
                records
                    .into_iter()
                    .map(|record| (record.record_id, record))
                    .collect(),
            ),
            files: Mutex::new(BTreeMap::new()),
            changes: Mutex::new(Vec::new()),
            mutations: Mutex::new(Vec::new()),
            receipts: Mutex::new(HashMap::new()),
            next_receipt: Mutex::new(None),
            lose_next_response: Mutex::new(false),
        }
    }

    fn mutations(&self) -> Vec<SyncMutation> {
        self.mutations.lock().unwrap().clone()
    }

    fn reject_next(&self, record_id: Uuid) {
        *self.next_receipt.lock().unwrap() = Some(SyncMutationReceipt::Rejected {
            mutation_id: Uuid::nil(),
            error: SyncMutationError {
                code: "validation_failed".to_string(),
                message: "The hosted collection rejected this document.".to_string(),
            },
        });
        assert_ne!(record_id, Uuid::nil());
    }

    fn conflict_next(&self, record_id: Uuid, current: SyncRecord) {
        let mutation = SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: self.session.replica_id,
            scope_epoch: self.session.scope_epoch,
            operation: SyncMutationOperation::Put,
            record_id,
            base_revision: Some("r-1".to_string()),
            path: Some(current.path.clone()),
            document: Some(current.document.clone()),
            created_at: Utc::now().to_rfc3339(),
            causal_predecessor: None,
        };
        self.records
            .lock()
            .unwrap()
            .insert(current.record_id, current.clone());
        *self.next_receipt.lock().unwrap() = Some(SyncMutationReceipt::Conflicted {
            mutation_id: mutation.mutation_id,
            conflict: Box::new(SyncConflict {
                record_id: mutation.record_id,
                mutation,
                current_revision: Some(current.revision.clone()),
                current: Some(current),
            }),
        });
    }

    fn lose_next_response(&self) {
        *self.lose_next_response.lock().unwrap() = true;
    }

    fn emit_put(&self, record: SyncRecord) {
        let mut changes = self.changes.lock().unwrap();
        let sequence = changes.len() as u64 + 2;
        changes.push(SyncChange::Put { sequence, record });
    }

    fn put_file(
        &self,
        path: &str,
        bytes: &[u8],
        media_class: FileMediaClass,
    ) -> CollectionFileDescriptor {
        let descriptor = test_file(path, bytes, media_class);
        self.files
            .lock()
            .unwrap()
            .insert(descriptor.file_id, (descriptor.clone(), bytes.to_vec()));
        descriptor
    }

    fn emit_file_put(&self, file: CollectionFileDescriptor, bytes: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(file.file_id, (file.clone(), bytes.to_vec()));
        let mut changes = self.changes.lock().unwrap();
        let sequence = changes.len() as u64 + 2;
        changes.push(SyncChange::FilePut { sequence, file });
    }

    fn emit_file_remove(&self, file: &CollectionFileDescriptor) {
        self.files.lock().unwrap().remove(&file.file_id);
        let mut changes = self.changes.lock().unwrap();
        let sequence = changes.len() as u64 + 2;
        changes.push(SyncChange::FileRemove {
            sequence,
            file_id: file.file_id,
            previous_path: file.path.clone(),
            revision: file.revision.clone(),
        });
    }
}

#[tokio::test]
async fn conflicted_mutation_can_choose_remote_then_local() {
    let source = record("one.md", "One");
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, vec![source.clone()]);
    mirror.sync().await.unwrap();

    fs::write(mirror.root().join("one.md"), "local first").unwrap();
    let mut hosted = source.clone();
    hosted.revision = "r-hosted-1".to_string();
    hosted.body = "hosted first".to_string();
    refresh_revision(&mut hosted);
    authority.conflict_next(source.record_id, hosted.clone());
    mirror.sync().await.unwrap();
    mirror
        .resolve_conflict(source.record_id, MirrorResolution::Remote)
        .await
        .unwrap();
    assert!(fs::read_to_string(mirror.root().join("one.md"))
        .unwrap()
        .contains("hosted first"));
    assert!(mirror.status().unwrap().conflicts.is_empty());

    fs::write(mirror.root().join("one.md"), "local wins").unwrap();
    let mut hosted_again = hosted;
    hosted_again.revision = "r-hosted-2".to_string();
    hosted_again.body = "hosted again".to_string();
    refresh_revision(&mut hosted_again);
    authority.conflict_next(source.record_id, hosted_again);
    mirror.sync().await.unwrap();
    mirror
        .resolve_conflict(source.record_id, MirrorResolution::Local)
        .await
        .unwrap();
    mirror.sync().await.unwrap();
    assert!(authority
        .records
        .lock()
        .unwrap()
        .get(&source.record_id)
        .unwrap()
        .body
        .contains("local wins"));
    assert_eq!(mirror.status().unwrap().state, MirrorStatusState::UpToDate);
}

#[tokio::test]
async fn promotion_manifest_is_stable_and_refuses_unmanaged_markdown() {
    let source = record("tasks/a.md", "A");
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadWrite, vec![source]);
    let (_temporary, mirror, _authority) = custom_harness_with_selective_sync(
        authority,
        SelectiveSyncPolicy {
            file_classes: vec![
                FileMediaClass::Image,
                FileMediaClass::Audio,
                FileMediaClass::Video,
                FileMediaClass::Pdf,
                FileMediaClass::Other,
            ],
            excluded_folders: Vec::new(),
        },
    );
    mirror.sync().await.unwrap();
    let first = mirror.authority_promotion_manifest().unwrap();
    let second = mirror.authority_promotion_manifest().unwrap();
    assert_eq!(first, second);
    assert_eq!(first.cursor, 1);
    assert_eq!(first.digest.len(), 64);

    fs::write(mirror.root().join("unmanaged.md"), "not synchronized").unwrap();
    let error = mirror.authority_promotion_manifest().unwrap_err();
    assert_eq!(error.code, "promotion_unmanaged_files");
}

#[async_trait]
impl SyncTransport for FakeAuthority {
    async fn open_session(&self) -> Result<SyncSession, MirrorError> {
        Ok(self.session.clone())
    }

    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        _page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError> {
        Ok(SyncSnapshotPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            snapshot_id,
            scope_epoch: self.session.scope_epoch,
            cursor: self.session.head,
            records: self
                .records
                .lock()
                .unwrap()
                .values()
                .cloned()
                .map(|record| mdbase_connect_protocol::SyncSnapshotRecord { record })
                .collect(),
            next_page: None,
        })
    }

    async fn file_snapshot(
        &self,
        snapshot_id: Uuid,
        _page: Option<&str>,
    ) -> Result<SyncFileSnapshotPage, MirrorError> {
        Ok(SyncFileSnapshotPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            message_type: SyncFileSnapshotPageKind::FileSnapshotPage,
            snapshot_id,
            scope_epoch: self.session.scope_epoch,
            cursor: self.session.head,
            files: self
                .files
                .lock()
                .unwrap()
                .values()
                .map(|(file, _)| file.clone())
                .collect(),
            next_page: None,
        })
    }

    async fn download_file(
        &self,
        file: &CollectionFileDescriptor,
        destination: &Path,
    ) -> Result<(), MirrorError> {
        let files = self.files.lock().unwrap();
        let (current, bytes) = files.get(&file.file_id).ok_or_else(|| {
            MirrorError::new("file_not_found", "Fake authority file is unavailable.")
        })?;
        if current != file {
            return Err(MirrorError::new(
                "file_revision_unavailable",
                "Fake authority file revision changed.",
            ));
        }
        fs::write(destination, bytes)
            .map_err(|error| MirrorError::io("Could not write", destination, error))
    }

    async fn upload_file(
        &self,
        request: &OpenFileUploadRequest,
        source: &Path,
    ) -> Result<CommitFileUploadReceipt, MirrorError> {
        let bytes =
            fs::read(source).map_err(|error| MirrorError::io("Could not read", source, error))?;
        if bytes.len() as u64 != request.size
            || format!("sha256:{}", digest_bytes(&bytes)) != request.content_digest
        {
            return Err(MirrorError::new(
                "file_integrity_failed",
                "Fake upload bytes differ.",
            ));
        }
        let mut files = self.files.lock().unwrap();
        let prior_id = files
            .iter()
            .find(|(_, (file, _))| file.path == request.path)
            .map(|(id, _)| *id);
        let mut descriptor = test_file(&request.path, &bytes, classify_test_file(&request.path));
        if let Some(id) = prior_id {
            descriptor.file_id = id;
        }
        descriptor.media_type.clone_from(&request.media_type);
        files.insert(descriptor.file_id, (descriptor.clone(), bytes));
        Ok(CommitFileUploadReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
            transfer_id: request.transfer_id,
            file: descriptor,
        })
    }

    async fn move_file(&self, request: &MoveFileRequest) -> Result<MoveFileReceipt, MirrorError> {
        let mut files = self.files.lock().unwrap();
        let (mut file, bytes) = files
            .remove(&request.file_id)
            .ok_or_else(|| MirrorError::new("file_not_found", "Fake file is unavailable."))?;
        file.path.clone_from(&request.path);
        file.revision = format!("{}-moved", file.revision);
        files.insert(file.file_id, (file.clone(), bytes));
        Ok(MoveFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: MoveFileReceiptKind::FileMoved,
            mutation_id: request.mutation_id,
            file,
        })
    }

    async fn delete_file(
        &self,
        request: &DeleteFileRequest,
    ) -> Result<DeleteFileReceipt, MirrorError> {
        let (file, _) = self
            .files
            .lock()
            .unwrap()
            .remove(&request.file_id)
            .ok_or_else(|| MirrorError::new("file_not_found", "Fake file is unavailable."))?;
        Ok(DeleteFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: DeleteFileReceiptKind::FileDeleted,
            mutation_id: request.mutation_id,
            file_id: request.file_id,
            previous_path: file.path,
            revision: file.revision,
        })
    }

    async fn changes(&self, after: u64, _limit: usize) -> Result<SyncChangesPage, MirrorError> {
        let events = self
            .changes
            .lock()
            .unwrap()
            .iter()
            .filter(|event| match event {
                SyncChange::Put { sequence, .. }
                | SyncChange::Remove { sequence, .. }
                | SyncChange::FilePut { sequence, .. }
                | SyncChange::FileRemove { sequence, .. } => *sequence > after,
            })
            .cloned()
            .collect::<Vec<_>>();
        let cursor = events
            .last()
            .map(|event| match event {
                SyncChange::Put { sequence, .. }
                | SyncChange::Remove { sequence, .. }
                | SyncChange::FilePut { sequence, .. }
                | SyncChange::FileRemove { sequence, .. } => *sequence,
            })
            .unwrap_or(after);
        Ok(SyncChangesPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            scope_epoch: self.session.scope_epoch,
            events,
            cursor,
            head: cursor,
            has_more: false,
            reset_required: false,
        })
    }

    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError> {
        self.mutations.lock().unwrap().push(mutation.clone());
        if let Some(receipt) = self
            .receipts
            .lock()
            .unwrap()
            .get(&mutation.mutation_id)
            .cloned()
        {
            return Ok(receipt);
        }
        if let Some(mut receipt) = self.next_receipt.lock().unwrap().take() {
            match &mut receipt {
                SyncMutationReceipt::Rejected { mutation_id, .. }
                | SyncMutationReceipt::Conflicted { mutation_id, .. } => {
                    *mutation_id = mutation.mutation_id;
                }
                _ => {}
            }
            self.receipts
                .lock()
                .unwrap()
                .insert(mutation.mutation_id, receipt.clone());
            return Ok(receipt);
        }
        let mut records = self.records.lock().unwrap();
        let record = match mutation.operation {
            SyncMutationOperation::Put => {
                let path = mutation.path.as_deref().unwrap();
                let document = mutation.document.as_deref().unwrap();
                let (frontmatter, body) = parse_markdown(document, path).unwrap();
                Some(SyncRecord {
                    record_id: mutation.record_id,
                    path: path.to_string(),
                    document: document.to_string(),
                    revision: format!("sha256:{}", digest(document)),
                    frontmatter,
                    body,
                    types: Vec::new(),
                })
            }
            SyncMutationOperation::Move => {
                let existing = records.get(&mutation.record_id).unwrap();
                let mut updated = existing.clone();
                updated.path = mutation.path.as_deref().unwrap().to_string();
                Some(updated)
            }
            SyncMutationOperation::Delete => None,
        };
        if let Some(record) = &record {
            records.insert(record.record_id, record.clone());
        } else {
            records.remove(&mutation.record_id);
        }
        let receipt = SyncMutationReceipt::Applied {
            mutation_id: mutation.mutation_id,
            sequence: self.mutations.lock().unwrap().len() as u64 + 1,
            record,
        };
        self.receipts
            .lock()
            .unwrap()
            .insert(mutation.mutation_id, receipt.clone());
        if std::mem::take(&mut *self.lose_next_response.lock().unwrap()) {
            return Err(MirrorError::new(
                "mirror_offline",
                "The authority applied the mutation but its response was lost.",
            ));
        }
        Ok(receipt)
    }
}

fn record(path: &str, title: &str) -> SyncRecord {
    let document = format!("---\ntitle: {title}\n---\n\n# {title}\n");
    let mut record = SyncRecord {
        record_id: Uuid::new_v4(),
        path: path.to_string(),
        document,
        revision: String::new(),
        frontmatter: [("title".to_string(), Value::String(title.to_string()))]
            .into_iter()
            .collect(),
        body: format!("# {title}\n"),
        types: Vec::new(),
    };
    record.revision = format!(
        "sha256:{}",
        digest(&record_markdown_document(&record).unwrap())
    );
    record
}

fn refresh_revision(record: &mut SyncRecord) {
    let mapping = mdbase::frontmatter::parser::json_to_yaml_mapping(&Value::Object(
        record.frontmatter.clone(),
    ));
    let yaml = serde_yaml::to_string(&mapping).unwrap();
    let body = record.body.trim_start_matches('\n');
    record.document = format!("---\n{}---\n{}", yaml, body);
    record.revision = format!(
        "sha256:{}",
        digest(&record_markdown_document(record).unwrap())
    );
}

fn test_file(path: &str, bytes: &[u8], media_class: FileMediaClass) -> CollectionFileDescriptor {
    let content_digest = format!("sha256:{}", digest_bytes(bytes));
    CollectionFileDescriptor {
        file_id: Uuid::new_v4(),
        path: path.to_string(),
        revision: content_digest.clone(),
        content_digest,
        size: bytes.len() as u64,
        media_type: match media_class {
            FileMediaClass::Image => Some("image/png".to_string()),
            FileMediaClass::Audio => Some("audio/mpeg".to_string()),
            FileMediaClass::Video => Some("video/mp4".to_string()),
            FileMediaClass::Pdf => Some("application/pdf".to_string()),
            FileMediaClass::Other => None,
        },
        media_class,
        modified_at: Utc::now().to_rfc3339(),
    }
}

fn classify_test_file(path: &str) -> FileMediaClass {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" => FileMediaClass::Image,
        "mp3" | "wav" | "ogg" => FileMediaClass::Audio,
        "mp4" | "mov" | "webm" => FileMediaClass::Video,
        "pdf" => FileMediaClass::Pdf,
        _ => FileMediaClass::Other,
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn harness(
    mode: SyncReplicaMode,
    records: Vec<SyncRecord>,
) -> (TempDir, DirectoryMirror, Arc<FakeAuthority>) {
    let temporary = tempfile::tempdir().unwrap();
    let replica_id = Uuid::new_v4();
    let authority = Arc::new(FakeAuthority::new(replica_id, mode, records));
    let mirror = DirectoryMirror::new(
        temporary.path().join("mirror"),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        mode,
        authority.clone(),
    )
    .unwrap();
    (temporary, mirror, authority)
}

fn custom_harness(authority: FakeAuthority) -> (TempDir, DirectoryMirror, Arc<FakeAuthority>) {
    custom_harness_with_selective_sync(authority, SelectiveSyncPolicy::default())
}

fn custom_harness_with_selective_sync(
    authority: FakeAuthority,
    sync_policy: SelectiveSyncPolicy,
) -> (TempDir, DirectoryMirror, Arc<FakeAuthority>) {
    let temporary = tempfile::tempdir().unwrap();
    let replica_id = authority.session.replica_id;
    let mode = authority.session.mode;
    let authority = Arc::new(authority);
    let mirror = DirectoryMirror::new_with_selective_sync(
        temporary.path().join("mirror"),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        mode,
        sync_policy,
        authority.clone(),
    )
    .unwrap();
    (temporary, mirror, authority)
}

#[tokio::test]
async fn receive_only_materializes_and_refuses_divergence() {
    let source = record("notes/one.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);
    mirror.sync().await.unwrap();
    let path = mirror.root().join("notes/one.md");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        record_markdown_document(&source).unwrap()
    );
    fs::write(&path, "local edit").unwrap();
    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "mirror_diverged");
    assert_eq!(fs::read_to_string(path).unwrap(), "local edit");
}

#[tokio::test]
async fn metadata_only_mirror_checkpoints_file_changes_without_materializing() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadOnly, Vec::new());
    mirror.sync().await.unwrap();
    let bytes = b"not actually a png";
    let file = test_file("assets/photo.png", bytes, FileMediaClass::Image);
    authority.emit_file_put(file, bytes);

    mirror.sync().await.unwrap();
    mirror.sync().await.unwrap();
    assert!(!mirror.root().join("assets/photo.png").exists());
    assert_eq!(mirror.status().unwrap().cursor, Some(2));
}

#[tokio::test]
async fn initial_snapshot_materializes_only_selected_file_classes_and_folders() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let image = authority.put_file("assets/photo.png", b"image bytes", FileMediaClass::Image);
    let pdf = authority.put_file("documents/guide.pdf", b"pdf bytes", FileMediaClass::Pdf);
    authority.put_file(
        "private/secret.png",
        b"excluded image",
        FileMediaClass::Image,
    );
    authority.put_file("audio/theme.mp3", b"audio bytes", FileMediaClass::Audio);
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image, FileMediaClass::Pdf],
        excluded_folders: vec!["private".to_string()],
    };
    let (_temporary, mirror, _authority) = custom_harness_with_selective_sync(authority, policy);

    mirror.sync().await.unwrap();

    assert_eq!(
        fs::read(mirror.root().join(&image.path)).unwrap(),
        b"image bytes"
    );
    assert_eq!(
        fs::read(mirror.root().join(&pdf.path)).unwrap(),
        b"pdf bytes"
    );
    assert!(!mirror.root().join("private/secret.png").exists());
    assert!(!mirror.root().join("audio/theme.mp3").exists());
    assert_eq!(mirror.read_state().unwrap().unwrap().files.len(), 2);
}

#[tokio::test]
async fn excluded_folders_omit_markdown_and_files_without_prefix_matches() {
    let replica_id = Uuid::new_v4();
    let visible = record("notes/visible.md", "Visible");
    let excluded = record("private/hidden.md", "Hidden");
    let prefix_neighbor = record("private-notes/kept.md", "Kept");
    let authority = FakeAuthority::new(
        replica_id,
        SyncReplicaMode::ReadOnly,
        vec![visible.clone(), excluded.clone(), prefix_neighbor.clone()],
    );
    authority.put_file(
        "private/hidden.png",
        b"excluded image",
        FileMediaClass::Image,
    );
    authority.put_file(
        "private-notes/kept.png",
        b"kept image",
        FileMediaClass::Image,
    );
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: vec!["Private".to_string()],
    };
    let (_temporary, mirror, _authority) = custom_harness_with_selective_sync(authority, policy);

    mirror.sync().await.unwrap();

    assert!(mirror.root().join(&visible.path).exists());
    assert!(!mirror.root().join(&excluded.path).exists());
    assert!(mirror.root().join(&prefix_neighbor.path).exists());
    assert!(!mirror.root().join("private/hidden.png").exists());
    assert_eq!(
        fs::read(mirror.root().join("private-notes/kept.png")).unwrap(),
        b"kept image"
    );
    let state = mirror.read_state().unwrap().unwrap();
    assert_eq!(state.records.len(), 2);
    assert_eq!(state.files.len(), 1);
}

#[tokio::test]
async fn excluded_folders_use_portable_unicode_identity() {
    let replica_id = Uuid::new_v4();
    let excluded_path = "privat\u{65}\u{301}/hidden.md";
    let authority = FakeAuthority::new(
        replica_id,
        SyncReplicaMode::ReadOnly,
        vec![
            record("visible/kept.md", "Kept"),
            record(excluded_path, "Hidden"),
        ],
    );
    let policy = SelectiveSyncPolicy {
        file_classes: Vec::new(),
        excluded_folders: vec!["Privat\u{e9}".to_string()],
    };
    let (_temporary, mirror, _authority) = custom_harness_with_selective_sync(authority, policy);

    mirror.sync().await.unwrap();

    assert!(mirror.root().join("visible/kept.md").exists());
    assert!(!mirror.root().join(excluded_path).exists());
    assert_eq!(mirror.read_state().unwrap().unwrap().records.len(), 1);
}

#[tokio::test]
async fn incremental_record_moves_enter_and_leave_the_local_projection() {
    let replica_id = Uuid::new_v4();
    let source = record("notes/example.md", "Example");
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, vec![source.clone()]);
    let policy = SelectiveSyncPolicy {
        file_classes: Vec::new(),
        excluded_folders: vec!["archive".to_string()],
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();

    let mut archived = source.clone();
    archived.path = "archive/example.md".to_string();
    refresh_revision(&mut archived);
    authority.emit_put(archived.clone());
    mirror.sync().await.unwrap();
    assert!(!mirror.root().join(&source.path).exists());
    assert!(!mirror.root().join(&archived.path).exists());
    assert!(mirror.read_state().unwrap().unwrap().records.is_empty());

    let mut restored = archived;
    restored.path = "restored/example.md".to_string();
    restored.body = "# Restored\n".to_string();
    refresh_revision(&mut restored);
    authority.emit_put(restored.clone());
    mirror.sync().await.unwrap();
    assert_eq!(
        fs::read_to_string(mirror.root().join(&restored.path)).unwrap(),
        record_markdown_document(&restored).unwrap()
    );
}

#[tokio::test]
async fn writable_mirrors_never_upload_markdown_from_excluded_folders() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadWrite, Vec::new());
    let policy = SelectiveSyncPolicy {
        file_classes: Vec::new(),
        excluded_folders: vec!["drafts".to_string()],
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    fs::create_dir_all(mirror.root().join("drafts")).unwrap();
    fs::write(mirror.root().join("drafts/local.md"), "private draft").unwrap();
    fs::write(mirror.root().join("published.md"), "published").unwrap();

    mirror.sync().await.unwrap();

    let mutations = authority.mutations();
    assert_eq!(mutations.len(), 1);
    assert_eq!(mutations[0].path.as_deref(), Some("published.md"));
    assert_eq!(
        fs::read_to_string(mirror.root().join("drafts/local.md")).unwrap(),
        "private draft"
    );
}

#[tokio::test]
async fn writable_file_sync_uploads_updates_moves_and_deletes() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadWrite, Vec::new());
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    fs::create_dir_all(mirror.root().join("assets")).unwrap();
    fs::write(mirror.root().join("assets/new.png"), b"first").unwrap();

    mirror.sync().await.unwrap();
    let uploaded = authority
        .files
        .lock()
        .unwrap()
        .values()
        .find(|(file, _)| file.path == "assets/new.png")
        .unwrap()
        .0
        .clone();
    assert_eq!(
        uploaded.content_digest,
        format!("sha256:{}", digest_bytes(b"first"))
    );

    fs::write(mirror.root().join("assets/new.png"), b"second").unwrap();
    mirror.sync().await.unwrap();
    let updated = authority.files.lock().unwrap()[&uploaded.file_id].0.clone();
    assert_eq!(
        updated.content_digest,
        format!("sha256:{}", digest_bytes(b"second"))
    );

    fs::create_dir_all(mirror.root().join("archive")).unwrap();
    fs::rename(
        mirror.root().join("assets/new.png"),
        mirror.root().join("archive/new.png"),
    )
    .unwrap();
    mirror.sync().await.unwrap();
    assert_eq!(
        authority.files.lock().unwrap()[&uploaded.file_id].0.path,
        "archive/new.png"
    );

    fs::remove_file(mirror.root().join("archive/new.png")).unwrap();
    mirror.sync().await.unwrap();
    assert!(!authority
        .files
        .lock()
        .unwrap()
        .contains_key(&uploaded.file_id));
    assert!(mirror.read_state().unwrap().unwrap().files.is_empty());
}

#[tokio::test]
async fn incremental_file_update_move_and_remove_preserve_identity() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let original = authority.put_file("assets/photo.png", b"first revision", FileMediaClass::Image);
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();

    let mut updated = test_file(
        "assets/photo.png",
        b"second revision",
        FileMediaClass::Image,
    );
    updated.file_id = original.file_id;
    authority.emit_file_put(updated.clone(), b"second revision");
    mirror.sync().await.unwrap();
    assert_eq!(
        fs::read(mirror.root().join("assets/photo.png")).unwrap(),
        b"second revision"
    );

    let mut moved = test_file(
        "archive/photo.png",
        b"second revision",
        FileMediaClass::Image,
    );
    moved.file_id = original.file_id;
    authority.emit_file_put(moved.clone(), b"second revision");
    mirror.sync().await.unwrap();
    assert!(!mirror.root().join("assets/photo.png").exists());
    assert_eq!(
        fs::read(mirror.root().join("archive/photo.png")).unwrap(),
        b"second revision"
    );
    assert_eq!(
        mirror.read_state().unwrap().unwrap().files[&original.file_id]
            .file
            .path,
        "archive/photo.png"
    );

    authority.emit_file_remove(&moved);
    mirror.sync().await.unwrap();
    assert!(!mirror.root().join("archive/photo.png").exists());
    assert!(mirror.read_state().unwrap().unwrap().files.is_empty());
    assert_eq!(mirror.status().unwrap().cursor, Some(4));
}

#[tokio::test]
async fn local_file_edits_block_remote_changes_without_advancing_the_cursor() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let original = authority.put_file(
        "assets/photo.png",
        b"authority bytes",
        FileMediaClass::Image,
    );
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join(&original.path), b"important local edit").unwrap();
    let mut updated = test_file(
        "assets/photo.png",
        b"new authority bytes",
        FileMediaClass::Image,
    );
    updated.file_id = original.file_id;
    authority.emit_file_put(updated, b"new authority bytes");

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "mirror_diverged");
    assert_eq!(
        fs::read(mirror.root().join(&original.path)).unwrap(),
        b"important local edit"
    );
    assert_eq!(mirror.status().unwrap().cursor, Some(1));
}

#[tokio::test]
async fn corrupt_download_is_rejected_before_materialization_or_checkpoint() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    let file = test_file("assets/photo.png", b"declared bytes", FileMediaClass::Image);
    authority.emit_file_put(file.clone(), b"declared bytes");
    authority
        .files
        .lock()
        .unwrap()
        .get_mut(&file.file_id)
        .unwrap()
        .1 = b"corrupt".to_vec();

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "file_integrity_failed");
    assert!(!mirror.root().join(&file.path).exists());
    assert_eq!(mirror.status().unwrap().cursor, Some(1));
}

#[tokio::test]
async fn a_corrupt_file_keeps_the_entire_change_page_invisible() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    let valid = test_file("assets/valid.png", b"valid", FileMediaClass::Image);
    authority.emit_file_put(valid.clone(), b"valid");
    let corrupt = test_file("assets/corrupt.png", b"declared", FileMediaClass::Image);
    authority.emit_file_put(corrupt.clone(), b"wrong");

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "file_integrity_failed");
    assert!(!mirror.root().join(&valid.path).exists());
    assert!(!mirror.root().join(&corrupt.path).exists());
    assert_eq!(mirror.status().unwrap().cursor, Some(1));
}

#[tokio::test]
async fn selected_files_cannot_alias_collection_resources_or_use_hidden_paths() {
    for path in ["mdbase.yaml", ".hidden/photo.png"] {
        let replica_id = Uuid::new_v4();
        let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
        authority.put_file(path, b"hostile", FileMediaClass::Image);
        let policy = SelectiveSyncPolicy {
            file_classes: vec![FileMediaClass::Image],
            excluded_folders: Vec::new(),
        };
        let (_temporary, mirror, _authority) =
            custom_harness_with_selective_sync(authority, policy);

        let error = mirror.sync().await.unwrap_err();

        assert!(matches!(
            error.code.as_str(),
            "invalid_snapshot" | "invalid_file_path"
        ));
        assert!(!mirror.root().join(".hidden/photo.png").exists());
    }
}

#[tokio::test]
async fn changing_sync_policy_rebuilds_the_local_projection_both_ways() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let file = authority.put_file("assets/photo.png", b"image bytes", FileMediaClass::Image);
    let (temporary, metadata_only, authority) = custom_harness(authority);
    metadata_only.sync().await.unwrap();
    assert!(!metadata_only.root().join(&file.path).exists());

    let selected_policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let selected = DirectoryMirror::new_with_selective_sync(
        metadata_only.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        SyncReplicaMode::ReadOnly,
        selected_policy,
        authority.clone(),
    )
    .unwrap();
    selected.sync().await.unwrap();
    assert_eq!(
        fs::read(selected.root().join(&file.path)).unwrap(),
        b"image bytes"
    );

    let metadata_only_again = DirectoryMirror::new(
        selected.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        SyncReplicaMode::ReadOnly,
        authority,
    )
    .unwrap();
    metadata_only_again.sync().await.unwrap();
    assert!(!metadata_only_again.root().join(&file.path).exists());
    assert!(metadata_only_again
        .read_state()
        .unwrap()
        .unwrap()
        .files
        .is_empty());
}

#[tokio::test]
async fn changing_folder_exclusions_reconciles_markdown_without_deleting_authority_data() {
    let replica_id = Uuid::new_v4();
    let note = record("archive/note.md", "Archived");
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, vec![note.clone()]);
    let (temporary, full, authority) = custom_harness(authority);
    full.sync().await.unwrap();
    assert!(full.root().join(&note.path).exists());

    let excluded = DirectoryMirror::new_with_selective_sync(
        full.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        SyncReplicaMode::ReadOnly,
        SelectiveSyncPolicy {
            file_classes: Vec::new(),
            excluded_folders: vec!["archive".to_string()],
        },
        authority.clone(),
    )
    .unwrap();
    excluded.sync().await.unwrap();
    assert!(!excluded.root().join(&note.path).exists());
    assert!(authority
        .records
        .lock()
        .unwrap()
        .contains_key(&note.record_id));

    let restored = DirectoryMirror::new(
        excluded.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        SyncReplicaMode::ReadOnly,
        authority,
    )
    .unwrap();
    restored.sync().await.unwrap();
    assert!(restored.root().join(&note.path).exists());
}

#[tokio::test]
async fn successful_sync_prunes_only_unreferenced_complete_file_blobs() {
    let replica_id = Uuid::new_v4();
    let authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let file = authority.put_file(
        "assets/retained.png",
        b"retained cache bytes",
        FileMediaClass::Image,
    );
    let policy = SelectiveSyncPolicy {
        file_classes: vec![FileMediaClass::Image],
        excluded_folders: Vec::new(),
    };
    let (_temporary, mirror, _authority) = custom_harness_with_selective_sync(authority, policy);
    mirror.sync().await.unwrap();
    let cache = mirror.state_file.parent().unwrap().join("file-blobs");
    let retained = cache.join(file.content_digest.strip_prefix("sha256:").unwrap());
    let stale = cache.join("00".repeat(32));
    let incomplete = cache.join(format!("{}.download.tmp", "11".repeat(32)));
    fs::write(&stale, b"unreferenced").unwrap();
    fs::write(&incomplete, b"incomplete").unwrap();

    mirror.sync().await.unwrap();

    assert!(retained.exists());
    assert!(!stale.exists());
    assert!(incomplete.exists(), "pruning ignores non-blob work files");
}

#[test]
fn selective_sync_policy_rejects_hidden_reserved_and_ambiguous_preferences() {
    for policy in [
        SelectiveSyncPolicy {
            file_classes: vec![FileMediaClass::Image, FileMediaClass::Image],
            excluded_folders: Vec::new(),
        },
        SelectiveSyncPolicy {
            file_classes: Vec::new(),
            excluded_folders: vec![".hidden".to_string()],
        },
        SelectiveSyncPolicy {
            file_classes: Vec::new(),
            excluded_folders: vec!["Assets".to_string(), "assets".to_string()],
        },
        SelectiveSyncPolicy {
            file_classes: Vec::new(),
            excluded_folders: vec!["node_modules/cache".to_string()],
        },
    ] {
        assert!(validate_selective_sync_policy(&policy).is_err());
    }
}

#[tokio::test]
async fn writable_mirror_uploads_create_update_rename_and_delete() {
    let source = record("one.md", "One");
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, vec![source.clone()]);
    mirror.sync().await.unwrap();

    fs::write(
        mirror.root().join("one.md"),
        "---\ntitle: Updated\n---\nBody",
    )
    .unwrap();
    mirror.sync().await.unwrap();
    fs::rename(
        mirror.root().join("one.md"),
        mirror.root().join("renamed.md"),
    )
    .unwrap();
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join("new.md"), "A new body").unwrap();
    mirror.sync().await.unwrap();
    fs::remove_file(mirror.root().join("renamed.md")).unwrap();
    mirror.sync().await.unwrap();

    let operations = authority
        .mutations()
        .into_iter()
        .map(|mutation| mutation.operation)
        .collect::<Vec<_>>();
    assert_eq!(
        operations,
        vec![
            SyncMutationOperation::Put,
            SyncMutationOperation::Move,
            SyncMutationOperation::Put,
            SyncMutationOperation::Delete
        ]
    );
    assert_eq!(mirror.status().unwrap().state, MirrorStatusState::UpToDate);
}

#[tokio::test]
async fn malformed_frontmatter_is_uploaded_as_opaque_markdown() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, Vec::new());
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join("bad.md"), "---\n[invalid\n---\nBody").unwrap();
    fs::write(mirror.root().join("good.md"), "---\ntitle: Good\n---\nBody").unwrap();
    mirror.sync().await.unwrap();
    let status = mirror.status().unwrap();
    assert_eq!(status.state, MirrorStatusState::UpToDate);
    assert!(status.local_issues.is_empty());
    let mutations = authority.mutations();
    assert_eq!(mutations.len(), 2);
    let bad = mutations
        .iter()
        .find(|mutation| mutation.path.as_deref() == Some("bad.md"))
        .unwrap();
    assert_eq!(bad.document.as_deref(), Some("---\n[invalid\n---\nBody"));
}

#[tokio::test]
async fn rejected_mutation_survives_restart_and_can_keep_local() {
    let source = record("one.md", "One");
    let (temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, vec![source.clone()]);
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join("one.md"), "changed").unwrap();
    authority.reject_next(source.record_id);
    mirror.sync().await.unwrap();
    assert_eq!(mirror.status().unwrap().conflicts.len(), 1);

    let restarted = DirectoryMirror::new(
        mirror.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        authority.session.replica_id,
        SyncReplicaMode::ReadWrite,
        authority,
    )
    .unwrap();
    assert_eq!(restarted.status().unwrap().conflicts.len(), 1);
    restarted
        .resolve_conflict(source.record_id, MirrorResolution::Local)
        .await
        .unwrap();
    restarted.sync().await.unwrap();
    assert_eq!(
        restarted.status().unwrap().state,
        MirrorStatusState::UpToDate
    );
}

#[tokio::test]
async fn lost_mutation_response_replays_the_durable_mutation_id_after_restart() {
    let (temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, Vec::new());
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join("new.md"), "durable local change").unwrap();
    authority.lose_next_response();

    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "mirror_offline");
    assert_eq!(mirror.status().unwrap().pending, 1);
    let first_mutation_id = authority.mutations()[0].mutation_id;

    let restarted = DirectoryMirror::new(
        mirror.root(),
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        authority.session.replica_id,
        SyncReplicaMode::ReadWrite,
        authority.clone(),
    )
    .unwrap();
    restarted.sync().await.unwrap();

    let attempts = authority.mutations();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].mutation_id, first_mutation_id);
    assert_eq!(attempts[1].mutation_id, first_mutation_id);
    assert_eq!(authority.records.lock().unwrap().len(), 1);
    assert_eq!(
        restarted.status().unwrap().state,
        MirrorStatusState::UpToDate
    );
}

#[tokio::test]
async fn action_journal_is_append_only_replayable_and_ignores_a_torn_tail() {
    let source = record("one.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source]);
    let inspection = mirror.inspect_plan().await.unwrap();
    let mut state = mirror.prepare_batch(inspection).unwrap();
    let compact = fs::read(&mirror.state_file).unwrap();
    let action = state.batch.as_ref().unwrap().plan.actions[0].clone();
    let SyncAction::WriteLocal { action_id, .. } = action else {
        panic!("first exact snapshot action should materialize the record");
    };
    let record = state.batch.as_ref().unwrap().payloads.records[&action_id].clone();
    mirror.put_record(&mut state, record.clone(), None).unwrap();
    mirror
        .journal_receipt(
            &mut state,
            DurableReceipt {
                action_id,
                status: "completed".into(),
                record: Some(record),
                file: None,
            },
        )
        .unwrap();

    assert_eq!(fs::read(&mirror.state_file).unwrap(), compact);
    let journal = mirror.state_file.with_extension("journal.ndjson");
    assert!(fs::metadata(&journal).unwrap().len() > 0);
    let replayed = mirror.read_state().unwrap().unwrap();
    assert_eq!(replayed.batch.as_ref().unwrap().next_action, 1);
    assert_eq!(replayed.records.len(), 1);

    OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(b"{\"event\":\"receipt\"")
        .unwrap();
    assert_eq!(
        mirror
            .read_state()
            .unwrap()
            .unwrap()
            .batch
            .as_ref()
            .unwrap()
            .next_action,
        1
    );

    mirror.sync().await.unwrap();
    assert_eq!(mirror.status().unwrap().state, MirrorStatusState::UpToDate);
    assert_eq!(fs::metadata(journal).unwrap().len(), 0);
}

#[tokio::test]
async fn an_existing_folder_lease_refuses_a_second_sync() {
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, Vec::new());
    let _lease = MirrorLease::acquire(&mirror.lock_file).unwrap();
    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "mirror_folder_in_use");
}

#[tokio::test]
async fn corrupt_durable_state_fails_closed_without_reinitializing() {
    let source = record("one.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source]);
    mirror.sync().await.unwrap();
    fs::write(&mirror.state_file, b"{truncated").unwrap();
    let document = fs::read(mirror.root().join("one.md")).unwrap();

    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "invalid_mirror_state");
    assert_eq!(fs::read(mirror.root().join("one.md")).unwrap(), document);
    assert_eq!(fs::read(&mirror.state_file).unwrap(), b"{truncated");
}

#[tokio::test]
async fn initialization_collision_changes_nothing() {
    let source = record("one.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source]);
    fs::create_dir_all(mirror.root()).unwrap();
    fs::write(mirror.root().join("one.md"), "important local content").unwrap();
    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "local_collision");
    assert_eq!(
        fs::read_to_string(mirror.root().join("one.md")).unwrap(),
        "important local content"
    );
    assert!(!mirror.root().join("mdbase.yaml").exists());
}

#[tokio::test]
async fn inspection_is_deterministic_read_only_and_apply_rejects_a_stale_plan() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, Vec::new());

    let first = mirror.inspect().await.unwrap();
    let second = mirror.inspect().await.unwrap();
    assert_eq!(first, second);
    assert!(!mirror.state_file.exists());
    assert!(!mirror.root().join("mdbase.yaml").exists());
    assert!(authority.mutations().is_empty());

    fs::write(
        mirror.root().join("arrived-after-review.md"),
        "exact local bytes\r\n",
    )
    .unwrap();
    let stale = mirror.apply(&first).await.unwrap();
    assert_eq!(stale.status, "stale");
    assert_eq!(stale.failure.unwrap().code, "sync_plan_stale");
    assert!(authority.mutations().is_empty());
    assert!(!mirror.state_file.exists());

    let current = mirror.inspect().await.unwrap();
    assert_eq!(current.summary.uploads, 1);
    let result = mirror.apply(&current).await.unwrap();
    assert_eq!(result.status, "applied");
    assert_eq!(authority.mutations().len(), 1);
    assert_eq!(
        authority.mutations()[0].document.as_deref(),
        Some("exact local bytes\r\n")
    );
}

#[tokio::test]
async fn reviewed_plan_materializes_the_authority_document_byte_for_byte() {
    let document = "\u{feff}---\r\ntitle:  Odd  \r\n---\r\nbody with spaces  \r\n";
    let (frontmatter, body) = parse_markdown(document, "odd.md").unwrap();
    let source = SyncRecord {
        record_id: Uuid::new_v4(),
        path: "odd.md".to_string(),
        document: document.to_string(),
        revision: format!("sha256:{}", digest(document)),
        frontmatter,
        body,
        types: Vec::new(),
    };
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);

    let plan = mirror.inspect().await.unwrap();
    assert_eq!(plan.summary.downloads, 2);
    let result = mirror.apply(&plan).await.unwrap();
    assert_eq!(result.status, "applied");
    assert_eq!(
        fs::read(mirror.root().join("odd.md")).unwrap(),
        source.document.as_bytes()
    );
}

#[tokio::test]
async fn duplicate_snapshot_paths_fail_before_materialization() {
    let first = record("tasks/same.md", "One");
    let mut second = record("tasks/same.md", "Two");
    second.record_id = Uuid::new_v4();
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![first, second]);

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_snapshot");
    assert!(!mirror.root().join("mdbase.yaml").exists());
    assert!(!mirror.root().join("tasks/same.md").exists());
}

#[test]
fn portable_path_policy_matches_the_shared_cross_platform_fixtures() {
    let fixtures: PortablePathFixtures = serde_json::from_str(include_str!(
        "../../../test-fixtures/portable-mirror-paths.json"
    ))
    .unwrap();
    for path in fixtures.accepted {
        assert!(
            validate_portable_mirror_path(&path).is_ok(),
            "{path} should be portable"
        );
    }
    for path in fixtures.rejected {
        assert!(
            validate_portable_mirror_path(&path).is_err(),
            "{path:?} should be rejected"
        );
    }
    for alias in fixtures.aliases {
        assert_eq!(
            portable_mirror_path_key(&alias.left).unwrap(),
            portable_mirror_path_key(&alias.right).unwrap(),
            "{} and {} should share one physical path key",
            alias.left,
            alias.right
        );
    }
}

#[test]
fn rust_planner_matches_the_shared_cross_runtime_canonical_fixture() {
    let identity = "22222222-2222-4222-8222-222222222222";
    let object = |document: &str| SyncObjectRef {
        entity: SyncObjectKind::Record,
        identity: identity.into(),
        path: "notes/parity.md".into(),
        revision: format!("sha256:{}", digest(document)),
        payload_revision: format!("sha256:{}", digest(document)),
        size: None,
    };
    let base = ExpectedObjectState::Exact {
        object: object("base"),
    };
    let local = ExpectedObjectState::Exact {
        object: object("local"),
    };
    let plan = crate::sync_planner::plan_reconciliation(crate::sync_planner::InspectionSummary {
        boundary: crate::sync_planner::InspectionBoundary {
            replica_id: "11111111-1111-4111-8111-111111111111".into(),
            scope_epoch: 7,
            authority_cursor: 19,
            checkpoint: SyncCheckpoint {
                generation: 3,
                cursor: Some(11),
            },
        },
        mode: SyncReplicaMode::ReadWrite,
        kind: "incremental".into(),
        selective_sync: SelectiveSyncPolicy::default(),
        objects: vec![crate::sync_planner::InspectedObject {
            entity: SyncObjectKind::Record,
            identity: identity.into(),
            base: base.clone(),
            local: local.clone(),
            remote: base.clone(),
            local_target_owner: local,
            remote_target_owner: base,
            frozen_conflict: None,
        }],
        issues: Vec::new(),
    })
    .unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("../../../test-fixtures/sync-plan-parity.json")).unwrap();
    assert_eq!(
        serde_json::json!({
            "action_ids": plan.actions.iter().map(SyncAction::action_id).collect::<Vec<_>>(),
            "fingerprint": plan.fingerprint,
        }),
        expected
    );
}

#[test]
fn rust_planner_breaks_local_rename_cycles_with_the_same_staged_graph() {
    let object = |identity: &str, path: &str, document: &str| SyncObjectRef {
        entity: SyncObjectKind::Record,
        identity: identity.into(),
        path: path.into(),
        revision: format!("sha256:{}", digest(document)),
        payload_revision: format!("sha256:{}", digest(document)),
        size: None,
    };
    let a = object("a", "a.md", "exact a");
    let b = object("b", "b.md", "exact b");
    let remote_a = SyncObjectRef {
        path: "b.md".into(),
        ..a.clone()
    };
    let remote_b = SyncObjectRef {
        path: "a.md".into(),
        ..b.clone()
    };
    let exact = |object| ExpectedObjectState::Exact { object };
    let plan = crate::sync_planner::plan_reconciliation(crate::sync_planner::InspectionSummary {
        boundary: crate::sync_planner::InspectionBoundary {
            replica_id: "11111111-1111-4111-8111-111111111111".into(),
            scope_epoch: 7,
            authority_cursor: 19,
            checkpoint: SyncCheckpoint {
                generation: 3,
                cursor: Some(11),
            },
        },
        mode: SyncReplicaMode::ReadWrite,
        kind: "incremental".into(),
        selective_sync: SelectiveSyncPolicy::default(),
        objects: vec![
            crate::sync_planner::InspectedObject {
                entity: SyncObjectKind::Record,
                identity: "a".into(),
                base: exact(a.clone()),
                local: exact(a.clone()),
                remote: exact(remote_a),
                local_target_owner: exact(b.clone()),
                remote_target_owner: exact(a.clone()),
                frozen_conflict: None,
            },
            crate::sync_planner::InspectedObject {
                entity: SyncObjectKind::Record,
                identity: "b".into(),
                base: exact(b.clone()),
                local: exact(b.clone()),
                remote: exact(remote_b),
                local_target_owner: exact(a.clone()),
                remote_target_owner: exact(b),
                frozen_conflict: None,
            },
        ],
        issues: vec![],
    })
    .unwrap();

    assert_eq!(plan.actions.len(), 4);
    let SyncAction::MoveLocal {
        target_path,
        expected_target_owner,
        ..
    } = &plan.actions[0]
    else {
        panic!("first cycle action should be the staging move");
    };
    assert!(target_path.starts_with(".mdbase-sync-stage-"));
    assert!(target_path.ends_with(".md"));
    assert_eq!(expected_target_owner, &ExpectedObjectState::Absent);
    assert!(matches!(plan.actions[1], SyncAction::MoveLocal { .. }));
    assert!(matches!(plan.actions[2], SyncAction::MoveLocal { .. }));
    assert!(matches!(
        plan.actions[3],
        SyncAction::AdvanceCheckpoint { .. }
    ));
    assert!(plan.actions[1]
        .depends_on()
        .contains(&plan.actions[0].action_id().to_string()));
    assert!(plan.actions[2]
        .depends_on()
        .contains(&plan.actions[1].action_id().to_string()));
}

#[test]
fn rust_planner_orders_remote_vacancy_and_receipt_dependencies_separately() {
    let object = |identity: &str, path: &str, document: &str| SyncObjectRef {
        entity: SyncObjectKind::Record,
        identity: identity.into(),
        path: path.into(),
        revision: format!("sha256:{}", digest(document)),
        payload_revision: format!("sha256:{}", digest(document)),
        size: None,
    };
    let base_a = object("a", "a.md", "old a");
    let local_a = object("a", "b.md", "new a");
    let base_b = object("b", "b.md", "b");
    let exact = |object| ExpectedObjectState::Exact { object };
    let plan = crate::sync_planner::plan_reconciliation(crate::sync_planner::InspectionSummary {
        boundary: crate::sync_planner::InspectionBoundary {
            replica_id: "11111111-1111-4111-8111-111111111111".into(),
            scope_epoch: 7,
            authority_cursor: 19,
            checkpoint: SyncCheckpoint {
                generation: 3,
                cursor: Some(11),
            },
        },
        mode: SyncReplicaMode::ReadWrite,
        kind: "incremental".into(),
        selective_sync: SelectiveSyncPolicy::default(),
        objects: vec![
            crate::sync_planner::InspectedObject {
                entity: SyncObjectKind::Record,
                identity: "a".into(),
                base: exact(base_a.clone()),
                local: exact(local_a.clone()),
                remote: exact(base_a.clone()),
                local_target_owner: exact(local_a),
                remote_target_owner: exact(base_b.clone()),
                frozen_conflict: None,
            },
            crate::sync_planner::InspectedObject {
                entity: SyncObjectKind::Record,
                identity: "b".into(),
                base: exact(base_b.clone()),
                local: ExpectedObjectState::Absent,
                remote: exact(base_b.clone()),
                local_target_owner: ExpectedObjectState::Absent,
                remote_target_owner: exact(base_b),
                frozen_conflict: None,
            },
        ],
        issues: vec![],
    })
    .unwrap();

    assert!(matches!(plan.actions[0], SyncAction::PutRemote { .. }));
    assert!(matches!(plan.actions[1], SyncAction::DeleteRemote { .. }));
    let SyncAction::MoveRemote {
        depends_on,
        revision_from_dependency,
        expected_target_owner,
        ..
    } = &plan.actions[2]
    else {
        panic!("third action should be the now-vacant remote move");
    };
    assert!(depends_on.contains(&plan.actions[0].action_id().to_string()));
    assert!(depends_on.contains(&plan.actions[1].action_id().to_string()));
    assert_eq!(
        revision_from_dependency.as_deref(),
        Some(plan.actions[0].action_id())
    );
    assert_eq!(expected_target_owner, &ExpectedObjectState::Absent);
}

#[test]
fn rust_plan_only_architecture_has_enforced_responsibility_boundaries() {
    let planner = include_str!("sync_planner.rs");
    let path_planner = include_str!("sync_path_planner.rs");
    for source in [planner, path_planner] {
        assert!(!source.contains("DirectoryMirror"));
        assert!(!source.contains("std::fs"));
        assert!(!source.contains("transport"));
        assert!(!source.contains("async fn"));
    }

    let executor = include_str!("sync_executor.rs");
    for forbidden in [
        "inspect_plan",
        "plan_reconciliation",
        "open_session",
        ".snapshot(",
        ".changes(",
    ] {
        assert!(
            !executor.contains(forbidden),
            "executor gained {forbidden} capability"
        );
    }

    for (name, source) in [
        ("directory_plan", include_str!("directory_plan.rs")),
        ("directory_sync", include_str!("directory_sync.rs")),
        ("sync_inspector", include_str!("sync_inspector.rs")),
        ("sync_executor", executor),
        ("sync_journal", include_str!("sync_journal.rs")),
        ("sync_revalidator", include_str!("sync_revalidator.rs")),
    ] {
        assert!(
            !source.contains("action: SyncAction::"),
            "{name} constructed a command outside the pure planner"
        );
        assert!(
            !source.contains("state.cursor =") && !source.contains("state.generation ="),
            "{name} advanced a checkpoint outside checkpoint authority"
        );
    }
}

#[tokio::test]
async fn snapshot_rejects_cross_platform_path_aliases_before_materialization() {
    let first = record("Notes/Example.md", "One");
    let second = record("notes/example.md", "Two");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![first, second]);

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_snapshot");
    assert!(!mirror.root().join("mdbase.yaml").exists());
    assert!(!mirror.root().join("Notes/Example.md").exists());
    assert!(!mirror.root().join("notes/example.md").exists());
}

#[tokio::test]
async fn incremental_puts_reject_aliases_owned_by_another_record() {
    for path in ["Notes/Example.md", "notes/example.md"] {
        let source = record("Notes/Example.md", "Same");
        let (_temporary, mirror, authority) =
            harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);
        mirror.sync().await.unwrap();
        let mut alias = source.clone();
        alias.record_id = Uuid::new_v4();
        alias.path = path.to_string();
        refresh_revision(&mut alias);
        authority.emit_put(alias);

        let error = mirror.sync().await.unwrap_err();

        assert_eq!(error.code, "invalid_record_path");
        assert!(mirror.root().join("Notes/Example.md").exists());
        assert!(!mirror.root().join("notes/example.md").exists() || path == "Notes/Example.md");
    }
}

#[tokio::test]
async fn incremental_put_rejects_a_same_record_case_only_rename() {
    let source = record("Notes/Example.md", "Original");
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);
    mirror.sync().await.unwrap();
    let mut renamed = source.clone();
    renamed.path = "notes/example.md".to_string();
    renamed.body = "# Updated\n".to_string();
    refresh_revision(&mut renamed);
    authority.emit_put(renamed.clone());

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_record_path");
    assert!(mirror.root().join(&source.path).exists());
    assert!(!mirror.root().join(&renamed.path).exists());
}

#[tokio::test]
async fn incremental_pages_are_preflighted_before_writing_aliased_records() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadOnly, Vec::new());
    mirror.sync().await.unwrap();
    authority.emit_put(record("Notes/Example.md", "One"));
    authority.emit_put(record("notes/example.md", "Two"));

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_record_path");
    assert!(!mirror.root().join("Notes/Example.md").exists());
    assert!(!mirror.root().join("notes/example.md").exists());
}

#[tokio::test]
async fn writable_capture_rejects_local_cross_platform_aliases_before_upload() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, Vec::new());
    fs::create_dir_all(mirror.root().join("Notes")).unwrap();
    fs::create_dir_all(mirror.root().join("notes")).unwrap();
    fs::write(mirror.root().join("Notes/Example.md"), "One").unwrap();
    fs::write(mirror.root().join("notes/example.md"), "Two").unwrap();

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_record_path");
    assert!(authority.mutations().is_empty());
}

#[tokio::test]
async fn persisted_state_rejects_cross_platform_path_aliases() {
    let source = record("Notes/Example.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);
    mirror.sync().await.unwrap();
    let mut state = mirror.read_state().unwrap().unwrap();
    let mut alias = state.records[&source.record_id].clone();
    alias.path = "notes/example.md".to_string();
    state.records.insert(Uuid::new_v4(), alias);
    mirror.write_state(&state).unwrap();

    let error = mirror.status().unwrap_err();

    assert_eq!(error.code, "invalid_mirror_state");
}

#[tokio::test]
async fn snapshot_records_cannot_materialize_executables_or_hidden_hooks() {
    for path in ["payload.bat", ".git/hooks/post-checkout.md"] {
        let replica_id = Uuid::new_v4();
        let authority = FakeAuthority::new(
            replica_id,
            SyncReplicaMode::ReadOnly,
            vec![record(path, "Hostile")],
        );
        let (_temporary, mirror, _authority) = custom_harness(authority);

        let error = mirror.sync().await.unwrap_err();

        assert_eq!(error.code, "invalid_record_path");
        assert!(!mirror.root().join(path).exists());
        assert!(!mirror.root().join("mdbase.yaml").exists());
    }
}

#[tokio::test]
async fn authority_configuration_cannot_enable_executable_record_extensions() {
    let replica_id = Uuid::new_v4();
    let mut authority = FakeAuthority::new(
        replica_id,
        SyncReplicaMode::ReadOnly,
        vec![record("payload.bat", "Hostile")],
    );
    let configuration = "spec_version: 0.3.0\nsettings:\n  record_extensions: [bat]\n";
    authority.session.resources.documents[0].document = configuration.to_string();
    authority.session.resources.documents[0].revision = format!("sha256:{}", digest(configuration));
    let (_temporary, mirror, _authority) = custom_harness(authority);

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_record_path");
    assert!(!mirror.root().join("payload.bat").exists());
    assert!(!mirror.root().join("mdbase.yaml").exists());
}

#[tokio::test]
async fn snapshot_resource_kinds_cannot_write_arbitrary_json_files() {
    let replica_id = Uuid::new_v4();
    let mut authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let document = "{\"scripts\":{\"postinstall\":\"malware\"}}\n";
    authority
        .session
        .resources
        .documents
        .push(SyncResourceDocument {
            path: "package.json".to_string(),
            kind: "schema".to_string(),
            revision: format!("sha256:{}", digest(document)),
            document: document.to_string(),
        });
    let (_temporary, mirror, _authority) = custom_harness(authority);

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_snapshot");
    assert!(!mirror.root().join("package.json").exists());
    assert!(!mirror.root().join("mdbase.yaml").exists());
}

#[tokio::test]
async fn snapshot_resources_reject_platform_aliased_paths() {
    let replica_id = Uuid::new_v4();
    let mut authority = FakeAuthority::new(replica_id, SyncReplicaMode::ReadOnly, Vec::new());
    let document = "{\"type\":\"object\"}\n";
    authority
        .session
        .resources
        .documents
        .push(SyncResourceDocument {
            path: "schemas/CON.json".to_string(),
            kind: "schema".to_string(),
            revision: format!("sha256:{}", digest(document)),
            document: document.to_string(),
        });
    let (_temporary, mirror, _authority) = custom_harness(authority);

    let error = mirror.sync().await.unwrap_err();

    assert_eq!(error.code, "invalid_snapshot");
    assert!(!mirror.root().join("schemas/CON.json").exists());
}

#[tokio::test]
async fn incremental_record_puts_recheck_the_live_collection_policy() {
    let source = record("notes/one.md", "One");
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source.clone()]);
    mirror.sync().await.unwrap();
    let mut state = mirror.read_state().unwrap().unwrap();
    let mut hostile = source;
    hostile.path = "payload.exe".to_string();
    hostile.body = "malware".to_string();
    refresh_revision(&mut hostile);

    let error = mirror.put_record(&mut state, hostile, None).unwrap_err();

    assert_eq!(error.code, "invalid_sync_plan");
    assert!(!mirror.root().join("payload.exe").exists());
    assert!(mirror.root().join("notes/one.md").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escape_is_refused() {
    use std::os::unix::fs::symlink;
    let source = record("outside/note.md", "No");
    let (temporary, mirror, _authority) = harness(SyncReplicaMode::ReadOnly, vec![source]);
    let outside = temporary.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, mirror.root().join("outside")).unwrap();
    let error = mirror.sync().await.unwrap_err();
    assert_eq!(error.code, "mirror_symlink_refused");
    assert!(!outside.join("note.md").exists());
}

#[cfg(unix)]
#[test]
fn mirror_marker_refuses_a_symlinked_metadata_directory() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let mirror = temporary.path().join("mirror");
    let outside = temporary.path().join("outside");
    fs::create_dir_all(&mirror).unwrap();
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, mirror.join(".mdbase")).unwrap();

    let error = mark_mirror(&mirror, Uuid::new_v4()).unwrap_err();

    assert_eq!(error.code, "mirror_symlink_refused");
    assert!(!outside.join("connect-role.json").exists());
}

#[cfg(unix)]
#[test]
fn mirror_engine_refuses_a_symlinked_root() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let outside = temporary.path().join("outside");
    let mirror_path = temporary.path().join("mirror");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, &mirror_path).unwrap();
    let replica_id = Uuid::new_v4();
    let authority = Arc::new(FakeAuthority::new(
        replica_id,
        SyncReplicaMode::ReadOnly,
        Vec::new(),
    ));

    let error = match DirectoryMirror::new(
        &mirror_path,
        temporary.path().join("state/state.json"),
        temporary.path().join("locks/mirror.lock"),
        replica_id,
        SyncReplicaMode::ReadOnly,
        authority,
    ) {
        Ok(_) => panic!("symlinked mirror root was accepted"),
        Err(error) => error,
    };

    assert_eq!(error.code, "mirror_symlink_refused");
}

#[test]
fn hostile_paths_are_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    for path in ["../escape.md", "/absolute.md", "a/../../escape.md", ""] {
        let error = safe_path(temporary.path(), path).unwrap_err();
        assert_eq!(error.code, "mirror_path_escape");
    }
}

#[test]
fn marker_refuses_a_local_authority() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(
        temporary.path().join("mdbase.yaml"),
        "version: 0.3\nx-mdbase-connect:\n  collection_id: 01900000-0000-7000-8000-000000000000\n",
    )
    .unwrap();
    let error = mark_mirror(temporary.path(), Uuid::new_v4()).unwrap_err();
    assert_eq!(error.code, "local_authority_requires_transfer");
}
