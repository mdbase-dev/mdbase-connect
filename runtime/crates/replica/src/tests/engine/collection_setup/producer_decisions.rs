//! Original-client reviewed adoption, never extra setup or definition authority.
use super::declared::declared_node;
use super::producer::{call, client, get};
use super::*;
use crate::Store;
use mdbn_core::{
    ids::revision,
    packs::{AssessOptions, load_pack},
    setup::envelope::CollectionSetupTypePack,
};
use mdbn_wire::cbor::Cbor;
const PATH: &str = "_types/note.md";
fn fixture(mode: &str) -> (Node, String, String) {
    let (_, mut a, source) = declared_node();
    let declared = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let existing = format!("{declared}Existing unmanaged definition.\n");
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: {mode}\n    source: note.md\n    target: {PATH}\n    digest: {}\n",
        revision(declared)
    );
    let app = source
        .borrow()
        .as_ref()
        .unwrap()
        .setup
        .application_id
        .clone();
    source
        .borrow_mut()
        .as_mut()
        .unwrap()
        .setup
        .type_packs
        .push(CollectionSetupTypePack {
            pack: load_pack(&manifest, &|_| Some(declared.into())).unwrap(),
            options: AssessOptions {
                installed_by: app,
                ..Default::default()
            },
        });
    super::capture::upload(&mut a, 7, "views/existing.base", b"views: []\r\n");
    put(&mut a, &existing, None);
    (a, existing, declared.into())
}
fn put(a: &mut Node, document: &str, base: Option<B32>) {
    a.r.submit(
        a.s,
        SubmitParams {
            ops: vec![Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                path: PATH.into(),
                doc: mdbn_wire::common::Text::Inline(document.into()),
                base_revision: base,
                must_not_exist: Some(base.is_none()),
            })],
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .unwrap();
    settle(&mut [&mut *a]);
}
fn choices(path: &str, digest: mdbn_core::ids::Hash) -> Vec<(u64, Cbor)> {
    vec![(
        3,
        Cbor::Map(vec![(
            Cbor::Text(path.into()),
            Cbor::Bytes(digest.0.to_vec()),
        )]),
    )]
}
fn adopt(a: &mut Node, client: crate::api::SessionId, existing: &str) -> Cbor {
    let pending = call(a, client, "assess", choices(PATH, revision(existing))).unwrap();
    assert_eq!(
        get(&pending, 1),
        Cbor::Text("pending".into()),
        "adoption must discover the complete prospective source work"
    );
    let ticket = get(&pending, 2);
    settle(&mut [&mut *a]);
    call(a, client, "poll", vec![(2, ticket)]).unwrap()
}
fn apply_fields(review: &Cbor) -> Vec<(u64, Cbor)> {
    vec![
        (2, get(review, 2)),
        (3, Cbor::Bytes(vec![0x74; 16])),
        (4, get(review, 4)),
        (5, get(review, 5)),
    ]
}
#[test]
fn producer_applies_only_exact_reviewed_unmanaged_definition_adoption() {
    let (mut a, existing, declared) = fixture("managed");
    let client = client(&mut a);
    let first = call(&mut a, client, "assess", vec![]).unwrap();
    assert_eq!(get(&first, 3), Cbor::Text("incompatible".into()));
    let adopted = adopt(&mut a, client, &existing);
    assert_eq!(get(&adopted, 3), Cbor::Text("setup_required".into()));
    assert_eq!(
        a.r.store.resource(PATH).unwrap().as_deref(),
        Some(existing.as_str())
    );
    assert!(a.r.store.record(&B16([7; 16])).unwrap().is_none());
    call(&mut a, client, "apply", apply_fields(&adopted)).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store.resource(PATH).unwrap().as_deref(),
        Some(declared.as_str())
    );
    assert_eq!(
        a.r.store.record(&B16([7; 16])).unwrap().unwrap().doc,
        "views: []\r\n"
    );
    assert_eq!(
        a.r.receipt(client, B16([0x74; 16])).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
    let subsequent = call(&mut a, client, "assess", vec![]).unwrap();
    assert_eq!(
        get(&subsequent, 3),
        Cbor::Text("ready".into()),
        "adoption must not alter durable provision identity"
    );
    assert!(
        call(&mut a, client, "assess", choices(PATH, revision(&declared))).is_err(),
        "installed resources cannot be adopted again"
    );
}
#[test]
fn producer_adoption_refuses_changed_unknown_and_seed_targets_without_effects() {
    for mode in ["managed", "seed"] {
        let (mut a, existing, _) = fixture(mode);
        let client = client(&mut a);
        for (path, digest) in [
            (PATH, revision("substituted bytes")),
            ("_types/undeclared.md", revision(&existing)),
        ] {
            assert!(call(&mut a, client, "assess", choices(path, digest)).is_err());
        }
        if mode == "seed" {
            assert!(call(&mut a, client, "assess", choices(PATH, revision(&existing))).is_err());
        }
        assert_eq!(
            a.r.store.resource(PATH).unwrap().as_deref(),
            Some(existing.as_str())
        );
        assert!(
            a.r.store
                .resource("mdbase.provisions.yaml")
                .unwrap()
                .is_none()
        );
        assert!(a.r.store.record(&B16([7; 16])).unwrap().is_none());
    }
}
#[test]
fn producer_adoption_review_cannot_overwrite_a_later_definition_edit() {
    let (mut a, existing, _) = fixture("managed");
    let client = client(&mut a);
    let review = adopt(&mut a, client, &existing);
    let edited = format!("{existing}A later owner edit.\n");
    put(&mut a, &edited, Some(B32(revision(&existing).0)));
    assert!(call(&mut a, client, "apply", apply_fields(&review)).is_err());
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store.resource(PATH).unwrap().as_deref(),
        Some(edited.as_str())
    );
    assert!(
        a.r.store
            .resource("mdbase.provisions.yaml")
            .unwrap()
            .is_none()
    );
    assert!(a.r.store.record(&B16([7; 16])).unwrap().is_none());
}
