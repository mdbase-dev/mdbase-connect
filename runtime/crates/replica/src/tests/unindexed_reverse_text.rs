use super::{
    engine::Node,
    unindexed_async::{contents, node, payload, planned, retain},
};
use crate::{
    log::{LogPort, LogRequest, LogResponse},
    replica::apply::Outcome,
    store::{FileLocal, FileRow, Head, Store, Tx},
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    common::{B16, Hash, Text},
    entry::{TextBlob, TextDef, TextDefForm},
    intent::MediaClass,
    unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1, UnindexedMarkdownToRecord},
};
use std::collections::{BTreeMap, BTreeSet};
fn fixture(
    a: &mut Node,
    doc: &str,
    source: &[u8],
) -> (
    rt::EntryPayload,
    Vec<Hash>,
    BTreeMap<Hash, Vec<u8>>,
    FileRow,
) {
    let (prior, _) = contents(a, &vec![b'x'; 1048577], false);
    let f = FileRow {
        id: B16([52; 16]),
        path: "huge.md".into(),
        path_key: "huge.md".into(),
        content: prior.clone(),
        kind: FileKindV1::UnindexedOversizedMarkdown,
        media: MediaClass::Other,
        modified_seq: 1,
        bucket: 0,
        local: FileLocal::Remote,
    };
    a.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    let mut p = payload(prior.clone());
    p.mutation.ops = vec![rt::Op::UnindexedMarkdownToRecord(
        UnindexedMarkdownToRecord {
            id: f.id,
            path: f.path.clone(),
            doc: Text::Inline(doc.into()),
            prior: UnindexedMarkdownPayloadV1 { content: prior },
        },
    )];
    p = planned(a, p);
    let (blob, parts) =
        a.r.sealer
            .seal_bounded_record_source(source, &mut *a.r.host.entropy)
            .unwrap();
    let mut refs = parts.iter().map(|p| p.address).collect::<Vec<_>>();
    refs.sort();
    let objects = parts.into_iter().map(|p| (p.address, p.bytes)).collect();
    let rt::Op::UnindexedMarkdownToRecord(op) = &mut p.mutation.ops[0] else {
        panic!()
    };
    op.doc = Text::Index(0);
    for e in &mut p.effects {
        if let rt::Effect::ReindexUnindexedMarkdown(e) = e {
            e.doc = Text::Index(0)
        }
    }
    p.texts = Some(vec![TextDef::Form(TextDefForm::Blob(TextBlob { blob }))]);
    (p, refs, objects, f)
}
fn apply(a: &mut Node, h: Head, p: &rt::EntryPayload, refs: &[Hash]) -> Outcome {
    let writer = a.r.cfg.device_id;
    a.r.test_apply_authorized_unindexed_with_refs(
        h.seq,
        h,
        p.clone(),
        &mut BTreeSet::new(),
        writer,
        refs,
    )
    .unwrap()
}
fn supply(a: &mut Node, objects: &BTreeMap<Hash, Vec<u8>>, corrupt: bool) {
    for c in a.r.take_log_calls() {
        if let LogRequest::GetObject { address, .. } = c.request {
            let mut bytes = objects[&address].clone();
            if corrupt {
                *bytes.last_mut().unwrap() ^= 1;
            }
            a.r.on_log_reply(
                c.id,
                Ok(LogResponse::GetObject {
                    size: bytes.len() as u64,
                    checksum: mdbn_wire::hash::sha256(&bytes),
                    bytes,
                }),
            );
        }
    }
}
#[test]
fn complete_reverse_blob_hydration_precedes_atomic_holder_swap_exactly() {
    let mut a = node();
    let doc = "---\r\ntitle: exact\r\n---\r\n🪴\0é\r\n";
    let (p, refs, objects, f) = fixture(&mut a, doc, doc.as_bytes());
    let old = a.r.store.head().unwrap();
    let h = retain(&mut a);
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::SourcePending
    ));
    assert_eq!(a.r.store.head().unwrap(), old);
    assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f.clone()));
    assert!(a.r.store.record(&f.id).unwrap().is_none());
    supply(&mut a, &objects, false);
    assert!(matches!(apply(&mut a, h, &p, &refs), Outcome::Applied));
    assert_eq!(a.r.store.head().unwrap(), h);
    assert!(a.r.store.file(&f.id).unwrap().is_none());
    let r = a.r.store.record(&f.id).unwrap().unwrap();
    assert_eq!(r.doc, doc);
    assert_eq!(r.path, f.path);
    assert!(a.r.store.tombstone(&f.id).unwrap().is_none());
}
#[test]
fn hydration_never_replaces_fresh_core_full_prior_cas() {
    let mut a = node();
    let (p, refs, objects, mut f) = fixture(&mut a, "doc", b"doc");
    let h = retain(&mut a);
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::SourcePending
    ));
    supply(&mut a, &objects, false);
    let mdbn_wire::attachment::FileContent::Blob(b) = &mut f.content else {
        panic!()
    };
    b.id_epoch += 1;
    b.blob_id.0[0] ^= 1;
    a.r.store
        .commit(Tx {
            files_put: vec![f.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::Void("V7: unindexed result or prior CAS mismatch")
    ));
    assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f));
    assert!(a.r.store.record(&B16([52; 16])).unwrap().is_none());
}
#[test]
fn fully_authenticated_invalid_utf8_rejects_but_corruption_waits_without_swap() {
    let mut a = node();
    let (p, refs, objects, f) = fixture(&mut a, "doc", &[0xff]);
    let h = retain(&mut a);
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::SourcePending
    ));
    supply(&mut a, &objects, false);
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::Void("unindexed_markdown_invalid_utf8")
    ));
    assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f));
    assert_eq!(a.r.store.head().unwrap(), h);
    let mut b = node();
    let (p, refs, objects, f) = fixture(&mut b, "doc", b"doc");
    let old = b.r.store.head().unwrap();
    let h = retain(&mut b);
    assert!(matches!(
        apply(&mut b, h, &p, &refs),
        Outcome::SourcePending
    ));
    supply(&mut b, &objects, true);
    assert!(matches!(
        apply(&mut b, h, &p, &refs),
        Outcome::SourcePending
    ));
    assert_eq!(b.r.store.head().unwrap(), old);
    assert_eq!(b.r.store.file(&f.id).unwrap(), Some(f));
    assert!(b.r.store.record(&B16([52; 16])).unwrap().is_none());
}
#[test]
fn missing_gc_refs_and_oversize_future_descriptor_refuse_before_fetch() {
    for mode in 0..3 {
        let mut a = node();
        let (mut p, refs, _, f) = fixture(&mut a, "doc", b"doc");
        let h = retain(&mut a);
        let mut refs = refs;
        if mode == 0 {
            refs.clear()
        } else {
            let TextDef::Form(TextDefForm::Blob(t)) = &mut p.texts.as_mut().unwrap()[0] else {
                panic!()
            };
            if mode == 1 {
                t.blob.size = 1048577
            } else {
                t.blob.id_epoch = a.r.policy.epoch + 1
            }
        }
        assert!(matches!(
            apply(&mut a, h, &p, &refs),
            Outcome::Void("V7: reverse text descriptor or refs")
        ));
        assert!(
            !a.r.take_log_calls()
                .iter()
                .any(|c| matches!(c.request, LogRequest::GetObject { .. }))
        );
        assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f));
    }
}
#[test]
fn late_old_generation_response_cannot_supply_new_actor_source() {
    let mut a = node();
    let (p, refs, objects, f) = fixture(&mut a, "doc", b"doc");
    let old = a.r.store.head().unwrap();
    let h = retain(&mut a);
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::SourcePending
    ));
    let call =
        a.r.take_log_calls()
            .into_iter()
            .find(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .unwrap();
    a.r.store_generation += 1;
    let LogRequest::GetObject { address, .. } = call.request else {
        panic!()
    };
    let bytes = objects[&address].clone();
    a.r.on_log_reply(
        call.id,
        Ok(LogResponse::GetObject {
            size: bytes.len() as u64,
            checksum: mdbn_wire::hash::sha256(&bytes),
            bytes,
        }),
    );
    assert!(matches!(
        apply(&mut a, h, &p, &refs),
        Outcome::SourcePending
    ));
    assert_eq!(a.r.store.head().unwrap(), old);
    assert_eq!(a.r.store.file(&f.id).unwrap(), Some(f));
}
