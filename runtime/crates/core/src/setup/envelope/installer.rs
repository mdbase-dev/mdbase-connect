//! Shared installer target resolution. No source IO, authorization or publication.
use super::CollectionSetup;
use crate::{
    packs::{Lock, folder_target_overrides},
    paths::path_key,
    state::StateView,
    types::LOCK_PATH,
    validate::Issue,
};
use std::collections::BTreeSet;

impl CollectionSetup {
    /// Resolve not-yet-installed packs into the collection's configured folders;
    /// installed packs retain the exact targets recorded by their lock. This is
    /// the same decision for Native and the application/Hosted setup planner.
    /// Caller-supplied overrides are replaced, never merged as extra authority.
    pub fn resolve_installer_targets(&mut self, state: &dyn StateView) -> Result<(), Box<Issue>> {
        if self.type_packs.is_empty() {
            return Ok(());
        }
        // Only the installed receipts are read here; the setup assessment that
        // follows stages, checks and refuses the resources themselves.
        let lock = match state.resource(LOCK_PATH) {
            Some(source) => Lock::parse(&source).map_err(Box::new)?,
            None => Lock::default(),
        };
        for entry in &mut self.type_packs {
            // A path this version declares belongs to the resource that declares
            // it: an earlier version's receipt never redirects another resource
            // onto it (a contract moved aside when a newer one took its path).
            let declared: BTreeSet<String> = entry
                .pack
                .resources
                .iter()
                .map(|resource| path_key(&resource.target))
                .collect();
            entry.options.target_overrides = match lock.receipt(&entry.pack.id) {
                None => folder_target_overrides(state, &entry.pack),
                Some(receipt) => entry
                    .pack
                    .resources
                    .iter()
                    .filter_map(|resource| {
                        receipt
                            .resources
                            .iter()
                            .find(|installed| {
                                installed.source == resource.source
                                    && installed.kind == resource.kind
                                    && installed.target != resource.target
                                    && !declared.contains(&path_key(&installed.target))
                            })
                            .map(|installed| (resource.target.clone(), installed.target.clone()))
                    })
                    .collect(),
            };
        }
        Ok(())
    }
}
