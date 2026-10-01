use super::*;
use mdbase::runtime::{
    CommitAttempt, HostClaimId, OperationKind, OperationRequest, PreparationOutcome,
};

fn stage(
    registry: &CollectionRegistry,
    id: Uuid,
    claim: &HostClaimId,
    path: &str,
    commit: bool,
) -> String {
    let runtime = registry
        .executor_for(&registry.get(id).unwrap())
        .unwrap()
        .runtime()
        .unwrap();
    let context = operation_context(&mdbase::OperationCancellation::new());
    let request = OperationRequest::new(
        OperationKind::Create,
        json!({"path": path, "frontmatter": {"title": "Keep"}, "body": "exact body"}),
    );
    let prepared = match runtime.prepare_typed(&request, claim, &context).unwrap() {
        PreparationOutcome::Prepared(prepared) => prepared,
        _ => panic!("expected staged mutation"),
    };
    let id = prepared.commit_id().as_str().to_string();
    if commit {
        assert!(matches!(
            runtime.commit(&prepared, &context).unwrap(),
            CommitAttempt::Committed(_)
        ));
    }
    id
}

#[test]
fn local_crash_windows_reconcile_without_acknowledging_external_claims() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("recovery");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, None, "UTC").unwrap();
    // Crash before prepare, after prepare, and after commit before acknowledgement.
    registry.create_local_runtime_claim(collection.id).unwrap();
    let prepared = registry.create_local_runtime_claim(collection.id).unwrap();
    stage(&registry, collection.id, &prepared, "not-written.md", false);
    let committed = registry.create_local_runtime_claim(collection.id).unwrap();
    stage(&registry, collection.id, &committed, "written.md", true);
    let external = HostClaimId::generate();
    stage(&registry, collection.id, &external, "external.md", true);
    registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    drop(registry);
    let registry = CollectionRegistry::open(state.path()).unwrap();
    registry
        .operation(
            collection.id,
            "create",
            &json!({"path": "next.md", "frontmatter": {}}),
        )
        .unwrap();
    registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    assert!(!root.join("not-written.md").exists());
    assert!(root.join("written.md").exists());
    assert!(registry
        .runtime_host_claim_evidence(collection.id, &prepared)
        .unwrap()
        .is_none());
    assert!(registry
        .runtime_host_claim_evidence(collection.id, &committed)
        .unwrap()
        .is_none());
    assert!(registry
        .runtime_host_claim_evidence(collection.id, &external)
        .unwrap()
        .is_some());
    let connection = registry.authority.connection().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM local_runtime_claims", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[test]
fn confirmed_local_update_can_reopen_after_a_later_external_edit() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("external-after-confirmed");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, None, "UTC").unwrap();
    fs::write(root.join("one.md"), "---\ngeneration: 0\n---\ninitial\n").unwrap();
    let updated = registry
        .operation(
            collection.id,
            "update",
            &json!({
                "path": "one.md", "patch": {}, "body": "confirmed update"
            }),
        )
        .unwrap();
    assert_eq!(updated["valid"], true);
    registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    fs::write(
        root.join("one.md"),
        "---\ngeneration: 1\n---\nnew external edit\n",
    )
    .unwrap();
    registry.shutdown_runtimes();
    drop(registry);
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let result = reopened
        .operation(collection.id, "read", &json!({"path": "one.md"}))
        .unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(result["result"]["body"], "new external edit\n");
}

#[cfg(unix)]
#[test]
#[ignore = "CS-05: enable after pinned mdbase-rs clears a denied runtime write without later manual recovery"]
fn denied_local_update_can_reopen_after_permissions_recover_and_an_external_edit() {
    use std::os::unix::fs::PermissionsExt;
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("permission-recovery");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, None, "UTC").unwrap();
    let notes = root.join("notes");
    fs::create_dir(&notes).unwrap();
    fs::write(notes.join("one.md"), "---\ngeneration: 0\n---\ninitial\n").unwrap();
    assert_eq!(
        registry
            .operation(collection.id, "read", &json!({"path": "notes/one.md"}))
            .unwrap()["valid"],
        true
    );
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o555)).unwrap();
    // Root (or equivalent capabilities) bypasses Unix permission faults.
    if fs::write(notes.join("permission-probe"), b"").is_ok() {
        fs::set_permissions(&notes, fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let denied = registry.operation(
        collection.id,
        "update",
        &json!({
            "path": "notes/one.md", "patch": {}, "body": "denied update"
        }),
    );
    fs::set_permissions(&notes, fs::Permissions::from_mode(0o755)).unwrap();
    let denied = denied.unwrap_err();
    assert_eq!(denied.code(), "transaction_io_failed");
    assert_eq!(
        fs::read(notes.join("one.md")).unwrap(),
        b"---\ngeneration: 0\n---\ninitial\n"
    );
    let confirmed = registry
        .operation(
            collection.id,
            "update",
            &json!({
                "path": "notes/one.md", "patch": {}, "body": "confirmed update"
            }),
        )
        .unwrap();
    assert_eq!(confirmed["valid"], true);
    registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    fs::write(
        notes.join("one.md"),
        "---\ngeneration: 1\n---\nnew external edit\n",
    )
    .unwrap();
    registry.shutdown_runtimes();
    drop(registry);
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let result = reopened
        .operation(collection.id, "read", &json!({"path": "notes/one.md"}))
        .unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(result["result"]["body"], "new external edit\n");
}

#[test]
fn legacy_recovery_is_preview_first_selective_verified_and_audited() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("legacy");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, None, "UTC").unwrap();
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["transactions_before"],
        json!([])
    );
    let selected = HostClaimId::generate();
    let selected_id = stage(&registry, collection.id, &selected, "selected.md", true);
    let unrelated = HostClaimId::generate();
    stage(&registry, collection.id, &unrelated, "unrelated.md", true);
    let changed = HostClaimId::generate();
    let changed_id = stage(&registry, collection.id, &changed, "changed.md", true);
    let prepared = HostClaimId::generate();
    let prepared_id = stage(&registry, collection.id, &prepared, "prepared.md", false);
    let application = HostClaimId::generate();
    let application_id = stage(
        &registry,
        collection.id,
        &application,
        "application.md",
        true,
    );
    registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    fs::write(root.join("changed.md"), "independent later edit").unwrap();
    let event_pending = HostClaimId::generate();
    let event_pending_id = stage(
        &registry,
        collection.id,
        &event_pending,
        "event-pending.md",
        true,
    );
    let stored = application.as_str().to_owned();
    registry.authority.write(AuthorityWritePriority::Recovery, move |connection| {
        connection.execute("INSERT INTO mutation_journal (application_installation_id, grant_id, request_id, operation_kind, input_schema_version, input_digest, state, process_epoch, lease_owner, lease_expires_at_ms, fencing_generation, prepared_data, grant_snapshot_digest, accepted_at_ms, updated_at_ms) VALUES ('test', 'test', 'test', 'create', 1, 'test', 'prepared', 'test', 'test', 0, 1, ?1, 'test', 0, 0)", [json!({"host_claim": stored}).to_string()])?;
        Ok(())
    }).unwrap();
    let bytes = fs::read(root.join("selected.md")).unwrap();
    let preview = registry
        .recover_runtime_claims(collection.id, &[], false)
        .unwrap();
    assert_eq!(preview["transactions_before"].as_array().unwrap().len(), 6);
    assert!(!preview.to_string().contains(application.as_str()));
    assert!(!preview.to_string().contains("exact body"));
    assert!(registry
        .recover_runtime_claims(collection.id, std::slice::from_ref(&selected_id), false)
        .is_err());
    for blocked in [
        changed_id,
        prepared_id,
        application_id,
        event_pending_id,
        "../invalid".into(),
    ] {
        assert!(registry
            .recover_runtime_claims(collection.id, &[selected_id.clone(), blocked], true)
            .is_err());
        assert!(registry
            .runtime_host_claim_evidence(collection.id, &selected)
            .unwrap()
            .is_some());
    }
    let recovered = registry
        .recover_runtime_claims(collection.id, std::slice::from_ref(&selected_id), true)
        .unwrap();
    assert_eq!(recovered["recovered"], json!([selected_id]));
    assert!(recovered["audit"][0]["completed_at_ms"].is_i64());
    assert_eq!(fs::read(root.join("selected.md")).unwrap(), bytes);
    assert!(registry
        .runtime_host_claim_evidence(collection.id, &selected)
        .unwrap()
        .is_none());
    for claim in [
        &unrelated,
        &changed,
        &prepared,
        &application,
        &event_pending,
    ] {
        assert!(registry
            .runtime_host_claim_evidence(collection.id, claim)
            .unwrap()
            .is_some());
    }
    drop(registry);
    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["audit"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn recovery_unblocks_a_full_legacy_collection_without_clearing_unrelated_claims() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("full");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, None, "UTC").unwrap();
    let unrelated = HostClaimId::generate();
    stage(&registry, collection.id, &unrelated, "unrelated.md", true);
    let mut selected = Vec::new();
    for index in 0..127 {
        selected.push(stage(
            &registry,
            collection.id,
            &HostClaimId::generate(),
            &format!("record-{index}.md"),
            true,
        ));
        registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap();
    }
    let error = registry
        .operation(
            collection.id,
            "create",
            &json!({"path": "blocked.md", "frontmatter": {}}),
        )
        .unwrap_err();
    assert_eq!(error.code(), "runtime_capacity_exhausted");
    assert!(!root.join("blocked.md").exists());
    drop(registry);
    let registry = CollectionRegistry::open(state.path()).unwrap();
    // Plain restart preserves the full historical journal set.
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["transactions_before"]
            .as_array()
            .unwrap()
            .len(),
        128
    );
    let recovered = registry
        .recover_runtime_claims(collection.id, &selected, true)
        .unwrap();
    assert_eq!(recovered["recovered"].as_array().unwrap().len(), 127);
    assert_eq!(
        registry
            .operation(
                collection.id,
                "create",
                &json!({"path": "unblocked.md", "frontmatter": {}})
            )
            .unwrap()["valid"],
        true
    );
    assert!(registry
        .runtime_host_claim_evidence(collection.id, &unrelated)
        .unwrap()
        .is_some());
    for index in 0..127 {
        assert_eq!(
            fs::read_to_string(root.join(format!("record-{index}.md"))).unwrap(),
            "---\ntitle: Keep\n---\nexact body\n"
        );
    }
}

#[test]
fn failed_and_partial_batches_leave_no_local_claim_obligations() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry
        .create(parent.path().join("invalid"), None, "UTC")
        .unwrap();
    for input in [
        json!({"operations": [{"kind": "update", "input": {"path": "missing.md", "patch": {"title": "no"}}}]}),
        json!({"allow_partial": true, "operations": []}),
    ] {
        let result = registry.operation(collection.id, "batch", &input).unwrap();
        assert_eq!(result["valid"], false);
    }
    let connection = registry.authority.connection().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM local_runtime_claims", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["transactions_before"],
        json!([])
    );
}
