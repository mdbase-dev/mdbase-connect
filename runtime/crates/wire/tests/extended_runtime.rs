//! Codec admission/compatibility only; no authority or provider activation.
use mdbn_wire::{Wire, attachment_runtime_v1 as r, entry, fixtures, intent, snapshot};

fn extended() -> r::EntryPayload {
    let f = fixtures::all()
        .into_iter()
        .find(|f| f.format == "entry" && f.name == "runtime-v1-extended")
        .unwrap();
    r::EntryPayload::from_bytes(&f.bytes).unwrap()
}
fn legacy() -> r::EntryPayload {
    let f = fixtures::all()
        .into_iter()
        .find(|f| f.format == "entry" && f.name == "applied-with-text-table")
        .unwrap();
    r::EntryPayload::from(entry::EntryPayload::from_bytes(&f.bytes).unwrap())
}
#[test]
fn every_extended_op_is_critical_to_legacy_even_without_attachment13() {
    let extended = extended();
    let mut count = 0;
    for op in extended.mutation.ops.into_iter().filter(|o| {
        matches!(
            o,
            r::Op::UnindexedMarkdownPut(_)
                | r::Op::RecordToUnindexedMarkdown(_)
                | r::Op::UnindexedMarkdownToRecord(_)
                | r::Op::OrdinaryFileToRecord(_)
        )
    }) {
        let mut m = legacy().mutation;
        m.ops.insert(0, op.clone());
        let bytes = m.to_bytes().unwrap();
        assert_eq!(r::Mutation::from_bytes(&bytes).unwrap(), m);
        assert!(
            intent::Mutation::from_bytes(&bytes)
                .unwrap_err()
                .is_unknown()
        );
        assert_eq!(
            r::Op::from_bytes(&op.to_bytes().unwrap())
                .unwrap()
                .annotate(),
            op.annotate()
        );
        count += 1;
    }
    assert_eq!(count, 4);
}
#[test]
fn every_extended_effect_is_critical_to_legacy_without_critical_ops() {
    let mut count = 0;
    for effect in extended().effects.into_iter().filter(|e| {
        matches!(
            e,
            r::Effect::PutUnindexedMarkdown(_)
                | r::Effect::ReindexUnindexedMarkdown(_)
                | r::Effect::ReindexOrdinaryFile(_)
        )
    }) {
        let mut e = legacy();
        e.effects.insert(0, effect.clone());
        let bytes = e.to_bytes().unwrap();
        assert_eq!(r::EntryPayload::from_bytes(&bytes).unwrap(), e);
        assert!(
            entry::EntryPayload::from_bytes(&bytes)
                .unwrap_err()
                .is_unknown()
        );
        assert_eq!(
            r::Effect::from_bytes(&effect.to_bytes().unwrap())
                .unwrap()
                .annotate(),
            effect.annotate()
        );
        count += 1;
    }
    assert_eq!(count, 3);
}
#[test]
fn conflict6_is_critical_in_base_kept_and_lost() {
    let c = extended().conflicts.unwrap().pop().unwrap();
    for side in 0..3 {
        let mut e = legacy();
        let mut old = c.clone();
        old.base = None;
        old.kept = r::ConflictValue::Legacy(entry::ConflictValue::Deleted);
        old.lost = r::ConflictValue::Legacy(entry::ConflictValue::Deleted);
        match side {
            0 => old.base = c.base.clone(),
            1 => old.kept = c.kept.clone(),
            _ => old.lost = c.kept.clone(),
        }
        e.conflicts = Some(vec![old]);
        let bytes = e.to_bytes().unwrap();
        assert_eq!(r::EntryPayload::from_bytes(&bytes).unwrap(), e);
        assert!(
            entry::EntryPayload::from_bytes(&bytes)
                .unwrap_err()
                .is_unknown()
        );
    }
}
#[test]
fn sections12_and13_are_explicit_and_row_typed() {
    for (name, kind) in [
        (
            "runtime-v1-unindexed-files",
            r::SectionKind::UnindexedMarkdownFiles,
        ),
        (
            "runtime-v1-unindexed-tombstones",
            r::SectionKind::UnindexedMarkdownTombstones,
        ),
    ] {
        let f = fixtures::all()
            .into_iter()
            .find(|f| f.format == "chunk" && f.name == name)
            .unwrap();
        let chunk = r::ChunkPayload::from_bytes(&f.bytes).unwrap();
        assert_eq!(chunk.section, kind);
        assert!(!chunk.rows.is_empty());
        assert!(
            snapshot::ChunkPayload::from_bytes(&f.bytes)
                .unwrap_err()
                .is_unknown()
        );
        assert_eq!(chunk.to_bytes().unwrap(), f.bytes);
    }
}
#[test]
fn future_negatives_are_unknown_not_malformed_current_variants() {
    for name in [
        "runtime-v1-unknown-op",
        "runtime-v1-unknown-effect",
        "runtime-v1-unknown-conflict",
        "runtime-v1-unknown-section",
    ] {
        let f = fixtures::negative()
            .into_iter()
            .find(|f| f.name == name)
            .unwrap();
        let e = match f.format {
            "mutation" => r::Mutation::from_bytes(&f.bytes).unwrap_err(),
            "entry" => r::EntryPayload::from_bytes(&f.bytes).unwrap_err(),
            "manifest" => r::ManifestPayload::from_bytes(&f.bytes).unwrap_err(),
            _ => unreachable!(),
        };
        assert!(e.is_unknown(), "{name}: {e}");
    }
}
#[test]
fn promotion_prior_retains_the_complete_blob_or_attachment_descriptor() {
    let mut count = 0;
    for f in fixtures::all()
        .into_iter()
        .filter(|f| f.format == "ordinary-file-promotion" && f.name.starts_with("op-"))
    {
        let r::Op::OrdinaryFileToRecord(op) = r::Op::from_bytes(&f.bytes).unwrap() else {
            panic!("promotion")
        };
        assert_eq!(
            op.doc,
            mdbn_wire::common::Text::Inline("views: []\n".into())
        );
        let whole = r::Op::OrdinaryFileToRecord(op);
        assert_eq!(whole.to_bytes().unwrap(), f.bytes);
        assert!(intent::Op::from_bytes(&f.bytes).unwrap_err().is_unknown());
        count += 1;
    }
    assert_eq!(count, 2);
}
