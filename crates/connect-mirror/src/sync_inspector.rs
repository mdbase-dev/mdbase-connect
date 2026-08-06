use super::*;
use crate::sync_planner::{
    identify_objects, plan_reconciliation, FrozenConflict, InspectionBoundary, InspectionSummary,
    ObjectUniverse, ObservedObject,
};

pub(super) struct Inspection {
    pub prior: Option<DurableMirrorState>,
    pub plan: MirrorSyncPlan,
    pub payloads: DurablePayloads,
}

struct FinishInspection<'a> {
    prior: Option<DurableMirrorState>,
    kind: &'a str,
    cursor: u64,
    scope_epoch: u64,
    remote_records: BTreeMap<String, SyncRecord>,
    remote_files: BTreeMap<String, CollectionFileDescriptor>,
    remote_refs: Vec<SyncObjectRef>,
    resources: Vec<SyncResourceDocument>,
    collection: Option<&'a mdbase::Collection>,
}

impl DirectoryMirror {
    pub(super) async fn inspect_plan(&self) -> Result<Inspection, MirrorError> {
        let prior = self.read_state()?;
        if prior.as_ref().is_some_and(|state| state.batch.is_some()) {
            return Err(MirrorError::new(
                "mirror_recovery_required",
                "Recover the prepared sync batch before inspecting.",
            ));
        }
        if prior
            .as_ref()
            .is_none_or(|state| state.sync_policy != self.sync_policy)
        {
            let kind = if prior.is_some() {
                "rebuild"
            } else {
                "initial"
            };
            self.inspect_snapshot(prior, kind).await
        } else {
            self.inspect_incremental(prior.expect("checked")).await
        }
    }

    async fn inspect_snapshot(
        &self,
        prior: Option<DurableMirrorState>,
        kind: &str,
    ) -> Result<Inspection, MirrorError> {
        let session = self.transport.open_session().await?;
        self.validate_session(&session)?;
        let (_staging, collection) = self.stage_snapshot_collection(&session.resources)?;
        let mut physical_paths = session
            .resources
            .documents
            .iter()
            .map(|resource| {
                portable_mirror_path_key(&resource.path)
                    .map(|key| (key, resource.path.clone()))
                    .map_err(|error| MirrorError::new("invalid_snapshot", error))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        if physical_paths.len() != session.resources.documents.len() {
            return Err(MirrorError::new(
                "invalid_snapshot",
                "Authority resources contain duplicate portable paths.",
            ));
        }
        let mut remote_records = BTreeMap::new();
        let mut page = None::<String>;
        loop {
            let result = self
                .transport
                .snapshot(session.snapshot_id, page.as_deref())
                .await?;
            if result.protocol_version != SYNC_PROTOCOL_VERSION
                || result.snapshot_id != session.snapshot_id
                || result.scope_epoch != session.scope_epoch
                || result.cursor != session.head
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Authority snapshot boundary changed during inspection.",
                ));
            }
            for value in result.records {
                self.validate_record_with(&collection, &value.record)?;
                let identity = value.record.record_id.to_string();
                let physical = portable_mirror_path_key(&value.record.path)
                    .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
                if let Some(existing) = physical_paths.insert(physical, value.record.path.clone()) {
                    return Err(MirrorError::new(
                        "invalid_snapshot",
                        format!(
                            "Authority paths {existing} and {} alias on a supported filesystem.",
                            value.record.path
                        ),
                    ));
                }
                if self.path_selected(&value.record.path)
                    && remote_records
                        .insert(identity, value.record.clone())
                        .is_some()
                {
                    return Err(MirrorError::new(
                        "invalid_snapshot",
                        "Authority snapshot repeats a record identity.",
                    ));
                }
            }
            page = result.next_page;
            if page.is_none() {
                break;
            }
        }
        let mut remote_files = BTreeMap::new();
        let mut file_page = None::<String>;
        loop {
            let result = self
                .transport
                .file_snapshot(session.snapshot_id, file_page.as_deref())
                .await?;
            if result.protocol_version != SYNC_PROTOCOL_VERSION
                || result.snapshot_id != session.snapshot_id
                || result.scope_epoch != session.scope_epoch
                || result.cursor != session.head
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Authority file snapshot boundary changed during inspection.",
                ));
            }
            for file in result.files {
                self.validate_file_descriptor(&file)?;
                let identity = file.file_id.to_string();
                let physical = portable_mirror_path_key(&file.path)
                    .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
                if let Some(existing) = physical_paths.insert(physical, file.path.clone()) {
                    return Err(MirrorError::new(
                        "invalid_snapshot",
                        format!(
                            "Authority paths {existing} and {} alias on a supported filesystem.",
                            file.path
                        ),
                    ));
                }
                if self.file_selected(&file) && remote_files.insert(identity, file).is_some() {
                    return Err(MirrorError::new(
                        "invalid_snapshot",
                        "Authority snapshot repeats a file identity.",
                    ));
                }
            }
            file_page = result.next_page;
            if file_page.is_none() {
                break;
            }
        }
        let resources = session.resources.documents;
        let remote_refs = resources
            .iter()
            .map(resource_ref)
            .chain(remote_records.values().map(record_ref))
            .chain(remote_files.values().map(file_ref))
            .collect();
        self.finish_inspection(FinishInspection {
            prior,
            kind,
            cursor: session.head,
            scope_epoch: session.scope_epoch,
            remote_records,
            remote_files,
            remote_refs,
            resources,
            collection: Some(&collection),
        })
        .await
    }

    async fn inspect_incremental(
        &self,
        prior: DurableMirrorState,
    ) -> Result<Inspection, MirrorError> {
        let mut remote_records = prior
            .records
            .iter()
            .filter_map(|(identity, entry)| {
                entry
                    .record
                    .clone()
                    .map(|record| (identity.to_string(), record))
            })
            .collect::<BTreeMap<_, _>>();
        let mut remote_files = prior
            .files
            .iter()
            .map(|(identity, entry)| (identity.to_string(), entry.file.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut remote_refs = base_refs(&prior)
            .into_iter()
            .map(|value| (key(&value), value))
            .collect::<BTreeMap<_, _>>();
        let mut cursor = prior.cursor;
        let mut previous = cursor;
        loop {
            let requested = cursor;
            let page = self.transport.changes(requested, 200).await?;
            if page.scope_epoch != prior.scope_epoch
                || page.cursor < requested
                || page.cursor > page.head
                || (page.has_more && page.cursor == requested)
            {
                return Err(MirrorError::new(
                    "invalid_change_page",
                    "Authority returned an invalid change boundary.",
                ));
            }
            if page.reset_required {
                return Box::pin(self.inspect_snapshot(Some(prior), "rebuild")).await;
            }
            for event in page.events {
                let sequence = match &event {
                    SyncChange::Put { sequence, .. }
                    | SyncChange::Remove { sequence, .. }
                    | SyncChange::FilePut { sequence, .. }
                    | SyncChange::FileRemove { sequence, .. } => *sequence,
                };
                if sequence <= previous || sequence > page.cursor {
                    return Err(MirrorError::new(
                        "invalid_change_page",
                        "Authority changes are not strictly ordered.",
                    ));
                }
                previous = sequence;
                match event {
                    SyncChange::Put { record, .. } => {
                        self.validate_record(&record)?;
                        let identity = record.record_id.to_string();
                        if self.path_selected(&record.path) {
                            remote_refs.insert(key(&record_ref(&record)), record_ref(&record));
                            remote_records.insert(identity, record);
                        } else {
                            remote_refs.remove(&format!("record:{identity}"));
                            remote_records.remove(&identity);
                        }
                    }
                    SyncChange::Remove { record_id, .. } => {
                        let identity = record_id.to_string();
                        remote_refs.remove(&format!("record:{identity}"));
                        remote_records.remove(&identity);
                    }
                    SyncChange::FilePut { file, .. } => {
                        self.validate_file_descriptor(&file)?;
                        let identity = file.file_id.to_string();
                        if self.file_selected(&file) {
                            remote_refs.insert(key(&file_ref(&file)), file_ref(&file));
                            remote_files.insert(identity, file);
                        } else {
                            remote_refs.remove(&format!("file:{identity}"));
                            remote_files.remove(&identity);
                        }
                    }
                    SyncChange::FileRemove { file_id, .. } => {
                        let identity = file_id.to_string();
                        remote_refs.remove(&format!("file:{identity}"));
                        remote_files.remove(&identity);
                    }
                }
            }
            cursor = page.cursor;
            if !page.has_more {
                break;
            }
        }
        let scope_epoch = prior.scope_epoch;
        self.finish_inspection(FinishInspection {
            prior: Some(prior),
            kind: "incremental",
            cursor,
            scope_epoch,
            remote_records,
            remote_files,
            remote_refs: remote_refs.into_values().collect(),
            resources: Vec::new(),
            collection: None,
        })
        .await
    }

    async fn finish_inspection(
        &self,
        input: FinishInspection<'_>,
    ) -> Result<Inspection, MirrorError> {
        let FinishInspection {
            prior,
            kind,
            cursor,
            scope_epoch,
            remote_records,
            remote_files,
            remote_refs,
            resources,
            collection,
        } = input;
        let (local, documents) = self.inspect_local(prior.as_ref(), &resources, collection)?;
        validate_inspected_paths(
            remote_refs
                .iter()
                .chain(local.iter().map(|observed| &observed.object)),
        )?;
        let mut objects = identify_objects(
            ObjectUniverse {
                base: prior.as_ref().map(base_refs).unwrap_or_default(),
                local,
                remote: remote_refs,
            },
            &format!(
                "{}\0{}\0{}",
                self.replica_id,
                scope_epoch,
                prior.as_ref().map(|value| value.generation).unwrap_or(0)
            ),
        );
        for object in &mut objects {
            if let Some(conflict) = prior
                .as_ref()
                .and_then(|state| state.planned_conflicts.get(&object.identity))
            {
                object.frozen_conflict = Some(FrozenConflict {
                    local: conflict.local.clone(),
                    remote: conflict.remote.clone(),
                    conflict_kind: conflict.conflict_kind,
                });
            }
        }
        let mut issues = Vec::new();
        for object in &objects {
            if matches!(kind, "initial" | "rebuild")
                && object.base == ExpectedObjectState::Absent
                && object.local.exact().is_some()
                && object.remote.exact().is_some()
                && object.local != object.remote
            {
                issues.push(MirrorPlanIssue {
                    code: "local_collision".into(),
                    message: format!(
                        "{} differs locally from the exact authority object.",
                        object.remote.exact().unwrap().path
                    ),
                    path: Some(object.remote.exact().unwrap().path.clone()),
                    blocking: true,
                });
            }
            if self.mode == SyncReplicaMode::ReadOnly
                && object.entity != SyncObjectKind::Resource
                && object.local != object.base
            {
                let path = object
                    .local
                    .exact()
                    .or(object.base.exact())
                    .map(|value| value.path.clone());
                issues.push(MirrorPlanIssue {
                    code: "mirror_diverged".into(),
                    message: format!(
                        "{} changed in a receive-only mirror.",
                        path.clone().unwrap_or_else(|| "mirror".into())
                    ),
                    path,
                    blocking: true,
                });
            }
        }
        let summary = InspectionSummary {
            boundary: InspectionBoundary {
                replica_id: self.replica_id.to_string(),
                scope_epoch,
                authority_cursor: cursor,
                checkpoint: SyncCheckpoint {
                    generation: prior.as_ref().map(|value| value.generation).unwrap_or(0),
                    cursor: prior.as_ref().map(|value| value.cursor),
                },
            },
            mode: self.mode,
            kind: kind.into(),
            selective_sync: self.sync_policy.clone(),
            objects,
            issues,
        };
        let plan = plan_reconciliation(summary)?;
        let mut payloads = DurablePayloads {
            documents: BTreeMap::new(),
            records: BTreeMap::new(),
            resources: BTreeMap::new(),
            files: BTreeMap::new(),
            local_files: BTreeMap::new(),
            mutations: BTreeMap::new(),
        };
        let resource_map = resources
            .into_iter()
            .map(|value| (value.path.clone(), value))
            .collect::<BTreeMap<_, _>>();
        for action in &plan.actions {
            match action {
                SyncAction::WriteLocal {
                    action_id, target, ..
                } => match target.entity {
                    SyncObjectKind::Record => {
                        let value = remote_records
                            .get(&target.identity)
                            .ok_or_else(|| missing_payload(action_id))?;
                        payloads.records.insert(action_id.clone(), value.clone());
                    }
                    SyncObjectKind::Resource => {
                        let value = resource_map
                            .get(&target.path)
                            .ok_or_else(|| missing_payload(action_id))?;
                        payloads.resources.insert(action_id.clone(), value.clone());
                    }
                    SyncObjectKind::File => {
                        let value = remote_files
                            .get(&target.identity)
                            .ok_or_else(|| missing_payload(action_id))?;
                        self.ensure_file_blob(value).await?;
                        payloads.files.insert(action_id.clone(), value.clone());
                    }
                },
                SyncAction::RecordConflict {
                    action_id,
                    identity,
                    entity,
                    remote: ExpectedObjectState::Exact { .. },
                    ..
                } => match entity {
                    SyncObjectKind::Record => {
                        if let Some(value) = remote_records.get(identity) {
                            payloads.records.insert(action_id.clone(), value.clone());
                        }
                    }
                    SyncObjectKind::File => {
                        if let Some(value) = remote_files.get(identity) {
                            payloads.files.insert(action_id.clone(), value.clone());
                        }
                    }
                    SyncObjectKind::Resource => {}
                },
                SyncAction::PutRemote {
                    action_id,
                    target,
                    expected_remote,
                    ..
                } if target.entity == SyncObjectKind::Record => {
                    let path = action_expected_local(action)
                        .and_then(ExpectedObjectState::exact)
                        .map(|value| value.path.as_str())
                        .unwrap_or(&target.path);
                    let document = documents
                        .get(path)
                        .ok_or_else(|| missing_payload(action_id))?
                        .clone();
                    payloads
                        .documents
                        .insert(action_id.clone(), document.clone());
                    payloads.mutations.insert(
                        action_id.clone(),
                        SyncMutation {
                            mutation_id: uuid_from_action(action_id)?,
                            replica_id: self.replica_id,
                            scope_epoch: plan.scope_epoch,
                            operation: SyncMutationOperation::Put,
                            record_id: Uuid::parse_str(&target.identity)
                                .map_err(|_| missing_payload(action_id))?,
                            base_revision: expected_remote
                                .exact()
                                .map(|value| value.revision.clone()),
                            path: Some(target.path.clone()),
                            document: Some(document),
                            created_at: now(),
                            causal_predecessor: None,
                        },
                    );
                }
                SyncAction::PutRemote {
                    action_id,
                    target,
                    expected_local,
                    ..
                } if target.entity == SyncObjectKind::File => {
                    let path = expected_local
                        .exact()
                        .map(|value| value.path.as_str())
                        .unwrap_or(&target.path);
                    let content_digest = self
                        .file_digest(path)?
                        .ok_or_else(|| missing_payload(action_id))?;
                    let size = fs::metadata(safe_path(&self.root, path)?)
                        .map_err(|error| MirrorError::io("Could not inspect", &self.root, error))?
                        .len();
                    self.stage_local_blob(path, &content_digest, size)?;
                    payloads.local_files.insert(
                        action_id.clone(),
                        DurableLocalFile {
                            path: path.into(),
                            content_digest,
                            size,
                            media_type: None,
                        },
                    );
                }
                SyncAction::MoveRemote {
                    action_id,
                    source,
                    target_path,
                    expected_source_owner,
                    ..
                } if source.entity == SyncObjectKind::Record => {
                    payloads.mutations.insert(
                        action_id.clone(),
                        SyncMutation {
                            mutation_id: uuid_from_action(action_id)?,
                            replica_id: self.replica_id,
                            scope_epoch: plan.scope_epoch,
                            operation: SyncMutationOperation::Move,
                            record_id: Uuid::parse_str(&source.identity)
                                .map_err(|_| missing_payload(action_id))?,
                            base_revision: expected_source_owner
                                .exact()
                                .map(|value| value.revision.clone()),
                            path: Some(target_path.clone()),
                            document: None,
                            created_at: now(),
                            causal_predecessor: None,
                        },
                    );
                }
                SyncAction::DeleteRemote {
                    action_id,
                    target,
                    expected_remote,
                    ..
                } if target.entity == SyncObjectKind::Record => {
                    payloads.mutations.insert(
                        action_id.clone(),
                        SyncMutation {
                            mutation_id: uuid_from_action(action_id)?,
                            replica_id: self.replica_id,
                            scope_epoch: plan.scope_epoch,
                            operation: SyncMutationOperation::Delete,
                            record_id: Uuid::parse_str(&target.identity)
                                .map_err(|_| missing_payload(action_id))?,
                            base_revision: expected_remote
                                .exact()
                                .map(|value| value.revision.clone()),
                            path: None,
                            document: None,
                            created_at: now(),
                            causal_predecessor: None,
                        },
                    );
                }
                _ => {}
            }
        }
        Ok(Inspection {
            prior,
            plan,
            payloads,
        })
    }

    fn inspect_local(
        &self,
        state: Option<&DurableMirrorState>,
        resources: &[SyncResourceDocument],
        collection: Option<&mdbase::Collection>,
    ) -> Result<(Vec<ObservedObject>, BTreeMap<String, String>), MirrorError> {
        let resource_paths = resources
            .iter()
            .map(|value| value.path.clone())
            .chain(
                state
                    .into_iter()
                    .flat_map(|value| value.resources.keys().cloned()),
            )
            .collect::<HashSet<_>>();
        let mut observed = Vec::new();
        let mut documents = BTreeMap::new();
        let markdown = match collection {
            Some(collection) => self.list_markdown_with(&resource_paths, collection)?,
            None => self.list_markdown(&resource_paths)?,
        };
        for path in markdown {
            if !self.path_selected(&path)
                && !state
                    .is_some_and(|value| value.records.values().any(|entry| entry.path == path))
            {
                continue;
            }
            let Some(document) = self.read_file(&path)? else {
                continue;
            };
            let revision = format!("sha256:{}", digest(&document));
            let conflict_identity = state.and_then(|value| {
                value
                    .planned_conflicts
                    .iter()
                    .find(|(_, conflict)| {
                        conflict.entity == SyncObjectKind::Record
                            && conflict
                                .local
                                .exact()
                                .is_some_and(|object| object.path == path)
                    })
                    .map(|(identity, _)| identity.clone())
            });
            let bound_identity = state.and_then(|value| {
                value
                    .local_bindings
                    .iter()
                    .find(|(_, binding)| {
                        binding.entity == SyncObjectKind::Record && binding.path == path
                    })
                    .map(|(identity, _)| identity.clone())
            });
            let prior_identity = state.and_then(|value| {
                value
                    .records
                    .iter()
                    .find(|(_, entry)| entry.path == path)
                    .map(|(identity, _)| identity.to_string())
            });
            let identity = conflict_identity
                .or(bound_identity)
                .or(prior_identity)
                .unwrap_or_default();
            observed.push(ObservedObject {
                stable_identity: !identity.is_empty(),
                object: text_ref(SyncObjectKind::Record, identity, path.clone(), revision),
            });
            documents.insert(path, document);
        }
        for resource in resources {
            if let Some(document) = self.read_file(&resource.path)? {
                let revision = format!("sha256:{}", digest(&document));
                observed.push(ObservedObject {
                    stable_identity: true,
                    object: text_ref(
                        SyncObjectKind::Resource,
                        resource.path.clone(),
                        resource.path.clone(),
                        revision,
                    ),
                });
            }
        }
        if !self.sync_policy.file_classes.is_empty()
            || state.is_some_and(|value| !value.files.is_empty())
        {
            for path in self.list_binary_files()? {
                if resource_paths.contains(&path) {
                    continue;
                }
                let managed = state
                    .is_some_and(|value| value.files.values().any(|entry| entry.file.path == path));
                if !managed
                    && (!self.path_selected(&path)
                        || !self
                            .sync_policy
                            .file_classes
                            .contains(&classify_file_media(&path)))
                {
                    continue;
                }
                let digest = self.file_digest(&path)?.expect("listed file");
                let size = fs::metadata(safe_path(&self.root, &path)?)
                    .map_err(|error| MirrorError::io("Could not inspect", &self.root, error))?
                    .len();
                let prior = state.and_then(|value| {
                    value
                        .files
                        .iter()
                        .find(|(_, entry)| entry.file.path == path)
                });
                if prior.is_none() && self.sync_policy.file_classes.is_empty() {
                    continue;
                }
                let identity = prior
                    .map(|(identity, _)| identity.to_string())
                    .unwrap_or_default();
                let revision = prior
                    .filter(|(_, entry)| entry.file.content_digest == digest)
                    .map(|(_, entry)| entry.file.revision.clone())
                    .unwrap_or_else(|| digest.clone());
                observed.push(ObservedObject {
                    stable_identity: !identity.is_empty(),
                    object: SyncObjectRef {
                        entity: SyncObjectKind::File,
                        identity,
                        path,
                        revision,
                        payload_revision: digest,
                        size: Some(size),
                    },
                });
            }
        }
        Ok((observed, documents))
    }

    fn validate_session(&self, session: &SyncSession) -> Result<(), MirrorError> {
        if session.protocol_version != SYNC_PROTOCOL_VERSION
            || session.protocol_profile != sync_model::PROTOCOL_PROFILE
            || session.replica_id != self.replica_id
            || session.mode != self.mode
        {
            return Err(MirrorError::new(
                "sync_protocol_incompatible",
                "Mirror requires exact-document v1 for its own replica.",
            ));
        }
        Ok(())
    }

    fn validate_record(&self, record: &SyncRecord) -> Result<(), MirrorError> {
        self.validate_record_path(&record.path)?;
        self.validate_record_document(record)
    }

    fn validate_record_with(
        &self,
        collection: &mdbase::Collection,
        record: &SyncRecord,
    ) -> Result<(), MirrorError> {
        self.validate_record_path_with(collection, &record.path)?;
        self.validate_record_document(record)
    }

    fn validate_record_document(&self, record: &SyncRecord) -> Result<(), MirrorError> {
        let document = record_markdown_document(record)?;
        if format!("sha256:{}", digest(&document)) != record.revision {
            return Err(MirrorError::new(
                "invalid_sync_response",
                "Record revision does not match exact document bytes.",
            ));
        }
        Ok(())
    }

    fn stage_snapshot_collection(
        &self,
        resources: &SyncCollectionResources,
    ) -> Result<(tempfile::TempDir, mdbase::Collection), MirrorError> {
        let staging = tempfile::tempdir().map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Could not stage authority resources: {error}"),
            )
        })?;
        for resource in &resources.documents {
            validate_portable_mirror_path(&resource.path)
                .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
            if format!("sha256:{}", digest(&resource.document)) != resource.revision {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Resource {} revision does not match its bytes.",
                        resource.path
                    ),
                ));
            }
            atomic_write(
                &safe_path(staging.path(), &resource.path)?,
                resource.document.as_bytes(),
            )?;
        }
        let collection = mdbase::Collection::open(staging.path()).map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Authority resources do not form a valid collection: {error}"),
            )
        })?;
        let canonical = collection.snapshot().map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Authority resources could not be canonicalized: {error}"),
            )
        })?;
        if canonical.spec_version != resources.spec_version
            || canonical.resources.len() != resources.documents.len()
        {
            return Err(MirrorError::new(
                "invalid_snapshot",
                "Authority resources are not their declared canonical collection snapshot.",
            ));
        }
        let declared = resources
            .documents
            .iter()
            .map(|resource| (resource.path.as_str(), resource))
            .collect::<BTreeMap<_, _>>();
        for resource in canonical.resources {
            let expected = declared.get(resource.path.as_str()).ok_or_else(|| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Authority resource {} is not canonical.", resource.path),
                )
            })?;
            if expected.kind != resource_kind(resource.kind)
                || expected.revision != resource.revision
                || expected.document != resource.document
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!("Authority resource {} is not canonical.", resource.path),
                ));
            }
        }
        Ok((staging, collection))
    }
}

fn resource_kind(kind: mdbase::runtime::CollectionSnapshotResourceKind) -> &'static str {
    match kind {
        mdbase::runtime::CollectionSnapshotResourceKind::Configuration => "configuration",
        mdbase::runtime::CollectionSnapshotResourceKind::Lock => "lock",
        mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract",
        mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema",
        mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
        mdbase::runtime::CollectionSnapshotResourceKind::View => "view",
    }
}

fn validate_inspected_paths<'a>(
    objects: impl IntoIterator<Item = &'a SyncObjectRef>,
) -> Result<(), MirrorError> {
    let mut owners = BTreeMap::<String, (&str, &SyncObjectKind, &str)>::new();
    for object in objects {
        let physical = portable_mirror_path_key(&object.path)
            .map_err(|error| MirrorError::new("invalid_record_path", error))?;
        if let Some((path, entity, identity)) = owners.get(&physical) {
            if *path != object.path
                || *entity != &object.entity
                || (!identity.is_empty()
                    && !object.identity.is_empty()
                    && *identity != object.identity)
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "Mirror paths {path} and {} alias on a supported filesystem.",
                        object.path
                    ),
                ));
            }
        } else {
            owners.insert(physical, (&object.path, &object.entity, &object.identity));
        }
    }
    Ok(())
}

fn text_ref(
    entity: SyncObjectKind,
    identity: String,
    path: String,
    revision: String,
) -> SyncObjectRef {
    SyncObjectRef {
        entity,
        identity,
        path,
        payload_revision: revision.clone(),
        revision,
        size: None,
    }
}
fn record_ref(value: &SyncRecord) -> SyncObjectRef {
    text_ref(
        SyncObjectKind::Record,
        value.record_id.to_string(),
        value.path.clone(),
        value.revision.clone(),
    )
}
fn resource_ref(value: &SyncResourceDocument) -> SyncObjectRef {
    text_ref(
        SyncObjectKind::Resource,
        value.path.clone(),
        value.path.clone(),
        value.revision.clone(),
    )
}
fn file_ref(value: &CollectionFileDescriptor) -> SyncObjectRef {
    SyncObjectRef {
        entity: SyncObjectKind::File,
        identity: value.file_id.to_string(),
        path: value.path.clone(),
        revision: value.revision.clone(),
        payload_revision: value.content_digest.clone(),
        size: Some(value.size),
    }
}
fn key(value: &SyncObjectRef) -> String {
    format!(
        "{}:{}",
        match value.entity {
            SyncObjectKind::Record => "record",
            SyncObjectKind::Resource => "resource",
            SyncObjectKind::File => "file",
        },
        value.identity
    )
}
fn base_refs(state: &DurableMirrorState) -> Vec<SyncObjectRef> {
    state
        .records
        .iter()
        .map(|(identity, entry)| {
            text_ref(
                SyncObjectKind::Record,
                identity.to_string(),
                entry.path.clone(),
                entry.revision.clone(),
            )
        })
        .chain(state.resources.iter().map(|(identity, entry)| {
            text_ref(
                SyncObjectKind::Resource,
                identity.clone(),
                entry.path.clone(),
                entry.revision.clone(),
            )
        }))
        .chain(state.files.values().map(|entry| file_ref(&entry.file)))
        .collect()
}
fn missing_payload(action: &str) -> MirrorError {
    MirrorError::new(
        "sync_payload_incomplete",
        format!("Action {action} has no exact payload."),
    )
}
fn uuid_from_action(action: &str) -> Result<Uuid, MirrorError> {
    let hex = action
        .strip_prefix("sha256:")
        .ok_or_else(|| missing_payload(action))?;
    Uuid::parse_str(&format!(
        "{}-{}-4{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    ))
    .map_err(|_| missing_payload(action))
}
fn action_expected_local(action: &SyncAction) -> Option<&ExpectedObjectState> {
    match action {
        SyncAction::PutRemote { expected_local, .. }
        | SyncAction::MoveRemote { expected_local, .. }
        | SyncAction::DeleteRemote { expected_local, .. } => Some(expected_local),
        _ => None,
    }
}
