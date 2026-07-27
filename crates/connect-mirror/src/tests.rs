use super::*;
use mdbase_connect_protocol::{SyncConflict, SyncMutationError, SyncResourceDocument};
use std::sync::Mutex;
use tempfile::TempDir;

struct FakeAuthority {
    session: SyncSession,
    records: Mutex<BTreeMap<Uuid, SyncRecord>>,
    mutations: Mutex<Vec<SyncMutation>>,
    receipts: Mutex<HashMap<Uuid, SyncMutationReceipt>>,
    next_receipt: Mutex<Option<SyncMutationReceipt>>,
    lose_next_response: Mutex<bool>,
}

impl FakeAuthority {
    fn new(replica_id: Uuid, mode: SyncReplicaMode, records: Vec<SyncRecord>) -> Self {
        Self {
            session: SyncSession {
                protocol_version: SYNC_PROTOCOL_VERSION,
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
                    spec_version: "0.3".to_string(),
                    types: Vec::new(),
                    contracts: Vec::new(),
                    documents: vec![SyncResourceDocument {
                        path: "mdbase.yaml".to_string(),
                        kind: "configuration".to_string(),
                        revision: "config-1".to_string(),
                        document: "version: 0.3\n".to_string(),
                    }],
                },
            },
            records: Mutex::new(
                records
                    .into_iter()
                    .map(|record| (record.record_id, record))
                    .collect(),
            ),
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
            operation: SyncMutationOperation::Update,
            record_id,
            base_revision: Some("r-1".to_string()),
            input: Map::new(),
            created_at: Utc::now().to_rfc3339(),
            causal_predecessor: None,
        };
        self.records
            .lock()
            .unwrap()
            .insert(current.record_id, current.clone());
        *self.next_receipt.lock().unwrap() = Some(SyncMutationReceipt::Conflicted {
            mutation_id: mutation.mutation_id,
            conflict: SyncConflict {
                record_id: mutation.record_id,
                mutation,
                current_revision: Some(current.revision.clone()),
                current: Some(current),
            },
        });
    }

    fn lose_next_response(&self) {
        *self.lose_next_response.lock().unwrap() = true;
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
    let (_temporary, mirror, _authority) = harness(SyncReplicaMode::ReadWrite, vec![source]);
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
            records: self.records.lock().unwrap().values().cloned().collect(),
            next_page: None,
        })
    }

    async fn changes(&self, after: u64, _limit: usize) -> Result<SyncChangesPage, MirrorError> {
        Ok(SyncChangesPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            scope_epoch: self.session.scope_epoch,
            events: Vec::new(),
            cursor: after,
            head: after,
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
            SyncMutationOperation::Create => Some(SyncRecord {
                record_id: mutation.record_id,
                path: mutation.input["path"].as_str().unwrap().to_string(),
                revision: format!("r-{}", self.mutations.lock().unwrap().len()),
                frontmatter: mutation.input["frontmatter"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                body: mutation.input["body"].as_str().unwrap_or("").to_string(),
                types: Vec::new(),
            }),
            SyncMutationOperation::Update => {
                let existing = records.get(&mutation.record_id).unwrap();
                let mut updated = existing.clone();
                updated.revision = format!("r-{}", self.mutations.lock().unwrap().len());
                if let Some(patch) = mutation.input["patch"].as_object() {
                    for (key, value) in patch {
                        if value.is_null() {
                            updated.frontmatter.remove(key);
                        } else {
                            updated.frontmatter.insert(key.clone(), value.clone());
                        }
                    }
                }
                updated.body = mutation.input["body"].as_str().unwrap_or("").to_string();
                Some(updated)
            }
            SyncMutationOperation::Rename => {
                let existing = records.get(&mutation.record_id).unwrap();
                let mut updated = existing.clone();
                updated.revision = format!("r-{}", self.mutations.lock().unwrap().len());
                updated.path = mutation.input["path"].as_str().unwrap().to_string();
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
    SyncRecord {
        record_id: Uuid::new_v4(),
        path: path.to_string(),
        revision: "r-1".to_string(),
        frontmatter: object([("title", Value::String(title.to_string()))]),
        body: format!("# {title}\n"),
        types: Vec::new(),
    }
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
            SyncMutationOperation::Update,
            SyncMutationOperation::Rename,
            SyncMutationOperation::Create,
            SyncMutationOperation::Delete
        ]
    );
    assert_eq!(mirror.status().unwrap().state, MirrorStatusState::UpToDate);
}

#[tokio::test]
async fn malformed_frontmatter_is_isolated_without_blocking_other_files() {
    let (_temporary, mirror, authority) = harness(SyncReplicaMode::ReadWrite, Vec::new());
    mirror.sync().await.unwrap();
    fs::write(mirror.root().join("bad.md"), "---\n[invalid\n---\nBody").unwrap();
    fs::write(mirror.root().join("good.md"), "---\ntitle: Good\n---\nBody").unwrap();
    mirror.sync().await.unwrap();
    let status = mirror.status().unwrap();
    assert_eq!(status.state, MirrorStatusState::Attention);
    assert_eq!(status.local_issues.len(), 1);
    assert_eq!(status.local_issues[0].path, "bad.md");
    assert_eq!(authority.mutations().len(), 1);
    assert_eq!(authority.mutations()[0].input["path"], "good.md");
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
    assert_eq!(error.code, "mirror_initialization_conflict");
    assert_eq!(
        fs::read_to_string(mirror.root().join("one.md")).unwrap(),
        "important local content"
    );
    assert!(!mirror.root().join("mdbase.yaml").exists());
}

#[tokio::test]
async fn interrupted_initial_snapshot_resumes_from_its_durable_plan() {
    let first = record("tasks/one.md", "One");
    let second = record("tasks/two.md", "Two");
    let (_temporary, mirror, authority) = harness(
        SyncReplicaMode::ReadOnly,
        vec![first.clone(), second.clone()],
    );
    let plan = DurableRebuildPlan {
        protocol_version: SYNC_PROTOCOL_VERSION,
        replica_id: authority.session.replica_id,
        mode: SyncReplicaMode::ReadOnly,
        session: authority.session.clone(),
        records: vec![first.clone(), second.clone()],
        prior: None,
    };
    mirror.write_rebuild_plan(&plan).unwrap();
    mirror
        .write_file(
            &authority.session.resources.documents[0].path,
            authority.session.resources.documents[0].document.as_bytes(),
        )
        .unwrap();
    mirror
        .write_file(
            &first.path,
            record_markdown_document(&first).unwrap().as_bytes(),
        )
        .unwrap();

    mirror.sync().await.unwrap();

    assert_eq!(
        fs::read_to_string(mirror.root().join(&second.path)).unwrap(),
        record_markdown_document(&second).unwrap()
    );
    assert!(!mirror.rebuild_plan_file().exists());
    assert_eq!(mirror.status().unwrap().state, MirrorStatusState::UpToDate);
}

#[tokio::test]
async fn reset_snapshot_removes_old_paths_after_a_remote_rename_and_delete() {
    let first = record("tasks/one.md", "One");
    let removed = record("tasks/remove.md", "Remove");
    let (_temporary, mirror, authority) = harness(
        SyncReplicaMode::ReadOnly,
        vec![first.clone(), removed.clone()],
    );
    mirror.sync().await.unwrap();
    let mut renamed = first.clone();
    renamed.path = "archive/one.md".to_string();
    renamed.revision = "r-2".to_string();
    renamed.body = "# Renamed\n".to_string();
    let mut session = authority.session.clone();
    session.scope_epoch = 2;
    session.head = 2;
    session.snapshot_id = Uuid::new_v4();
    let plan = DurableRebuildPlan {
        protocol_version: SYNC_PROTOCOL_VERSION,
        replica_id: authority.session.replica_id,
        mode: SyncReplicaMode::ReadOnly,
        session,
        records: vec![renamed.clone()],
        prior: mirror.read_state().unwrap(),
    };
    mirror.write_rebuild_plan(&plan).unwrap();

    mirror
        .apply_rebuild(mirror.read_rebuild_plan().unwrap().unwrap())
        .unwrap();

    assert!(!mirror.root().join(&first.path).exists());
    assert!(!mirror.root().join(&removed.path).exists());
    assert_eq!(
        fs::read_to_string(mirror.root().join(&renamed.path)).unwrap(),
        record_markdown_document(&renamed).unwrap()
    );
}

#[tokio::test]
async fn reset_snapshot_can_atomically_swap_managed_record_paths() {
    let first = record("first.md", "First");
    let second = record("second.md", "Second");
    let (_temporary, mirror, authority) = harness(
        SyncReplicaMode::ReadOnly,
        vec![first.clone(), second.clone()],
    );
    mirror.sync().await.unwrap();
    let mut swapped_first = first.clone();
    swapped_first.path = second.path.clone();
    swapped_first.revision = "r-2".to_string();
    swapped_first.body = "# First after swap\n".to_string();
    let mut swapped_second = second.clone();
    swapped_second.path = first.path.clone();
    swapped_second.revision = "r-2".to_string();
    swapped_second.body = "# Second after swap\n".to_string();
    let mut session = authority.session.clone();
    session.scope_epoch = 2;
    session.head = 2;
    session.snapshot_id = Uuid::new_v4();
    let plan = DurableRebuildPlan {
        protocol_version: SYNC_PROTOCOL_VERSION,
        replica_id: authority.session.replica_id,
        mode: SyncReplicaMode::ReadOnly,
        session,
        records: vec![swapped_first.clone(), swapped_second.clone()],
        prior: mirror.read_state().unwrap(),
    };
    mirror.write_rebuild_plan(&plan).unwrap();

    mirror
        .apply_rebuild(mirror.read_rebuild_plan().unwrap().unwrap())
        .unwrap();

    assert_eq!(
        fs::read_to_string(mirror.root().join(&swapped_first.path)).unwrap(),
        record_markdown_document(&swapped_first).unwrap()
    );
    assert_eq!(
        fs::read_to_string(mirror.root().join(&swapped_second.path)).unwrap(),
        record_markdown_document(&swapped_second).unwrap()
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
    assert!(!mirror.rebuild_plan_file().exists());
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
