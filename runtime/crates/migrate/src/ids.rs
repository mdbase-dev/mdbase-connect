//! Text ↔ wire identifiers: re-exported from `mdbn-migrate-portable` so the native
//! migrator and the Worker import parse legacy IDs and revisions identically.

pub use mdbn_migrate_portable::ids::{is_uuid, revision, revision_of, uuid};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_legacy_readers() {
        let s = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";
        assert_eq!(uuid(s).unwrap().to_uuid_string(), s);
        assert_eq!(is_uuid(s), mdbn_legacy::is_uuid(s));
        let r = mdbn_legacy::revision_of(b"x");
        assert_eq!(revision_of(b"x"), r);
        assert_eq!(format!("sha256:{}", revision(&r).unwrap().to_hex()), r);
    }
}
