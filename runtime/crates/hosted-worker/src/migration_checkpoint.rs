//! Metadata-only resume policy for the hosted fence-first migration shell.
//!
//! The portable Driver preserves a saved run's mode. Requesting fence-first on
//! reopen does NOT convert an older delta-capture run, so the hosted shell must
//! refuse it. This helper grants no admission, polls no actions and completes no
//! outcomes. In particular, it is not an H0/H1 or rollback authorization front.

use mdbn_migrate_portable::hosted_import::{Driver, Spill};
use mdbn_migrate_portable::{Error, Result};
use mdbn_wire::common::Uuid;

/// Load the existing Driver without changing the collection UUID or saved mode.
/// A saved non-fence-first run is refused rather than silently upgraded/reset.
/// Native/CP authorization must be qualified independently before any action.
pub fn resume_fence_first(spill: &mut dyn Spill, collection: Uuid) -> Result<Driver> {
    if collection.0 == [0; 16] {
        return Err(Error::Invalid(
            "hosted migration needs a collection UUID".into(),
        ));
    }
    let driver = Driver::resume_mode(spill, &collection.to_uuid_string(), true)?;
    if !driver.checkpoint().fence_first {
        return Err(Error::Invalid(
            "hosted migration refuses a saved delta-capture run".into(),
        ));
    }
    Ok(driver)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_migrate_portable::hosted_import::{Checkpoint, MemSpill, Step};
    use mdbn_wire::common::B16;

    fn collection() -> Uuid {
        B16([7; 16])
    }

    #[test]
    fn fresh_metadata_uses_fence_first_and_preserves_collection() {
        let mut spill = MemSpill::default();
        let driver = resume_fence_first(&mut spill, collection()).unwrap();
        assert!(driver.checkpoint().fence_first);
        assert_eq!(
            driver.checkpoint().collection,
            collection().to_uuid_string()
        );
        assert_eq!(driver.status_step(), Step::Start);
        assert!(spill.load().unwrap().is_none()); // no action/start checkpoint was fabricated
    }

    #[test]
    fn saved_delta_capture_mode_is_refused_and_bytes_are_untouched() {
        let mut spill = MemSpill::default();
        let bytes = Checkpoint::new(&collection().to_uuid_string())
            .to_bytes()
            .unwrap();
        spill.save(&bytes).unwrap();
        assert!(resume_fence_first(&mut spill, collection()).is_err());
        assert_eq!(spill.load().unwrap().unwrap(), bytes);
    }

    #[test]
    fn saved_fence_first_rollback_evidence_survives_metadata_resume() {
        let mut spill = MemSpill::default();
        let mut checkpoint = Checkpoint::new(&collection().to_uuid_string());
        checkpoint.fence_first = true;
        checkpoint.step = Step::RollingBack;
        checkpoint.fenced = true;
        checkpoint.backup_hold = Some("synthetic-held-backup".into());
        checkpoint.revoked = vec!["synthetic-owned-replica".into()];
        let bytes = checkpoint.to_bytes().unwrap();
        spill.save(&bytes).unwrap();
        let resumed = resume_fence_first(&mut spill, collection()).unwrap();
        assert_eq!(resumed.checkpoint().to_bytes().unwrap(), bytes);
        assert_eq!(spill.load().unwrap().unwrap(), bytes);
    }

    #[test]
    fn different_collection_and_nil_uuid_refuse_without_reset() {
        let mut spill = MemSpill::default();
        let mut checkpoint = Checkpoint::new(&collection().to_uuid_string());
        checkpoint.fence_first = true;
        let bytes = checkpoint.to_bytes().unwrap();
        spill.save(&bytes).unwrap();
        assert!(resume_fence_first(&mut spill, B16([8; 16])).is_err());
        assert!(resume_fence_first(&mut spill, B16([0; 16])).is_err());
        assert_eq!(spill.load().unwrap().unwrap(), bytes);
    }
}
