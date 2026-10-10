//! Full-old-connector retirement eligibility. Never infer identity from grant
//! rows, retire a partial inventory, or interpret a failed endpoint as success.
use super::{
    Paths,
    adapter::Evidence,
    record::{Record, State},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::PathBuf;

/// One exact full-inventory request, captured from retained authority-v3+ evidence.
/// This is not authorization: Connect authenticates the current paired caller and
/// checks same-account/exact old inventory independently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Exact old connector identity from retained policy_state.connector_id only.
    pub legacy_connector_id: String,
    /// Every old registered local collection, sorted and bounded.
    pub legacy_collection_ids: Vec<String>,
    /// Client evidence timestamp only; the server owns its retirement timestamp.
    pub taken_over_at: String,
    /// Local proof binding; never transmitted to Connect.
    pub(crate) old_state_dir: PathBuf,
    /// Folder bindings for currentness checks and legacy write locks; not transmitted.
    pub(crate) roots: Vec<PathBuf>,
}

fn canonical_id(s: &str) -> bool {
    crate::attest::uuid_bytes(s)
        .is_some_and(|b| b != [0; 16] && crate::secrets::uuid_string(&b) == s)
}

impl Plan {
    /// Capture a request only if every local folder is complete-or-held, registered
    /// and currently claimed by this profile, with no mirrors or postponed work.
    /// Errors are stable metadata-only reasons, not paths, content or credentials.
    pub fn capture(paths: &Paths, current_connector: &str) -> Result<Plan, &'static str> {
        if !canonical_id(current_connector) {
            return Err("current_connector_missing");
        }
        let record = Record::load(&paths.record)
            .map_err(|_| "takeover_record_unreadable")?
            .ok_or("takeover_not_complete")?;
        if record.state != State::Complete {
            return Err("takeover_not_complete");
        }
        if record.updated_at.len() > 64
            || time::OffsetDateTime::parse(
                &record.updated_at,
                &time::format_description::well_known::Rfc3339,
            )
            .is_err()
        {
            return Err("takeover_timestamp_invalid");
        }
        if !mdbn_legacy::mirror::read_registry(&record.old_state_dir)
            .map_err(|_| "mirror_inventory_unreadable")?
            .is_empty()
        {
            return Err("mirrors_present");
        }
        let old = mdbn_legacy::connector::ConnectorState::open(&record.old_state_dir)
            .map_err(|_| "legacy_inventory_unreadable")?;
        let inventory: Vec<_> = old
            .collections()
            .map_err(|_| "legacy_inventory_unreadable")?
            .into_iter()
            .filter(|c| c.authority_state.as_deref() != Some("retired"))
            .collect();
        if inventory.is_empty() || inventory.len() > 1000 {
            return Err("legacy_inventory_invalid");
        }
        let ids: BTreeSet<_> = inventory.iter().map(|c| c.id.clone()).collect();
        if ids.len() != inventory.len()
            || ids.iter().any(|id| !canonical_id(id))
            || ids != record.collections.keys().cloned().collect()
        {
            return Err("legacy_inventory_mismatch");
        }
        let mut connector = None;
        for old in &inventory {
            let c = record
                .collections
                .get(&old.id)
                .ok_or("legacy_inventory_mismatch")?;
            if !c.state.settled()
                || !c.registered
                || c.marker_incident
                || c.reason.as_deref() == Some("folder_missing")
            {
                return Err("collection_not_ready");
            }
            let evidence = Evidence::load(&paths.legacy, &old.id)
                .map_err(|_| "takeover_evidence_unreadable")?
                .ok_or("takeover_evidence_missing")?;
            if evidence.schema_version != 1
                || evidence.collection != old.id
                || evidence.root != old.path
            {
                return Err("takeover_evidence_mismatch");
            }
            if !super::marker_is_ours(&old.path, &old.id, &paths.store_ids)
                .map_err(|_| "marker_incident")?
            {
                return Err("marker_incident");
            }
            let id = evidence
                .grants
                .pointer("/policy_state/connector_id")
                .and_then(Value::as_str)
                .filter(|s| canonical_id(s))
                .ok_or("legacy_connector_identity_missing")?;
            if id == current_connector {
                return Err("legacy_connector_is_caller");
            }
            if connector.as_deref().is_some_and(|prior| prior != id) {
                return Err("legacy_connector_identity_mismatch");
            }
            connector = Some(id.to_owned());
        }
        Ok(Plan {
            legacy_connector_id: connector.ok_or("legacy_connector_identity_missing")?,
            legacy_collection_ids: ids.into_iter().collect(),
            taken_over_at: record.updated_at,
            old_state_dir: record.old_state_dir,
            roots: inventory.into_iter().map(|c| c.path).collect(),
        })
    }

    /// The migration endpoint body; no local path or grant payload.
    pub fn body(&self) -> Value {
        json!({"legacy_connector_id":self.legacy_connector_id,
            "legacy_collection_ids":self.legacy_collection_ids,"taken_over_at":self.taken_over_at})
    }

    /// Recheck all eligibility after an await, not just the account fence.
    pub fn still_current(&self, paths: &Paths, current_connector: &str) -> bool {
        Self::capture(paths, current_connector).as_ref() == Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::old_agent;
    use super::*;
    use std::time::Duration;
    const OLD: &str = "11111111-1111-4111-8111-111111111111";
    const NEW: &str = "22222222-2222-4222-8222-222222222222";
    struct Fixture {
        root: PathBuf,
        old: PathBuf,
        notes: PathBuf,
        paths: Paths,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn fixture(tag: &str) -> Fixture {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/retirement-fixtures")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("old");
        let notes = root.join("notes");
        old_agent::build(&old, &notes);
        let state = root.join("next");
        let paths = Paths::new(&state, state.join("store-ids.json"));
        super::super::run(
            &paths,
            &old,
            &mut super::super::IsolatedOldService,
            &super::super::Options {
                stop_mirrors: false,
                drain: Duration::ZERO,
                now: "2026-10-08T12:00:00Z".into(),
            },
        )
        .unwrap();
        super::super::mark_registered(&paths, old_agent::CID, "2026-10-08T12:00:00Z").unwrap();
        let mut evidence = Evidence::load(&paths.legacy, old_agent::CID)
            .unwrap()
            .unwrap();
        evidence.grants["policy_state"] = json!({"connector_id":OLD});
        let file = paths.legacy.join(old_agent::CID).join("import.json");
        std::fs::write(file, serde_json::to_vec(&evidence).unwrap()).unwrap();
        Fixture {
            root,
            old,
            notes,
            paths,
        }
    }
    #[test]
    fn exact_full_inventory_and_retained_identity_are_required() {
        let f = fixture("inventory");
        let plan = Plan::capture(&f.paths, NEW).unwrap();
        assert_eq!(plan.legacy_connector_id, OLD);
        assert_eq!(plan.legacy_collection_ids, vec![old_agent::CID]);
        assert!(!plan.body().to_string().contains(f.root.to_str().unwrap()));
        let db = rusqlite::Connection::open(f.old.join("connector.sqlite")).unwrap();
        db.execute("INSERT INTO collections (id,path,display_name,spec_version) VALUES (?1,?2,'Other','0.2.0')",
            ["33333333-3333-4333-8333-333333333333",f.root.join("other").to_str().unwrap()]).unwrap();
        assert_eq!(
            Plan::capture(&f.paths, NEW),
            Err("legacy_inventory_mismatch")
        );
        assert!(!plan.still_current(&f.paths, NEW));
    }
    #[test]
    fn missing_policy_identity_never_falls_back_to_grant_rows_or_caller() {
        let f = fixture("identity");
        assert_eq!(
            Plan::capture(&f.paths, OLD),
            Err("legacy_connector_is_caller")
        );
        let file = f.paths.legacy.join(old_agent::CID).join("import.json");
        let mut evidence = Evidence::load(&f.paths.legacy, old_agent::CID)
            .unwrap()
            .unwrap();
        evidence.grants["policy_state"] = Value::Null;
        evidence.grants["grants"] = json!([{"connector_id":OLD}]);
        std::fs::write(file, serde_json::to_vec(&evidence).unwrap()).unwrap();
        assert_eq!(
            Plan::capture(&f.paths, NEW),
            Err("legacy_connector_identity_missing")
        );
    }
    #[test]
    fn marker_changes_and_postponed_work_block_retirement_without_repair() {
        let f = fixture("marker");
        let plan = Plan::capture(&f.paths, NEW).unwrap();
        let marker = f.notes.join(".mdbase/connect-role.json");
        std::fs::remove_file(&marker).unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("marker_incident"));
        assert!(!plan.still_current(&f.paths, NEW));
        assert!(!marker.exists());
        let mut record = Record::load(&f.paths.record).unwrap().unwrap();
        record.state = State::Postponed;
        record.save(&f.paths.record).unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("takeover_not_complete"));
    }
    #[test]
    fn registration_and_rolled_back_or_missing_folder_never_count_as_ready() {
        let f = fixture("not-ready");
        let mut record = Record::load(&f.paths.record).unwrap().unwrap();
        record
            .collections
            .get_mut(old_agent::CID)
            .unwrap()
            .registered = false;
        record.save(&f.paths.record).unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("collection_not_ready"));
        let c = record.collections.get_mut(old_agent::CID).unwrap();
        c.registered = true;
        c.reason = Some("folder_missing".into());
        record.save(&f.paths.record).unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("collection_not_ready"));
        record.state = State::RolledBack;
        record.save(&f.paths.record).unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("takeover_not_complete"));
    }
    #[test]
    fn any_registered_mirror_blocks_whole_connector_retirement() {
        let f = fixture("mirror");
        std::fs::write(
            f.old.join("mirrors.json"),
            json!({"version":2,"mirrors":[{
            "collection_id":old_agent::CID,"replica_id":old_agent::RID,"path":f.notes,
            "mode":"read_only","lifecycle":"removing"}]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(Plan::capture(&f.paths, NEW), Err("mirrors_present"));
    }
}
