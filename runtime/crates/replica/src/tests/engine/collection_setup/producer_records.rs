//! Starter writes remain independently authorized, review-bound and atomic.
use super::declared::{declared_node, declared_node_with_caps};
use super::producer::{call, client, get};
use super::*;
use crate::Store;
use mdbn_wire::cbor::Cbor;
fn records(path: &str, document: &str) -> Vec<(u64, Cbor)> {
    vec![(
        4,
        Cbor::Array(vec![Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Text(path.into())),
            (Cbor::Uint(1), Cbor::Text(document.into())),
        ])]),
    )]
}
#[test]
fn producer_starter_record_shares_complete_setup_receipt_and_never_runs_when_current() {
    let (_, mut a, _) = declared_node();
    let client = client(&mut a);
    let review = call(&mut a, client, "assess", records("Welcome.md", "Welcome\n")).unwrap();
    assert_eq!(get(&review, 3), Cbor::Text("setup_required".into()));
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
    call(
        &mut a,
        client,
        "apply",
        vec![
            (2, get(&review, 2)),
            (3, Cbor::Bytes(vec![0x76; 16])),
            (4, get(&review, 4)),
            (5, get(&review, 5)),
        ],
    )
    .unwrap();
    settle(&mut [&mut a]);
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
    let result = a.r.confirmed_records().unwrap();
    assert!(
        result
            .iter()
            .any(|r| r.path == "Welcome.md" && r.doc == "Welcome\n")
    );
    let current = call(
        &mut a,
        client,
        "assess",
        records("Another.md", "Must not create\n"),
    )
    .unwrap();
    assert_eq!(get(&current, 3), Cbor::Text("ready".into()));
    assert!(
        !a.r.confirmed_records()
            .unwrap()
            .iter()
            .any(|r| r.path == "Another.md")
    );
}
#[test]
fn producer_starter_record_requires_original_records_create_approval() {
    let (_, mut a, _) = declared_node_with_caps(&["collection.read", "records.edit"]);
    let client = client(&mut a);
    assert_eq!(
        call(&mut a, client, "assess", records("Welcome.md", "Welcome\n"))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
}

#[test]
fn producer_starters_skip_occupied_paths_without_needing_create_permission() {
    let (_, mut a, _) = declared_node_with_caps(&["collection.read", "records.edit"]);
    a.create(8, "Welcome.md", "Existing\n");
    settle(&mut [&mut a]);
    let client = client(&mut a);
    let review = call(
        &mut a,
        client,
        "assess",
        records("Welcome.md", "Replacement is forbidden\n"),
    )
    .unwrap();
    let mid = B16([0x77; 16]);
    call(
        &mut a,
        client,
        "apply",
        vec![
            (2, get(&review, 2)),
            (3, Cbor::Bytes(mid.0.to_vec())),
            (4, get(&review, 4)),
            (5, get(&review, 5)),
        ],
    )
    .unwrap();
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store.record(&B16([8; 16])).unwrap().unwrap().doc,
        "Existing\n"
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_some()
    );
}
#[test]
fn producer_invalid_starter_paths_and_documents_publish_no_setup_prefix() {
    let (_, mut a, _) = declared_node();
    let client = client(&mut a);
    for path in [
        "../Escape.md",
        "/Absolute.md",
        "Other.bin",
        "nested//Bad.md",
    ] {
        assert!(call(&mut a, client, "assess", records(path, "Not admitted\n")).is_err());
    }
    assert!(
        call(
            &mut a,
            client,
            "assess",
            records("Bad.md", "---\n: bad: [\n---\n")
        )
        .is_err()
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
    assert!(a.r.confirmed_records().unwrap().is_empty());
}
