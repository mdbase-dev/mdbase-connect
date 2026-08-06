use crate::sync_model::*;
use crate::sync_planner::{conflict_draft, Draft, FrozenConflict, InspectedObject};
use crate::MirrorError;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
pub(super) fn order_remote_path_transitions(
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
pub(super) fn order_local_path_transitions(
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
