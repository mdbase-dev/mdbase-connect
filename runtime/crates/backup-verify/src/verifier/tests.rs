use super::*;
#[path = "../../tests/support/cut.rs"]
mod support;
use support::{Cut, fixture, source};
fn pages(cut: &Cut, work: &OfflineDecodeBudget) -> Result<CutVerifier, Refusal> {
    let mut verifier = CutVerifier::new(&cut.trust, &cut.completion, work)?;
    verifier.bind_header(&cut.header, &cut.finish)?;
    for page in &cut.pages {
        verifier.push_page(page)?;
    }
    verifier.finish_pages()?;
    Ok(verifier)
}
fn verify(cut: &Cut) -> Result<Verified, Refusal> {
    let work = OfflineDecodeBudget::new();
    let mut verifier = pages(cut, &work)?;
    for (address, raw) in &cut.objects {
        verifier.push_object(address, raw)?;
    }
    verifier.finish()
}
#[test]
fn complete_ordinary_and_compacted_cuts_include_unrefs_times_tokens_and_no_permission() {
    for compacted in [false, true] {
        let result = verify(&fixture(compacted, false, false)).unwrap();
        assert_eq!(result.items, 4);
        assert_eq!(result.objects, 4);
        assert!(
            result
                .json_line()
                .contains("\"current_authority_verified\":false")
        );
        assert!(result.json_line().len() <= 256);
    }
}
#[test]
fn manifest_signer_differs_from_publisher_and_extra_metadata_roots_remain_closed() {
    for indexed in [false, true] {
        assert!(verify(&source(false, indexed, false, true, true)).is_ok());
    }
}
#[test]
fn indexed_snapshot_overlap_uses_complete_unique_expanded_roots() {
    assert_eq!(verify(&fixture(false, true, false)).unwrap().objects, 6);
}
#[test]
fn sealed_near_nine_mib_uses_existing_object_validator() {
    let cut = fixture(false, false, true);
    assert!(
        cut.objects
            .iter()
            .any(|(_, raw)| raw.len() > 4 * 1024 * 1024)
    );
    assert!(verify(&cut).is_ok());
}
#[test]
fn missing_duplicate_and_corrupt_object_poison_finish_and_shared_ledger() {
    let cut = fixture(false, false, false);
    let work = OfflineDecodeBudget::new();
    let verifier = pages(&cut, &work).unwrap();
    assert!(matches!(verifier.finish(), Err(Refusal::Objects)));
    assert!(work.reserve_owned(0).is_err());
    let work = OfflineDecodeBudget::new();
    let mut verifier = pages(&cut, &work).unwrap();
    let (address, raw) = &cut.objects[0];
    verifier.push_object(address, raw).unwrap();
    assert!(verifier.push_object(address, raw).is_err());
    assert!(work.reserve_owned(0).is_err());
    let work = OfflineDecodeBudget::new();
    let mut verifier = pages(&cut, &work).unwrap();
    let mut bad = raw.clone();
    bad[0] ^= 1;
    assert!(verifier.push_object(address, &bad).is_err());
    assert!(work.reserve_owned(0).is_err());
}
#[test]
fn missing_terminal_and_wrong_phase_poison_without_retry() {
    let cut = fixture(false, false, false);
    let work = OfflineDecodeBudget::new();
    let mut verifier = CutVerifier::new(&cut.trust, &cut.completion, &work).unwrap();
    assert!(verifier.finish_pages().is_err());
    assert!(verifier.bind_header(&cut.header, &cut.finish).is_err());
    let work = OfflineDecodeBudget::new();
    let mut verifier = CutVerifier::new(&cut.trust, &cut.completion, &work).unwrap();
    verifier.bind_header(&cut.header, &cut.finish).unwrap();
    for page in &cut.pages[..cut.pages.len() - 1] {
        verifier.push_page(page).unwrap();
    }
    assert!(verifier.finish_pages().is_err());
    assert!(work.reserve_owned(0).is_err());
}
