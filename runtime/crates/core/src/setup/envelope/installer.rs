//! Shared installer target resolution. No source IO, authorization or publication.
use super::CollectionSetup;
use crate::{packs::default_target_overrides, state::StateView, validate::Issue};

impl CollectionSetup {
    /// Resolve not-yet-installed packs into the collection's configured folders;
    /// installed packs retain the exact targets recorded by their lock. This is
    /// the same decision for Native and the application/Hosted setup planner.
    /// Caller-supplied overrides are replaced, never merged as extra authority.
    pub fn resolve_installer_targets(&mut self, state: &dyn StateView) -> Result<(), Box<Issue>> {
        for entry in &mut self.type_packs {
            entry.options.target_overrides =
                default_target_overrides(state, &entry.pack).map_err(Box::new)?;
        }
        Ok(())
    }
}
