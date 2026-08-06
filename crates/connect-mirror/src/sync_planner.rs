use crate::sync_codec::fingerprint;
use crate::sync_model::*;
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

struct Draft {
    key: String,
    dependency_keys: Vec<String>,
    action: SyncAction,
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
fn order_remote_path_transitions(
    initial: Vec<Draft>,
    objects: &[InspectedObject],
) -> Result<Vec<Draft>, MirrorError> {
    if !initial
        .iter()
        .any(|draft| matches!(draft.action, SyncAction::MoveRemote { .. }))
    {
        return Ok(initial);
    }
    let mut drafts = initial;
    let mut blocked = BTreeSet::new();
    for cycle in remote_move_cycles(&drafts) {
        for key in cycle {
            if let Some(Draft {
                action: SyncAction::MoveRemote { source, .. },
                ..
            }) = drafts.iter().find(|draft| draft.key == key)
            {
                blocked.insert(source.identity.clone());
            }
        }
    }
    let vacaters = remote_vacaters(&drafts);
    let effects = drafts
        .iter()
        .filter_map(|draft| {
            remote_effect_identity(draft).map(|identity| (draft.key.clone(), identity))
        })
        .collect::<BTreeMap<_, _>>();
    loop {
        let mut changed = false;
        for draft in &drafts {
            if let SyncAction::MoveRemote {
                source,
                expected_target_owner: ExpectedObjectState::Exact { object },
                ..
            } = &draft.action
            {
                if object.identity == source.identity {
                    continue;
                }
                let vacater = vacaters.get(&owner_key(object));
                let unavailable = vacater.is_none()
                    || vacater
                        .and_then(|key| effects.get(key))
                        .is_some_and(|identity| blocked.contains(identity));
                if unavailable && blocked.insert(source.identity.clone()) {
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    if !blocked.is_empty() {
        drafts.retain(|draft| {
            let Some(identity) = remote_effect_identity(draft) else {
                return true;
            };
            !blocked.contains(&identity)
                || !matches!(
                    draft.action,
                    SyncAction::PutRemote { .. } | SyncAction::MoveRemote { .. }
                )
        });
        let by_identity = objects
            .iter()
            .map(|object| (object.identity.as_str(), object))
            .collect::<BTreeMap<_, _>>();
        for identity in blocked {
            let Some(object) = by_identity.get(identity.as_str()) else {
                continue;
            };
            if object.entity == SyncObjectKind::Resource {
                continue;
            }
            drafts.push(conflict_draft(
                object,
                FrozenConflict {
                    local: object.local.clone(),
                    remote: object.remote.clone(),
                    conflict_kind: ConflictKind::PathOccupied,
                },
                SyncPlanReason::LocalChange,
            ));
        }
    }
    let vacaters = remote_vacaters(&drafts);
    for draft in &mut drafts {
        let SyncAction::MoveRemote {
            source,
            expected_target_owner,
            ..
        } = &mut draft.action
        else {
            continue;
        };
        let ExpectedObjectState::Exact { object } = expected_target_owner else {
            continue;
        };
        if object.identity == source.identity {
            continue;
        }
        let Some(dependency) = vacaters.get(&owner_key(object)) else {
            continue;
        };
        if dependency == &draft.key {
            continue;
        }
        if !draft.dependency_keys.contains(dependency) {
            draft.dependency_keys.push(dependency.clone());
        }
        *expected_target_owner = ExpectedObjectState::Absent;
    }
    stable_topological_order(drafts)
}

fn remote_move_cycles(drafts: &[Draft]) -> Vec<Vec<String>> {
    let moves = drafts
        .iter()
        .enumerate()
        .filter(|(_, draft)| matches!(draft.action, SyncAction::MoveRemote { .. }))
        .map(|(index, draft)| (draft.key.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let vacaters = remote_vacaters(drafts);
    let mut cycles = BTreeMap::new();
    for start in moves.keys() {
        let mut path = Vec::new();
        let mut indices = BTreeMap::new();
        let mut cursor = Some(start.clone());
        while let Some(key) = cursor {
            if let Some(prior) = indices.get(&key) {
                let cycle = path[*prior..].to_vec();
                let mut identity = cycle.clone();
                identity.sort();
                cycles.insert(identity.join("\0"), cycle);
                break;
            }
            indices.insert(key.clone(), path.len());
            path.push(key.clone());
            cursor = match &drafts[moves[&key]].action {
                SyncAction::MoveRemote {
                    expected_target_owner: ExpectedObjectState::Exact { object },
                    ..
                } => vacaters
                    .get(&owner_key(object))
                    .filter(|next| moves.contains_key(*next))
                    .cloned(),
                _ => None,
            };
        }
    }
    cycles.into_values().collect()
}

fn remote_vacaters(drafts: &[Draft]) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for draft in drafts {
        let source = match &draft.action {
            SyncAction::MoveRemote { source, .. } => Some(source),
            SyncAction::DeleteRemote { target, .. } => Some(target),
            _ => None,
        };
        if let Some(source) = source {
            result.insert(owner_key(source), draft.key.clone());
        }
    }
    result
}

fn remote_effect_identity(draft: &Draft) -> Option<String> {
    match &draft.action {
        SyncAction::MoveRemote { source, .. } => Some(source.identity.clone()),
        SyncAction::PutRemote { target, .. } | SyncAction::DeleteRemote { target, .. } => {
            Some(target.identity.clone())
        }
        _ => None,
    }
}

/// Local path transitions are planned as one graph. Destinations depend on
/// their vacating action, and cycles use one deterministic staging move. The
/// executor therefore receives a total order and never chooses overwrite
/// behavior from the live filesystem.
fn order_local_path_transitions(
    initial: Vec<Draft>,
    objects: &[InspectedObject],
) -> Result<Vec<Draft>, MirrorError> {
    if !initial.iter().any(|draft| {
        matches!(
            draft.action,
            SyncAction::MoveLocal { .. } | SyncAction::WriteLocal { .. }
        )
    }) {
        return Ok(initial);
    }
    let mut drafts = initial;
    let mut occupied = BTreeSet::new();
    for object in objects {
        for state in [&object.base, &object.local, &object.remote] {
            if let Some(value) = state.exact() {
                occupied.insert(value.path.clone());
            }
        }
    }

    while let Some(cycle) = local_move_cycle(&drafts) {
        let selected_key = cycle.into_iter().min().expect("non-empty cycle");
        let selected_index = drafts
            .iter()
            .position(|draft| draft.key == selected_key)
            .expect("cycle draft");
        let (reason, source, target_path, expected_source_owner, expected_target_owner) =
            match &drafts[selected_index].action {
                SyncAction::MoveLocal {
                    reason,
                    source,
                    target_path,
                    expected_source_owner,
                    expected_target_owner,
                    ..
                } => (
                    *reason,
                    source.clone(),
                    target_path.clone(),
                    expected_source_owner.clone(),
                    expected_target_owner.clone(),
                ),
                _ => {
                    return Err(MirrorError::new(
                        "invalid_sync_plan",
                        "Local path cycle contains a non-move action.",
                    ));
                }
            };
        let temporary_path = staging_path(&source, &target_path, &occupied);
        occupied.insert(temporary_path.clone());
        let staged_source = SyncObjectRef {
            path: temporary_path.clone(),
            ..source.clone()
        };
        let stage_key = format!("{}:stage-local", source.identity);
        let prior_dependencies = std::mem::take(&mut drafts[selected_index].dependency_keys);
        drafts[selected_index].dependency_keys = vec![stage_key.clone()];
        drafts[selected_index].action = SyncAction::MoveLocal {
            action_id: String::new(),
            depends_on: vec![],
            reason,
            source: staged_source.clone(),
            target_path,
            expected_source_owner: ExpectedObjectState::Exact {
                object: staged_source,
            },
            expected_target_owner,
        };
        drafts.insert(
            selected_index,
            Draft {
                key: stage_key,
                dependency_keys: prior_dependencies,
                action: SyncAction::MoveLocal {
                    action_id: String::new(),
                    depends_on: vec![],
                    reason,
                    source,
                    target_path: temporary_path,
                    expected_source_owner,
                    expected_target_owner: ExpectedObjectState::Absent,
                },
            },
        );
    }

    let vacaters = local_vacaters(&drafts);
    let mut blocked = BTreeSet::new();
    let effects = drafts
        .iter()
        .filter_map(|draft| {
            local_effect_identity(draft).map(|identity| (draft.key.clone(), identity))
        })
        .collect::<BTreeMap<_, _>>();
    loop {
        let mut changed = false;
        for draft in &drafts {
            let Some((subject, ExpectedObjectState::Exact { object: owner })) = local_target(draft)
            else {
                continue;
            };
            if owner.identity == subject {
                continue;
            }
            let vacater = vacaters.get(&owner_key(&owner));
            let unavailable = vacater.is_none()
                || vacater
                    .and_then(|key| effects.get(key))
                    .is_some_and(|identity| blocked.contains(identity));
            if unavailable && blocked.insert(subject) {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    if !blocked.is_empty() {
        drafts.retain(|draft| {
            let Some(identity) = local_effect_identity(draft) else {
                return true;
            };
            !blocked.contains(&identity)
                || !matches!(
                    draft.action,
                    SyncAction::MoveLocal { .. } | SyncAction::WriteLocal { .. }
                )
        });
        let by_identity = objects
            .iter()
            .map(|object| (object.identity.as_str(), object))
            .collect::<BTreeMap<_, _>>();
        for identity in blocked {
            let Some(object) = by_identity.get(identity.as_str()) else {
                continue;
            };
            if object.entity == SyncObjectKind::Resource {
                continue;
            }
            drafts.push(conflict_draft(
                object,
                FrozenConflict {
                    local: object.local.clone(),
                    remote: object.remote.clone(),
                    conflict_kind: ConflictKind::PathOccupied,
                },
                SyncPlanReason::RemoteChange,
            ));
        }
    }

    let vacaters = local_vacaters(&drafts);
    for draft in &mut drafts {
        let Some((subject, ExpectedObjectState::Exact { object: owner })) = local_target(draft)
        else {
            continue;
        };
        if owner.identity == subject {
            continue;
        }
        let Some(dependency) = vacaters.get(&owner_key(&owner)) else {
            continue;
        };
        if dependency == &draft.key {
            continue;
        }
        if !draft.dependency_keys.contains(dependency) {
            draft.dependency_keys.push(dependency.clone());
        }
        set_local_target_owner(&mut draft.action, ExpectedObjectState::Absent);
    }
    stable_topological_order(drafts)
}

fn local_move_cycle(drafts: &[Draft]) -> Option<Vec<String>> {
    let moves = drafts
        .iter()
        .enumerate()
        .filter(|(_, draft)| matches!(draft.action, SyncAction::MoveLocal { .. }))
        .map(|(index, draft)| (draft.key.clone(), index))
        .collect::<BTreeMap<_, _>>();
    let vacaters = local_vacaters(drafts);
    for start in moves.keys() {
        let mut path = Vec::new();
        let mut indices = BTreeMap::new();
        let mut cursor = Some(start.clone());
        while let Some(key) = cursor {
            if let Some(prior) = indices.get(&key) {
                return Some(path[*prior..].to_vec());
            }
            indices.insert(key.clone(), path.len());
            path.push(key.clone());
            let draft = &drafts[moves[&key]];
            cursor = match &draft.action {
                SyncAction::MoveLocal {
                    expected_target_owner: ExpectedObjectState::Exact { object },
                    ..
                } => vacaters
                    .get(&owner_key(object))
                    .filter(|next| moves.contains_key(*next))
                    .cloned(),
                _ => None,
            };
        }
    }
    None
}

fn local_vacaters(drafts: &[Draft]) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for draft in drafts {
        let source = match &draft.action {
            SyncAction::MoveLocal { source, .. } => Some(source),
            SyncAction::DeleteLocal { target, .. } => Some(target),
            _ => None,
        };
        if let Some(source) = source {
            result.insert(owner_key(source), draft.key.clone());
        }
    }
    result
}

fn local_target(draft: &Draft) -> Option<(String, ExpectedObjectState)> {
    match &draft.action {
        SyncAction::MoveLocal {
            source,
            expected_target_owner,
            ..
        } => Some((source.identity.clone(), expected_target_owner.clone())),
        SyncAction::WriteLocal {
            target,
            expected_path_owner,
            ..
        } => Some((target.identity.clone(), expected_path_owner.clone())),
        _ => None,
    }
}

fn local_effect_identity(draft: &Draft) -> Option<String> {
    match &draft.action {
        SyncAction::MoveLocal { source, .. } => Some(source.identity.clone()),
        SyncAction::WriteLocal { target, .. } | SyncAction::DeleteLocal { target, .. } => {
            Some(target.identity.clone())
        }
        _ => None,
    }
}

fn set_local_target_owner(action: &mut SyncAction, owner: ExpectedObjectState) {
    match action {
        SyncAction::MoveLocal {
            expected_target_owner,
            ..
        } => *expected_target_owner = owner,
        SyncAction::WriteLocal {
            expected_path_owner,
            ..
        } => *expected_path_owner = owner,
        _ => {}
    }
}

fn owner_key(object: &SyncObjectRef) -> String {
    let entity = match object.entity {
        SyncObjectKind::Record => "record",
        SyncObjectKind::Resource => "resource",
        SyncObjectKind::File => "file",
    };
    format!("{entity}\0{}\0{}", object.identity, object.path)
}

fn staging_path(source: &SyncObjectRef, target_path: &str, occupied: &BTreeSet<String>) -> String {
    let (directory, basename) = source
        .path
        .rsplit_once('/')
        .map(|(directory, basename)| (format!("{directory}/"), basename))
        .unwrap_or_else(|| (String::new(), source.path.as_str()));
    let extension = basename
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| &basename[index..])
        .unwrap_or("");
    for attempt in 0_u64.. {
        let entity = match source.entity {
            SyncObjectKind::Record => "record",
            SyncObjectKind::Resource => "resource",
            SyncObjectKind::File => "file",
        };
        let value = format!(
            "{entity}\0{}\0{}\0{target_path}\0{attempt}",
            source.identity, source.path
        );
        let hash = format!("{:x}", Sha256::digest(value.as_bytes()));
        let candidate = format!("{directory}.mdbase-sync-stage-{}{extension}", &hash[..16]);
        if !occupied.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn stable_topological_order(drafts: Vec<Draft>) -> Result<Vec<Draft>, MirrorError> {
    let mut pending = drafts;
    let mut emitted = BTreeSet::new();
    let mut ordered = Vec::new();
    while !pending.is_empty() {
        let Some(index) = pending.iter().position(|draft| {
            draft
                .dependency_keys
                .iter()
                .all(|dependency| emitted.contains(dependency))
        }) else {
            return Err(MirrorError::new(
                "invalid_sync_plan",
                "Action dependency graph contains a cycle.",
            ));
        };
        let draft = pending.remove(index);
        emitted.insert(draft.key.clone());
        ordered.push(draft);
    }
    Ok(ordered)
}

fn plan_object(
    inspection: &InspectionSummary,
    object: &InspectedObject,
    drafts: &mut Vec<Draft>,
) -> Result<(), MirrorError> {
    if let Some(conflict) = &object.frozen_conflict {
        drafts.push(conflict_draft(
            object,
            conflict.clone(),
            SyncPlanReason::Pending,
        ));
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

fn conflict_draft(
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
