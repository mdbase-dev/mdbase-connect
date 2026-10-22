//! Shared installer target resolution. No source IO, authorization or publication.
use super::{CollectionSetup, assess_collection_resources};
use crate::{packs::folder_target_overrides, state::StateView, validate::Issue};

impl CollectionSetup {
    /// Resolve not-yet-installed packs into the collection's configured folders;
    /// installed packs retain the exact targets recorded by their lock. This is
    /// the same decision for Native and the application/Hosted setup planner.
    /// Caller-supplied overrides are replaced, never merged as extra authority.
    pub fn resolve_installer_targets(&mut self, state: &dyn StateView) -> Result<(), Box<Issue>> {
        if self.type_packs.is_empty() {
            return Ok(());
        }
        let initial = assess_collection_resources(state, self)?;
        for (entry, assessed) in self.type_packs.iter_mut().zip(&initial.type_packs) {
            entry.options.target_overrides = match &assessed.current {
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
                            })
                            .map(|installed| (resource.target.clone(), installed.target.clone()))
                    })
                    .collect(),
            };
        }
        Ok(())
    }
}
