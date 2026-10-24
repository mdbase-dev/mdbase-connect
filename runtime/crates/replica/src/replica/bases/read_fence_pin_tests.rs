//! Discovery Weak residency reserves identity without pinning catalogue maps.
use super::*;
#[test]
fn discovery_identity_releases_contents_but_never_accepts_dead_or_new_catalog() {
    let catalog = Arc::new(Catalog::empty());
    let observer = Arc::downgrade(&catalog);
    let identity = CatalogPin::Discovery(Arc::downgrade(&catalog));
    assert_eq!(Arc::strong_count(&catalog), 1);
    assert!(identity.matches(&catalog));
    let replacement = Arc::new(Catalog::empty());
    assert!(!identity.matches(&replacement));
    drop(catalog);
    assert!(observer.upgrade().is_none());
    assert!(!identity.matches(&replacement));
}
#[test]
fn weak_control_block_and_inline_catalog_are_inside_slot_accounting() {
    let bytes = BasesReadFence::discovery_catalog_allocation_bytes();
    assert!(bytes >= (std::mem::size_of::<Catalog>() + 2 * std::mem::size_of::<usize>()) as u64);
    assert!(bytes < 4096);
}
