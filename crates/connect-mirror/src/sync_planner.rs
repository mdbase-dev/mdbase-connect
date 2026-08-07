use crate::sync_codec::fingerprint;
use crate::sync_model::*;
use crate::sync_path_planner::{order_local_path_transitions, order_remote_path_transitions};
use crate::MirrorError;
use mdbase_connect_protocol::{SelectiveSyncPolicy, SyncReplicaMode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InspectedObject {
    pub entity: SyncObjectKind,
    pub identity: String,
    pub base: ExpectedObjectState,
    pub local: ExpectedObjectState,
    pub remote: ExpectedObjectState,
    pub local_target_owner: ExpectedObjectState,
    pub remote_target_owner: ExpectedObjectState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_conflict: Option<FrozenConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrozenConflict {
    pub local: ExpectedObjectState,
    pub remote: ExpectedObjectState,
    pub conflict_kind: ConflictKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InspectionBoundary {
    pub replica_id: String,
    pub scope_epoch: u64,
    pub authority_cursor: u64,
    pub checkpoint: SyncCheckpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InspectionSummary {
    pub boundary: InspectionBoundary,
    pub mode: SyncReplicaMode,
    pub kind: String,
    pub selective_sync: SelectiveSyncPolicy,
    pub objects: Vec<InspectedObject>,
    pub issues: Vec<MirrorPlanIssue>,
}

#[derive(Debug, Clone)]
pub struct ObservedObject {
    pub object: SyncObjectRef,
    pub stable_identity: bool,
}

pub struct ObjectUniverse {
    pub base: Vec<SyncObjectRef>,
    pub local: Vec<ObservedObject>,
    pub remote: Vec<SyncObjectRef>,
}

pub(super) struct Draft {
    pub(super) key: String,
    pub(super) dependency_keys: Vec<String>,
    pub(super) action: SyncAction,
}

pub fn identify_objects(universe: ObjectUniverse, seed: &str) -> Vec<InspectedObject> {
    let base = universe
        .base
        .into_iter()
        .map(|value| (value.identity.clone(), value))
        .collect::<BTreeMap<_, _>>();
    let remote = universe
        .remote
        .into_iter()
        .map(|value| (value.identity.clone(), value))
        .collect::<BTreeMap<_, _>>();
    let mut local = BTreeMap::<String, SyncObjectRef>::new();
    let mut untracked = universe
        .local
        .into_iter()
        .map(|value| (value.object.path.clone(), value))
        .collect::<BTreeMap<_, _>>();

    for observed in untracked.values() {
        if observed.stable_identity && !observed.object.identity.is_empty() {
            local.insert(observed.object.identity.clone(), observed.object.clone());
        }
    }
    for value in local.values() {
        untracked.remove(&value.path);
    }
    for (identity, base_object) in &base {
        if let Some(observed) = untracked.remove(&base_object.path) {
            local.insert(identity.clone(), with_identity(observed.object, identity));
        }
    }
    for (identity, remote_object) in &remote {
        if local.contains_key(identity) {
            continue;
        }
        if untracked
            .get(&remote_object.path)
            .is_some_and(|value| value.object.entity == remote_object.entity)
        {
            let observed = untracked.remove(&remote_object.path).expect("checked");
            local.insert(identity.clone(), with_identity(observed.object, identity));
        }
    }
    for (identity, base_object) in &base {
        if local.contains_key(identity) {
            continue;
        }
        let candidates = untracked
            .values()
            .filter(|value| {
                value.object.entity == base_object.entity
                    && value.object.payload_revision == base_object.payload_revision
            })
            .map(|value| value.object.path.clone())
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            continue;
        }
        let observed = untracked.remove(&candidates[0]).expect("selected");
        let mut object = with_identity(observed.object, identity);
        if object.payload_revision == base_object.payload_revision {
            object.revision = base_object.revision.clone();
        }
        local.insert(identity.clone(), object);
    }
    for observed in untracked.into_values() {
        let identity = if observed.stable_identity {
            observed.object.identity.clone()
        } else {
            deterministic_identity(seed, &observed.object)
        };
        local.insert(identity.clone(), with_identity(observed.object, &identity));
    }

    let identities = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let local_paths = local
        .values()
        .map(|value| (value.path.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let remote_paths = remote
        .values()
        .map(|value| (value.path.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    identities
        .into_iter()
        .map(|identity| {
            let base_object = base.get(&identity);
            let local_object = local.get(&identity);
            let remote_object = remote.get(&identity);
            let representative = local_object
                .or(remote_object)
                .or(base_object)
                .expect("identity");
            let local_target = remote_object
                .or(local_object)
                .or(base_object)
                .expect("path")
                .path
                .clone();
            let remote_target = local_object
                .or(remote_object)
                .or(base_object)
                .expect("path")
                .path
                .clone();
            InspectedObject {
                entity: representative.entity.clone(),
                identity,
                base: object_state(base_object),
                local: object_state(local_object),
                remote: object_state(remote_object),
                local_target_owner: object_state(local_paths.get(&local_target)),
                remote_target_owner: object_state(remote_paths.get(&remote_target)),
                frozen_conflict: None,
            }
        })
        .collect()
}

pub fn plan_reconciliation(
    mut inspection: InspectionSummary,
) -> Result<MirrorSyncPlan, MirrorError> {
    inspection.objects.sort_by(|left, right| {
        (&left.entity, &left.identity).cmp(&(&right.entity, &right.identity))
    });
    let mut drafts = Vec::new();
    for object in &inspection.objects {
        plan_object(&inspection, object, &mut drafts)?;
    }
    drafts = order_local_path_transitions(drafts, &inspection.objects)?;
    drafts = order_remote_path_transitions(drafts, &inspection.objects)?;
    let requires_checkpoint = !drafts.is_empty()
        || inspection.kind != "incremental"
        || inspection.boundary.checkpoint.cursor != Some(inspection.boundary.authority_cursor);
    if requires_checkpoint {
        let effect_keys = drafts
            .iter()
            .map(|draft| draft.key.clone())
            .collect::<Vec<_>>();
        drafts.push(Draft {
            key: "checkpoint".into(),
            dependency_keys: effect_keys,
            action: SyncAction::AdvanceCheckpoint {
                action_id: String::new(),
                depends_on: Vec::new(),
                reason: if inspection.kind == "incremental" {
                    SyncPlanReason::RemoteChange
                } else if inspection.kind == "rebuild" {
                    SyncPlanReason::Rebuild
                } else {
                    SyncPlanReason::Initial
                },
                expected: inspection.boundary.checkpoint.clone(),
                next: SyncCheckpoint {
                    generation: inspection.boundary.checkpoint.generation + 1,
                    cursor: Some(inspection.boundary.authority_cursor),
                },
            },
        });
    }
    let mut ids = BTreeMap::new();
    for draft in &drafts {
        ids.insert(draft.key.clone(), draft_id(draft, &inspection.boundary)?);
    }
    let mut actions = Vec::new();
    for mut draft in drafts {
        let id = ids[&draft.key].clone();
        let dependencies = draft
            .dependency_keys
            .iter()
            .map(|key| ids[key].clone())
            .collect::<Vec<_>>();
        let revision_dependency = match &draft.action {
            SyncAction::MoveRemote { source, .. } => draft
                .dependency_keys
                .iter()
                .find(|key| *key == &format!("{}:put-remote", source.identity))
                .map(|key| ids[key].clone()),
            _ => None,
        };
        set_action_metadata(&mut draft.action, id, dependencies, revision_dependency);
        actions.push(draft.action);
    }
    inspection.issues.sort_by(|left, right| {
        (&left.path, &left.code, &left.message).cmp(&(&right.path, &right.code, &right.message))
    });
    let summary = MirrorPlanSummary {
        uploads: actions
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    SyncAction::PutRemote { .. }
                        | SyncAction::MoveRemote { .. }
                        | SyncAction::DeleteRemote { .. }
                )
            })
            .count(),
        downloads: actions
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    SyncAction::WriteLocal { .. }
                        | SyncAction::MoveLocal { .. }
                        | SyncAction::DeleteLocal { .. }
                )
            })
            .count(),
        conflicts: actions
            .iter()
            .filter(|action| matches!(action, SyncAction::RecordConflict { .. }))
            .count(),
        blocking_issues: inspection
            .issues
            .iter()
            .filter(|issue| issue.blocking)
            .count(),
    };
    #[derive(Serialize)]
    struct Stable<'a> {
        plan_version: u32,
        engine_profile: &'static str,
        protocol_profile: &'static str,
        planner_policy: &'static str,
        projection_policy: &'static str,
        replica_id: &'a str,
        mode: SyncReplicaMode,
        kind: &'a str,
        base_cursor: Option<u64>,
        authority_cursor: u64,
        scope_epoch: u64,
        checkpoint_generation: u64,
        selective_sync: &'a SelectiveSyncPolicy,
        actions: &'a [SyncAction],
        issues: &'a [MirrorPlanIssue],
        summary: &'a MirrorPlanSummary,
    }
    let stable = Stable {
        plan_version: 1,
        engine_profile: ENGINE_PROFILE,
        protocol_profile: PROTOCOL_PROFILE,
        planner_policy: PLANNER_POLICY,
        projection_policy: PROJECTION_POLICY,
        replica_id: &inspection.boundary.replica_id,
        mode: inspection.mode,
        kind: &inspection.kind,
        base_cursor: inspection.boundary.checkpoint.cursor,
        authority_cursor: inspection.boundary.authority_cursor,
        scope_epoch: inspection.boundary.scope_epoch,
        checkpoint_generation: inspection.boundary.checkpoint.generation,
        selective_sync: &inspection.selective_sync,
        actions: &actions,
        issues: &inspection.issues,
        summary: &summary,
    };
    let plan_fingerprint = fingerprint(&stable)?;
    Ok(MirrorSyncPlan {
        plan_version: 1,
        engine_profile: ENGINE_PROFILE.into(),
        protocol_profile: PROTOCOL_PROFILE.into(),
        planner_policy: PLANNER_POLICY.into(),
        projection_policy: PROJECTION_POLICY.into(),
        fingerprint: plan_fingerprint,
        replica_id: inspection.boundary.replica_id,
        mode: inspection.mode,
        kind: inspection.kind,
        base_cursor: inspection.boundary.checkpoint.cursor,
        authority_cursor: inspection.boundary.authority_cursor,
        scope_epoch: inspection.boundary.scope_epoch,
        checkpoint_generation: inspection.boundary.checkpoint.generation,
        selective_sync: inspection.selective_sync,
        actions,
        issues: inspection.issues,
        summary,
    })
}

/// Remote destinations depend on the command that vacates them. Protocol v1
/// has no atomic remote staging primitive, so a rename cycle is a planned path
/// conflict instead of an executor-side retry or overwrite decision.
fn plan_object(
    inspection: &InspectionSummary,
    object: &InspectedObject,
    drafts: &mut Vec<Draft>,
) -> Result<(), MirrorError> {
    if let Some(conflict) = &object.frozen_conflict {
        drafts.push(
            if same_conflict_content(&conflict.local, &conflict.remote) {
                Draft {
                    key: format!("{}:clear-conflict", object.identity),
                    dependency_keys: vec![],
                    action: SyncAction::ClearConflict {
                        action_id: String::new(),
                        depends_on: vec![],
                        reason: SyncPlanReason::Pending,
                        identity: object.identity.clone(),
                        entity: object.entity.clone(),
                        expected_local: conflict.local.clone(),
                        expected_remote: conflict.remote.clone(),
                    },
                }
            } else {
                conflict_draft(object, conflict.clone(), SyncPlanReason::Pending)
            },
        );
        return Ok(());
    }
    let local_changed = object.local != object.base;
    let remote_changed = object.remote != object.base;
    if !local_changed && !remote_changed {
        return Ok(());
    }
    if object.entity == SyncObjectKind::Resource {
        if !local_changed {
            plan_remote_to_local(object, drafts)?;
        }
        return Ok(());
    }
    if inspection.mode == SyncReplicaMode::ReadOnly {
        if !local_changed {
            plan_remote_to_local(object, drafts)?;
        }
        return Ok(());
    }
    if local_changed && remote_changed {
        if object.local != object.remote {
            drafts.push(conflict_draft(
                object,
                FrozenConflict {
                    local: object.local.clone(),
                    remote: object.remote.clone(),
                    conflict_kind: if object.local == ExpectedObjectState::Absent
                        || object.remote == ExpectedObjectState::Absent
                    {
                        ConflictKind::DeleteVsChange
                    } else {
                        ConflictKind::BothChanged
                    },
                },
                SyncPlanReason::RemoteChange,
            ));
        }
    } else if local_changed {
        plan_local_to_remote(object, drafts)?;
    } else {
        plan_remote_to_local(object, drafts)?;
    }
    Ok(())
}

fn same_conflict_content(left: &ExpectedObjectState, right: &ExpectedObjectState) -> bool {
    match (left, right) {
        (ExpectedObjectState::Absent, ExpectedObjectState::Absent) => true,
        (
            ExpectedObjectState::Exact { object: left },
            ExpectedObjectState::Exact { object: right },
        ) => {
            left.entity == right.entity
                && left.identity == right.identity
                && left.path == right.path
                && left.payload_revision == right.payload_revision
                && left.size == right.size
        }
        _ => false,
    }
}

fn plan_remote_to_local(
    object: &InspectedObject,
    drafts: &mut Vec<Draft>,
) -> Result<(), MirrorError> {
    let Some(remote) = object.remote.exact() else {
        if let Some(local) = object.local.exact() {
            drafts.push(Draft {
                key: format!("{}:delete-local", object.identity),
                dependency_keys: vec![],
                action: SyncAction::DeleteLocal {
                    action_id: String::new(),
                    depends_on: vec![],
                    reason: SyncPlanReason::RemoteChange,
                    target: local.clone(),
                    expected_local: object.local.clone(),
                    expected_path_owner: object.local_target_owner.clone(),
                },
            });
        }
        return Ok(());
    };
    let Some(local) = object.local.exact() else {
        drafts.push(write_local(object, remote.clone(), vec![]));
        return Ok(());
    };
    let mut dependency = None;
    if local.path != remote.path {
        let key = format!("{}:move-local", object.identity);
        drafts.push(Draft {
            key: key.clone(),
            dependency_keys: vec![],
            action: SyncAction::MoveLocal {
                action_id: String::new(),
                depends_on: vec![],
                reason: SyncPlanReason::RemoteChange,
                source: local.clone(),
                target_path: remote.path.clone(),
                expected_source_owner: object.local.clone(),
                expected_target_owner: object.local_target_owner.clone(),
            },
        });
        dependency = Some(key);
    }
    if local.revision != remote.revision {
        drafts.push(write_local(
            object,
            remote.clone(),
            dependency.into_iter().collect(),
        ));
    }
    Ok(())
}

fn write_local(
    object: &InspectedObject,
    target: SyncObjectRef,
    dependencies: Vec<String>,
) -> Draft {
    let expected = if dependencies.is_empty() {
        object.local.clone()
    } else {
        let local = object.local.exact().expect("move source");
        ExpectedObjectState::Exact {
            object: SyncObjectRef {
                path: target.path.clone(),
                revision: local.revision.clone(),
                payload_revision: local.payload_revision.clone(),
                size: local.size,
                ..target.clone()
            },
        }
    };
    Draft {
        key: format!("{}:write-local", object.identity),
        dependency_keys: dependencies,
        action: SyncAction::WriteLocal {
            action_id: String::new(),
            depends_on: vec![],
            reason: SyncPlanReason::RemoteChange,
            target: target.clone(),
            payload_revision: target.payload_revision.clone(),
            expected_local: expected.clone(),
            expected_path_owner: if matches!(expected, ExpectedObjectState::Exact { .. }) {
                expected
            } else {
                object.local_target_owner.clone()
            },
        },
    }
}

fn plan_local_to_remote(
    object: &InspectedObject,
    drafts: &mut Vec<Draft>,
) -> Result<(), MirrorError> {
    let Some(local) = object.local.exact() else {
        if let Some(remote) = object.remote.exact() {
            drafts.push(Draft {
                key: format!("{}:delete-remote", object.identity),
                dependency_keys: vec![],
                action: SyncAction::DeleteRemote {
                    action_id: String::new(),
                    depends_on: vec![],
                    reason: SyncPlanReason::LocalChange,
                    target: remote.clone(),
                    expected_remote: object.remote.clone(),
                    expected_local: object.local.clone(),
                    idempotency_key: String::new(),
                },
            });
        }
        return Ok(());
    };
    let Some(remote) = object.remote.exact() else {
        drafts.push(put_remote(object, local.clone(), vec![]));
        return Ok(());
    };
    let mut dependency = None;
    if local.revision != remote.revision {
        let target = SyncObjectRef {
            path: remote.path.clone(),
            ..local.clone()
        };
        let draft = put_remote(object, target, vec![]);
        dependency = Some(draft.key.clone());
        drafts.push(draft);
    }
    if local.path != remote.path {
        let predicted = SyncObjectRef {
            revision: local.revision.clone(),
            ..remote.clone()
        };
        let expected_source = if dependency.is_some() {
            ExpectedObjectState::Exact {
                object: predicted.clone(),
            }
        } else {
            object.remote.clone()
        };
        drafts.push(Draft {
            key: format!("{}:move-remote", object.identity),
            dependency_keys: dependency.into_iter().collect(),
            action: SyncAction::MoveRemote {
                action_id: String::new(),
                depends_on: vec![],
                reason: SyncPlanReason::LocalChange,
                source: predicted,
                target_path: local.path.clone(),
                expected_source_owner: expected_source,
                expected_target_owner: object.remote_target_owner.clone(),
                expected_local: object.local.clone(),
                revision_from_dependency: None,
                idempotency_key: String::new(),
            },
        });
    }
    Ok(())
}

fn put_remote(object: &InspectedObject, target: SyncObjectRef, dependencies: Vec<String>) -> Draft {
    Draft {
        key: format!("{}:put-remote", object.identity),
        dependency_keys: dependencies,
        action: SyncAction::PutRemote {
            action_id: String::new(),
            depends_on: vec![],
            reason: SyncPlanReason::LocalChange,
            target,
            payload_revision: object
                .local
                .exact()
                .expect("local payload")
                .payload_revision
                .clone(),
            expected_remote: object.remote.clone(),
            expected_local: object.local.clone(),
            idempotency_key: String::new(),
        },
    }
}

pub(super) fn conflict_draft(
    object: &InspectedObject,
    conflict: FrozenConflict,
    reason: SyncPlanReason,
) -> Draft {
    Draft {
        key: format!("{}:conflict", object.identity),
        dependency_keys: vec![],
        action: SyncAction::RecordConflict {
            action_id: String::new(),
            depends_on: vec![],
            reason,
            identity: object.identity.clone(),
            entity: object.entity.clone(),
            local: conflict.local,
            remote: conflict.remote,
            conflict_kind: conflict.conflict_kind,
        },
    }
}

fn draft_id(draft: &Draft, boundary: &InspectionBoundary) -> Result<String, MirrorError> {
    let mut value = serde_json::to_value(&draft.action).map_err(MirrorError::from)?;
    let object = value.as_object_mut().expect("action object");
    object.remove("action_id");
    object.remove("depends_on");
    object.remove("revision_from_dependency");
    object.insert(
        "action_scope".into(),
        serde_json::json!({
            "replica_id": boundary.replica_id,
            "scope_epoch": boundary.scope_epoch,
            "generation": boundary.checkpoint.generation,
        }),
    );
    object.insert("key".into(), Value::String(draft.key.clone()));
    fingerprint(&value)
}

fn set_action_metadata(
    action: &mut SyncAction,
    id: String,
    dependencies: Vec<String>,
    revision_dependency: Option<String>,
) {
    match action {
        SyncAction::WriteLocal {
            action_id,
            depends_on,
            ..
        }
        | SyncAction::DeleteLocal {
            action_id,
            depends_on,
            ..
        }
        | SyncAction::MoveLocal {
            action_id,
            depends_on,
            ..
        }
        | SyncAction::RecordConflict {
            action_id,
            depends_on,
            ..
        }
        | SyncAction::ClearConflict {
            action_id,
            depends_on,
            ..
        }
        | SyncAction::AdvanceCheckpoint {
            action_id,
            depends_on,
            ..
        } => {
            *action_id = id;
            *depends_on = dependencies;
        }
        SyncAction::PutRemote {
            action_id,
            depends_on,
            idempotency_key,
            ..
        }
        | SyncAction::DeleteRemote {
            action_id,
            depends_on,
            idempotency_key,
            ..
        } => {
            *action_id = id.clone();
            *depends_on = dependencies;
            *idempotency_key = id;
        }
        SyncAction::MoveRemote {
            action_id,
            depends_on,
            revision_from_dependency,
            idempotency_key,
            ..
        } => {
            *action_id = id.clone();
            *depends_on = dependencies;
            *revision_from_dependency = revision_dependency;
            *idempotency_key = id;
        }
    }
}

fn object_state(value: Option<&SyncObjectRef>) -> ExpectedObjectState {
    value
        .cloned()
        .map(|object| ExpectedObjectState::Exact { object })
        .unwrap_or(ExpectedObjectState::Absent)
}

fn with_identity(mut object: SyncObjectRef, identity: &str) -> SyncObjectRef {
    object.identity = identity.into();
    object
}

fn deterministic_identity(seed: &str, object: &SyncObjectRef) -> String {
    let entity = match object.entity {
        SyncObjectKind::Record => "record",
        SyncObjectKind::Resource => "resource",
        SyncObjectKind::File => "file",
    };
    let value = format!("{seed}\0{entity}\0{}\0{}", object.path, object.revision);
    let hex = format!("{:x}", Sha256::digest(value.as_bytes()));
    format!(
        "{}-{}-5{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}
