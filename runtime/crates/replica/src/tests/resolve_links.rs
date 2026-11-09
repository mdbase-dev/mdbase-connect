//! `resolve_links` over the real Replica: Core parses and resolves each
//! occurrence where it is written, pending changes included.
use super::engine::{Node, node, settle};
use crate::api::{ClientApi, ResolveLinks};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use mdbn_wire::client::{LinkKind, LinkResolution};
use mdbn_wire::common::B16;

fn resolve(n: &mut Node, from: &str, links: &[&str]) -> Vec<LinkResolution> {
    n.r.resolve_links(
        n.s,
        ResolveLinks {
            from: from.into(),
            links: links.iter().map(|l| (*l).to_owned()).collect(),
        },
    )
    .unwrap()
    .resolutions
}

fn kinds(resolutions: &[LinkResolution]) -> Vec<LinkKind> {
    resolutions.iter().map(|r| r.kind).collect()
}

fn paths(resolutions: &[LinkResolution]) -> Vec<Option<&str>> {
    resolutions.iter().map(|r| r.path.as_deref()).collect()
}

fn put_file(n: &mut Node, id: u8, path: &str) {
    let mut tx = crate::store::Tx::default();
    tx.files_put.push(crate::store::FileRow {
        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
        id: B16([id; 16]),
        path: path.into(),
        path_key: path.into(),
        content: mdbn_wire::attachment::FileContent::Blob(mdbn_wire::intent::BlobRef {
            plain_hash: mdbn_wire::common::B32([id; 32]),
            size: 3,
            blob_id: mdbn_wire::common::B32([id; 32]),
            id_epoch: 1,
            part_size: 8 << 20,
        }),
        media: mdbn_wire::intent::MediaClass::Image,
        modified_seq: 1,
        mtime: None,
        bucket: crate::store::bucket16(&B16([id; 16])),
        local: crate::store::FileLocal::Remote,
    });
    crate::Store::commit(n.r.store_mut(), tx).unwrap();
}

fn collection(svc: &FakeLogService) -> Node {
    let mut a = node(svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(
        10,
        "notes/Target.md",
        "---\ntitle: Launch project\naliases: [Launch]\n---\n# Launch project\n",
    );
    a.create(11, "archive/old/Target.md", "# Older\n");
    // Two same-depth basenames, neither beside the source.
    a.create(12, "left/Twin.md", "# Left\n");
    a.create(13, "right/Twin.md", "# Right\n");
    settle(&mut [&mut a]);
    put_file(&mut a, 30, "assets/diagram.png");
    a
}

#[test]
fn links_resolve_as_core_resolves_them() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let got = resolve(
        &mut a,
        "notes/draft.md",
        &[
            "[[Target]]",
            "[[archive/old/Target]]",
            "[Older](../archive/old/Target.md)",
            "![[Target#Plan|the plan]]",
            "![a diagram](../assets/diagram.png)",
        ],
    );
    assert_eq!(
        kinds(&got),
        [
            LinkKind::Record,
            LinkKind::Record,
            LinkKind::Record,
            LinkKind::Record,
            LinkKind::File
        ]
    );
    assert_eq!(
        paths(&got),
        [
            Some("notes/Target.md"),
            Some("archive/old/Target.md"),
            Some("archive/old/Target.md"),
            Some("notes/Target.md"),
            Some("assets/diagram.png"),
        ]
    );
    assert_eq!(got[0].target, Some(B16([10; 16])));
    assert_eq!(got[4].target, Some(B16([30; 16])));
    assert!(got.iter().all(|r| r.candidates.is_none()));
}

#[test]
fn same_name_ties_follow_core_order() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    // Same depth, neither beside the source: the first in code-point order.
    assert_eq!(
        paths(&resolve(&mut a, "elsewhere/draft.md", &["[[Twin]]"])),
        [Some("left/Twin.md")]
    );
    // Beside the source, its own folder's Twin wins.
    assert_eq!(
        paths(&resolve(&mut a, "right/draft.md", &["[[Twin]]"])),
        [Some("right/Twin.md")]
    );
}

#[test]
fn duplicate_configured_ids_are_ambiguous_with_sorted_candidates() {
    let svc = FakeLogService::new();
    let mut store = MemStore::new();
    crate::Store::commit(
        &mut store,
        crate::store::Tx {
            resources_put: vec![(
                "mdbase.yaml".into(),
                "spec_version: '0.3.0'\nsettings: {id_field: ref}\n".into(),
            )],
            ..crate::store::Tx::default()
        },
    )
    .unwrap();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    a.create(15, "z/first.md", "---\nref: shared\n---\n");
    a.create(16, "a/second.md", "---\nref: shared\n---\n");
    a.create(17, "m/only.md", "---\nref: unique\n---\n");
    settle(&mut [&mut a]);
    let got = resolve(&mut a, "notes/draft.md", &["[[shared]]", "[[unique]]"]);
    assert_eq!(kinds(&got), [LinkKind::Ambiguous, LinkKind::Record]);
    assert_eq!((got[0].target, got[0].path.as_deref()), (None, None));
    assert_eq!(
        got[0].candidates.as_deref(),
        Some(&["a/second.md".to_owned(), "z/first.md".to_owned()][..])
    );
    assert_eq!(got[1].path.as_deref(), Some("m/only.md"));
}

#[test]
fn titles_and_aliases_are_not_link_keys() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let got = resolve(
        &mut a,
        "notes/draft.md",
        &["[[Launch project]]", "[[Launch]]"],
    );
    assert_eq!(kinds(&got), [LinkKind::NotFound; 2]);
    assert!(got.iter().all(|r| r.target.is_none() && r.path.is_none()));
}

#[test]
fn entries_that_are_not_exactly_one_link_are_invalid() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let got = resolve(
        &mut a,
        "notes/draft.md",
        &[
            "[[Target]] [[Twin]]",
            "plain text",
            " [[Target]]",
            "[x](https://example.com)",
            "[x](../../outside.md)",
        ],
    );
    assert_eq!(kinds(&got), [LinkKind::Invalid; 5]);
}

#[test]
fn a_draft_in_a_new_folder_resolves_relative_links_and_sees_pending_changes() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    a.create(14, "notes/Pending.md", "# Not yet confirmed\n");
    let got = resolve(
        &mut a,
        "notes/new/draft.md",
        &["[up](../Target.md)", "[[Pending]]"],
    );
    assert_eq!(
        paths(&got),
        [Some("notes/Target.md"), Some("notes/Pending.md")]
    );
}

#[test]
fn an_invalid_from_path_is_refused() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let error =
        a.r.resolve_links(
            a.s,
            ResolveLinks {
                from: "../outside.md".into(),
                links: vec!["[[Target]]".into()],
            },
        )
        .unwrap_err();
    assert_eq!(error.problem().code, "invalid_request");
}
