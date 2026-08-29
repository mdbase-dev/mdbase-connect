use super::*;
use mdbase::runtime::{
    CanonicalChange, ChangeOrigin, ChangePageCursor, ChangeSet, RecordChangeKind,
    ResourceChangeKind, RuntimeChangeEvent,
};
use std::num::NonZeroUsize;
use std::time::Duration;

const RUNTIME_CHANGE_RECEIPT_PREFIX: &str = "runtime_change_receipt:";

impl CollectionRegistry {
    /// Let the mdbase-owned watcher normalize one external filesystem observation.
    pub fn ingest_runtime_external(
        &self,
        collection_id: Uuid,
        timeout: Duration,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<bool, ConnectError> {
        let registered = self.get(collection_id)?;
        if !registered.enabled {
            return Ok(false);
        }
        let Some(executor) = self.resident_executor(collection_id)? else {
            return Ok(false);
        };
        let context = runtime_context(cancellation);
        let changed = executor.with_background(&context, |_| {
            executor.ingest_external_timeout(timeout, &context)
        })?;
        if changed {
            executor.touch();
        }
        Ok(changed)
    }

    /// Explicit lifecycle reconciliation. Normal mutations never call this path.
    pub fn synchronize_runtime(
        &self,
        collection_id: Uuid,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<(), ConnectError> {
        let registered = self.get(collection_id)?;
        let executor = self.executor_for(&registered)?;
        let context = runtime_context(cancellation);
        executor.with_background(&context, |_| executor.synchronize(&context))?;
        while executor.with_background(&context, |_| {
            executor.ingest_external_timeout(Duration::ZERO, &context)
        })? {}
        Ok(())
    }

    /// Persist and acknowledge all durable provider events in order.
    pub fn finalize_runtime_changes(
        &self,
        collection_id: Uuid,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<Vec<(mdbase::watch::WatchEvent, u64)>, ConnectError> {
        let registered = self.get(collection_id)?;
        if !registered.enabled {
            return Ok(Vec::new());
        }
        let executor = self.executor_for(&registered)?;
        self.finalize_runtime_changes_with_executor(collection_id, executor, cancellation)
    }

    /// Finalize only when the collection runtime is already resident. Passive
    /// polling must never reopen every registered collection.
    pub fn finalize_resident_runtime_changes(
        &self,
        collection_id: Uuid,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<Vec<(mdbase::watch::WatchEvent, u64)>, ConnectError> {
        let registered = self.get(collection_id)?;
        if !registered.enabled {
            return Ok(Vec::new());
        }
        let Some(executor) = self.resident_executor(collection_id)? else {
            return Ok(Vec::new());
        };
        self.finalize_runtime_changes_with_executor(collection_id, executor, cancellation)
    }

    fn finalize_runtime_changes_with_executor(
        &self,
        collection_id: Uuid,
        executor: Arc<CollectionExecutor>,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<Vec<(mdbase::watch::WatchEvent, u64)>, ConnectError> {
        if !executor.is_coordinated() {
            return Ok(Vec::new());
        }
        let runtime = executor.runtime()?;
        let context = runtime_context(cancellation);
        executor.with_background(&context, |_| {
            let mut persisted = Vec::new();
            loop {
                let page = executor.read_change_events(None, &context)?;
                let Some(event) = page.events.into_iter().next() else {
                    return Ok(persisted);
                };
                let events = runtime_watch_events(runtime.as_ref(), &event, &context)?;
                let receipt_key = runtime_change_receipt_key(collection_id, &event);
                let (events, cursors) =
                    self.append_runtime_change(collection_id, &receipt_key, &event, &events)?;
                executor.ack_change_events(event.identity.watermark, &context)?;
                self.delete_runtime_change_receipt(&receipt_key)?;
                persisted.extend(events.into_iter().zip(cursors));
            }
        })
    }

    fn append_runtime_change(
        &self,
        collection_id: Uuid,
        receipt_key: &str,
        runtime_event: &RuntimeChangeEvent,
        events: &[mdbase::watch::WatchEvent],
    ) -> Result<(Vec<mdbase::watch::WatchEvent>, Vec<u64>), ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored) = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [receipt_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            let receipt: RuntimeChangeReceipt =
                serde_json::from_str(&stored).map_err(|error| ConnectError::RegistryCorrupt {
                    path: PathBuf::from("connector.sqlite"),
                    detail: format!("runtime change receipt is invalid: {error}"),
                })?;
            transaction.commit()?;
            return Ok((receipt.events, receipt.cursors));
        }

        Self::mark_file_inventory_dirty_in(
            &transaction,
            collection_id,
            u64::try_from(events.len()).unwrap_or(u64::MAX),
        )?;
        let mut cursor: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get(0),
        )?;
        let mut cursors = Vec::with_capacity(events.len());
        for event in events {
            cursor = cursor.checked_add(1).ok_or_else(|| {
                ConnectError::CollectionOpen("collection change cursor exhausted".into())
            })?;
            transaction.execute(
                "INSERT INTO collection_changes
                   (collection_id, cursor, event_type, occurred_at, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    collection_id.to_string(),
                    cursor,
                    event.event_type,
                    event.occurred_at,
                    serde_json::to_string(&event.payload)?,
                ],
            )?;
            cursors.push(cursor as u64);
        }
        let receipt = RuntimeChangeReceipt {
            provider_watermark: runtime_event.identity.watermark.get(),
            generation_epoch: runtime_event.generation.runtime_epoch().to_string(),
            generation_sequence: runtime_event.generation.sequence(),
            events: events.to_vec(),
            cursors: cursors.clone(),
        };
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params![receipt_key, serde_json::to_string(&receipt)?],
        )?;
        transaction.execute(
            "DELETE FROM collection_changes WHERE collection_id = ?1 AND cursor <= ?2",
            params![collection_id.to_string(), cursor.saturating_sub(2_000)],
        )?;
        transaction.commit()?;
        Ok((events.to_vec(), cursors))
    }

    fn delete_runtime_change_receipt(&self, key: &str) -> Result<(), ConnectError> {
        self.connection()?
            .execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
struct RuntimeChangeReceipt {
    provider_watermark: u64,
    generation_epoch: String,
    generation_sequence: u64,
    events: Vec<mdbase::watch::WatchEvent>,
    cursors: Vec<u64>,
}

fn runtime_change_receipt_key(collection_id: Uuid, event: &RuntimeChangeEvent) -> String {
    format!(
        "{RUNTIME_CHANGE_RECEIPT_PREFIX}{collection_id}:{}",
        event.identity.id.as_str()
    )
}

fn runtime_watch_events(
    runtime: &FilesystemRuntime,
    event: &RuntimeChangeEvent,
    context: &mdbase::runtime::OperationContext,
) -> Result<Vec<mdbase::watch::WatchEvent>, ConnectError> {
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let metadata = runtime_metadata(event);
    match &event.changes {
        ChangeSet::None => Ok(Vec::new()),
        ChangeSet::CollectionWide { reason } => Ok(vec![mdbase::watch::WatchEvent {
            event_type: "mdbase.collection.invalidated".to_string(),
            sequence: event.identity.watermark.get(),
            occurred_at,
            payload: json!({
                "reason": reason,
                "runtime": metadata,
            }),
        }]),
        ChangeSet::Exact(batch) => {
            let mut cursor: Option<ChangePageCursor> = None;
            let mut changes = Vec::with_capacity(batch.descriptor().count);
            loop {
                let page = runtime.change_page(
                    batch,
                    cursor.as_ref(),
                    NonZeroUsize::new(256).expect("constant is non-zero"),
                    context,
                )?;
                changes.extend(page.items);
                let Some(next) = page.next else { break };
                cursor = Some(next);
            }
            Ok(changes
                .into_iter()
                .enumerate()
                .map(|(index, change)| {
                    watch_event(
                        change,
                        event.identity.watermark.get(),
                        index,
                        &occurred_at,
                        &metadata,
                    )
                })
                .collect())
        }
    }
}

fn runtime_metadata(event: &RuntimeChangeEvent) -> Value {
    json!({
        "event_id": event.identity.id.as_str(),
        "watermark": event.identity.watermark.get(),
        "generation": {
            "epoch": event.generation.runtime_epoch(),
            "sequence": event.generation.sequence(),
        },
        "origin": match event.origin {
            ChangeOrigin::KnownMutation => "known_mutation",
            ChangeOrigin::Filesystem => "filesystem",
            ChangeOrigin::RecoveryReconciliation => "recovery_reconciliation",
        },
        "commit_id": event.commit_id.as_ref().map(|commit| commit.as_str()),
    })
}

fn watch_event(
    change: CanonicalChange,
    sequence: u64,
    change_index: usize,
    occurred_at: &str,
    metadata: &Value,
) -> mdbase::watch::WatchEvent {
    let (event_type, mut payload) = match change {
        CanonicalChange::Record(change) => {
            let before_types = change.before_types.iter().collect::<Vec<_>>();
            let after_types = change.after_types.iter().collect::<Vec<_>>();
            let changed_fields = change.changed_fields.iter().collect::<Vec<_>>();
            let common = json!({
                "previous_revision": change.before_revision.as_ref().map(|value| value.as_str()),
                "revision": change.after_revision.as_ref().map(|value| value.as_str()),
                "previous_types": before_types,
                "types": after_types,
                "changed_fields": changed_fields,
                "body_changed": change.body_changed,
            });
            match change.kind {
                RecordChangeKind::Created => (
                    "mdbase.record.created",
                    merge_payload(common, json!({"path": change.path.as_str()})),
                ),
                RecordChangeKind::Updated => (
                    "mdbase.record.modified",
                    merge_payload(common, json!({"path": change.path.as_str()})),
                ),
                RecordChangeKind::Deleted => (
                    "mdbase.record.deleted",
                    merge_payload(common, json!({"path": change.path.as_str()})),
                ),
                RecordChangeKind::Renamed => (
                    "mdbase.record.renamed",
                    merge_payload(
                        common,
                        json!({
                            "from": change.from.as_ref().map(|path| path.as_str()),
                            "to": change.path.as_str(),
                        }),
                    ),
                ),
            }
        }
        CanonicalChange::Resource(change) => {
            let event_type = match change.kind {
                ResourceChangeKind::Configuration => "mdbase.config.changed",
                ResourceChangeKind::TypeDefinition => "mdbase.type.changed",
                ResourceChangeKind::Contract => "mdbase.contract.changed",
                ResourceChangeKind::ViewSource => "mdbase.view.changed",
                ResourceChangeKind::File => "mdbase.resource.changed",
                ResourceChangeKind::Other => "mdbase.collection.invalidated",
            };
            (
                event_type,
                json!({
                    "path": change.path.as_str(),
                    "previous_revision": change.before_revision.as_ref().map(|value| value.as_str()),
                    "revision": change.after_revision.as_ref().map(|value| value.as_str()),
                }),
            )
        }
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("runtime".to_string(), metadata.clone());
        object.insert("change_index".to_string(), json!(change_index));
    }
    mdbase::watch::WatchEvent {
        event_type: event_type.to_string(),
        sequence,
        occurred_at: occurred_at.to_string(),
        payload,
    }
}

fn merge_payload(mut left: Value, right: Value) -> Value {
    if let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object()) {
        left.extend(right.clone());
    }
    left
}

fn runtime_context(
    cancellation: &mdbase::OperationCancellation,
) -> mdbase::runtime::OperationContext {
    mdbase::runtime::OperationContext::new(
        cancellation,
        mdbase::runtime::OperationDeadline::after(Duration::from_secs(24 * 60 * 60)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::time::Instant;

    fn collect_external_events(
        registry: &CollectionRegistry,
        collection_id: Uuid,
        expected: usize,
    ) -> Vec<(mdbase::watch::WatchEvent, u64)> {
        let cancellation = mdbase::OperationCancellation::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        while events.len() < expected && Instant::now() < deadline {
            registry
                .ingest_runtime_external(collection_id, Duration::from_millis(100), &cancellation)
                .unwrap();
            events.extend(
                registry
                    .finalize_runtime_changes(collection_id, &cancellation)
                    .unwrap(),
            );
        }
        assert_eq!(
            events.len(),
            expected,
            "timed out waiting for watcher events"
        );
        events
    }

    fn assert_runtime_feed_quiet(registry: &CollectionRegistry, collection_id: Uuid) {
        let cancellation = mdbase::OperationCancellation::new();
        assert!(!registry
            .ingest_runtime_external(collection_id, Duration::from_millis(200), &cancellation,)
            .unwrap());
        assert!(registry
            .finalize_runtime_changes(collection_id, &cancellation)
            .unwrap()
            .is_empty());
    }

    fn event_paths(
        events: &[(mdbase::watch::WatchEvent, u64)],
    ) -> BTreeSet<(String, String, Option<String>)> {
        events
            .iter()
            .map(|(event, _)| {
                (
                    event.event_type.clone(),
                    event
                        .payload
                        .get("path")
                        .or_else(|| event.payload.get("to"))
                        .and_then(Value::as_str)
                        .expect("record event has path or rename target")
                        .to_string(),
                    event.payload["from"].as_str().map(str::to_string),
                )
            })
            .collect()
    }

    #[test]
    fn provider_event_receipt_closes_append_before_ack_crash_window() {
        let state = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry
            .create(parent.path().join("notes"), Some("Notes"), "UTC")
            .unwrap();
        registry
            .operation(
                collection.id,
                "create",
                &json!({"path": "one.md", "frontmatter": {"title": "One"}}),
            )
            .unwrap();

        let registered = registry.get(collection.id).unwrap();
        let executor = registry.executor_for(&registered).unwrap();
        let context = runtime_context(&mdbase::OperationCancellation::new());
        let event = executor
            .read_change_events(None, &context)
            .unwrap()
            .events
            .into_iter()
            .next()
            .unwrap();
        let events =
            runtime_watch_events(executor.runtime().unwrap().as_ref(), &event, &context).unwrap();
        let key = runtime_change_receipt_key(collection.id, &event);

        let first = registry
            .append_runtime_change(collection.id, &key, &event, &events)
            .unwrap();
        let replay = registry
            .append_runtime_change(collection.id, &key, &event, &events)
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(first.1, vec![1]);

        let finalized = registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap();
        assert_eq!(
            finalized,
            first.0.into_iter().zip(first.1).collect::<Vec<_>>()
        );
        let count: u64 = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_changes WHERE collection_id = ?1",
                [collection.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn collection_wide_outcome_translates_and_replays_durably_once() {
        let state = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry
            .create(parent.path().join("notes"), Some("Notes"), "UTC")
            .unwrap();
        registry
            .operation(
                collection.id,
                "create",
                &json!({"path": "fixture.md", "frontmatter": {"title": "Fixture"}}),
            )
            .unwrap();

        let registered = registry.get(collection.id).unwrap();
        let executor = registry.executor_for(&registered).unwrap();
        let context = runtime_context(&mdbase::OperationCancellation::new());
        let mut event = executor
            .read_change_events(None, &context)
            .unwrap()
            .events
            .into_iter()
            .next()
            .unwrap();
        event.changes = ChangeSet::CollectionWide {
            reason: mdbase::runtime::RebuildReason::ExternalChangeUncertain,
        };
        event.origin = ChangeOrigin::Filesystem;
        event.commit_id = None;
        let translated =
            runtime_watch_events(executor.runtime().unwrap().as_ref(), &event, &context).unwrap();
        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0].event_type, "mdbase.collection.invalidated");
        assert_eq!(translated[0].payload["reason"], "external_change_uncertain");
        assert!(translated[0].payload.get("path").is_none());
        assert_eq!(translated[0].payload["runtime"]["origin"], "filesystem");
        assert!(translated[0].payload["runtime"]["event_id"].is_string());
        assert!(translated[0].payload["runtime"]["generation"]["epoch"].is_string());
        assert!(!serde_json::to_string(&translated)
            .unwrap()
            .contains("fixture.md"));
        assert!(!serde_json::to_string(&translated)
            .unwrap()
            .contains("Fixture"));

        let key = runtime_change_receipt_key(collection.id, &event);
        let first = registry
            .append_runtime_change(collection.id, &key, &event, &translated)
            .unwrap();
        assert_eq!(
            registry
                .append_runtime_change(collection.id, &key, &event, &translated)
                .unwrap(),
            first
        );
        assert_eq!(first.1, vec![1]);

        let finalized = registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap();
        assert_eq!(
            finalized,
            first.0.into_iter().zip(first.1).collect::<Vec<_>>()
        );
        assert!(registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap()
            .is_empty());
        let public = registry
            .changes(collection.id, &json!({"after": 0}))
            .unwrap();
        assert_eq!(public.events.len(), 1);
        assert_eq!(public.events[0].event_type, "mdbase.collection.invalidated");
        assert_eq!(public.cursor, 1);
    }

    #[test]
    fn recursive_directory_changes_translate_once_and_only_current_paths_resolve() {
        let state = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes"), "UTC").unwrap();

        std::fs::create_dir_all(root.join("before/nested")).unwrap();
        std::fs::write(
            root.join("before/nested/immediate.md"),
            "---\ntitle: Immediate\n---\n",
        )
        .unwrap();
        std::fs::write(root.join("before/second.md"), "---\ntitle: Second\n---\n").unwrap();
        let created = collect_external_events(&registry, collection.id, 2);
        assert_eq!(
            event_paths(&created),
            BTreeSet::from([
                (
                    "mdbase.record.created".to_string(),
                    "before/nested/immediate.md".to_string(),
                    None
                ),
                (
                    "mdbase.record.created".to_string(),
                    "before/second.md".to_string(),
                    None
                ),
            ])
        );

        std::fs::rename(root.join("before"), root.join("after")).unwrap();
        let renamed = collect_external_events(&registry, collection.id, 2);
        assert_eq!(
            event_paths(&renamed),
            BTreeSet::from([
                (
                    "mdbase.record.renamed".to_string(),
                    "after/nested/immediate.md".to_string(),
                    Some("before/nested/immediate.md".to_string())
                ),
                (
                    "mdbase.record.renamed".to_string(),
                    "after/second.md".to_string(),
                    Some("before/second.md".to_string())
                ),
            ])
        );
        let query = registry
            .operation(collection.id, "query", &json!({}))
            .unwrap();
        let paths = query["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["path"].as_str().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            paths,
            BTreeSet::from(["after/nested/immediate.md", "after/second.md"])
        );
        assert_eq!(
            registry
                .operation(collection.id, "read", &json!({"path": "before/second.md"}))
                .unwrap()["valid"],
            false
        );
        assert_eq!(
            registry
                .operation(collection.id, "read", &json!({"path": "after/second.md"}))
                .unwrap()["valid"],
            true
        );

        std::fs::remove_dir_all(root.join("after")).unwrap();
        let deleted = collect_external_events(&registry, collection.id, 2);
        assert_eq!(
            event_paths(&deleted),
            BTreeSet::from([
                (
                    "mdbase.record.deleted".to_string(),
                    "after/nested/immediate.md".to_string(),
                    None
                ),
                (
                    "mdbase.record.deleted".to_string(),
                    "after/second.md".to_string(),
                    None
                ),
            ])
        );
        assert_runtime_feed_quiet(&registry, collection.id);

        let all = registry
            .changes(collection.id, &json!({"after": 0}))
            .unwrap();
        assert_eq!(all.events.len(), 6);
        assert!(all
            .events
            .iter()
            .all(|event| event.event_type != "mdbase.collection.invalidated"));
        assert_eq!(
            all.events
                .iter()
                .map(|event| event.cursor)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert!(registry
            .operation(collection.id, "query", &json!({}))
            .unwrap()["result"]["results"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn duplicate_bytes_remain_delete_create_and_public_cursor_replays_once() {
        let state = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes"), "UTC").unwrap();
        std::fs::create_dir_all(root.join("before/nested")).unwrap();
        let duplicate = "---\ntitle: Duplicate\n---\nSame\n";
        std::fs::write(root.join("before/one.md"), duplicate).unwrap();
        std::fs::write(root.join("before/nested/two.md"), duplicate).unwrap();
        collect_external_events(&registry, collection.id, 2);
        let baseline = registry.changes(collection.id, &json!({})).unwrap();
        assert!(baseline.events.is_empty());
        assert_eq!(baseline.cursor, 2);

        std::fs::rename(root.join("before"), root.join("after")).unwrap();
        let changes = collect_external_events(&registry, collection.id, 4);
        assert!(changes
            .iter()
            .all(|(event, _)| event.event_type != "mdbase.record.renamed"));
        assert_eq!(
            event_paths(&changes),
            BTreeSet::from([
                (
                    "mdbase.record.deleted".to_string(),
                    "before/nested/two.md".to_string(),
                    None
                ),
                (
                    "mdbase.record.deleted".to_string(),
                    "before/one.md".to_string(),
                    None
                ),
                (
                    "mdbase.record.created".to_string(),
                    "after/nested/two.md".to_string(),
                    None
                ),
                (
                    "mdbase.record.created".to_string(),
                    "after/one.md".to_string(),
                    None
                ),
            ])
        );
        assert_runtime_feed_quiet(&registry, collection.id);

        let replay = registry
            .changes(collection.id, &json!({"after": baseline.cursor}))
            .unwrap();
        assert_eq!(replay.events.len(), 4);
        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.cursor)
                .collect::<Vec<_>>(),
            vec![3, 4, 5, 6]
        );
        let empty = registry
            .changes(collection.id, &json!({"after": replay.cursor}))
            .unwrap();
        assert!(empty.events.is_empty());
        assert_eq!(empty.cursor, replay.cursor);

        drop(registry);
        let reopened = CollectionRegistry::open(state.path()).unwrap();
        let durable = reopened
            .changes(collection.id, &json!({"after": baseline.cursor}))
            .unwrap();
        assert_eq!(durable.cursor, replay.cursor);
        assert_eq!(durable.has_more, replay.has_more);
        assert_eq!(durable.reset, replay.reset);
        assert_eq!(
            serde_json::to_value(durable.events).unwrap(),
            serde_json::to_value(replay.events).unwrap()
        );
    }

    #[test]
    fn external_edit_flows_through_the_runtime_feed() {
        let state = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes"), "UTC").unwrap();
        std::fs::write(
            root.join("external.md"),
            "---\ntitle: External\n---\nBody\n",
        )
        .unwrap();

        let cancellation = mdbase::OperationCancellation::new();
        let mut observed = false;
        for _ in 0..50 {
            if registry
                .ingest_runtime_external(collection.id, Duration::from_millis(20), &cancellation)
                .unwrap()
            {
                observed = true;
                break;
            }
        }
        assert!(
            observed,
            "runtime watcher did not observe the external edit"
        );
        let events = registry
            .finalize_runtime_changes(collection.id, &cancellation)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0.event_type, "mdbase.record.created");
        assert_eq!(events[0].0.payload["path"], "external.md");
        assert_eq!(events[0].0.payload["runtime"]["origin"], "filesystem");
    }
}
