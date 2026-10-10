//! Explicit runtime family, not verified mediation/authority/provider activation.
use mdbn_wire::{
    Wire, attachment_runtime_v1 as r,
    cbor::{self, Cbor},
    entry, fixtures, intent, snapshot,
};

#[test]
fn all_existing_legacy_parent_bytes_and_annotations_are_identical() {
    let mut count = 0;
    for f in fixtures::all()
        .into_iter()
        .filter(|f| !f.name.starts_with("runtime-v1-"))
    {
        let (bytes, ann) = match f.format {
            "mutation" => {
                let v = r::Mutation::from(intent::Mutation::from_bytes(&f.bytes).unwrap());
                (v.to_bytes().unwrap(), v.annotate())
            }
            "entry" => {
                let v = r::EntryPayload::from(entry::EntryPayload::from_bytes(&f.bytes).unwrap());
                (v.to_bytes().unwrap(), v.annotate())
            }
            "manifest" => {
                let v = r::ManifestPayload::from(
                    snapshot::ManifestPayload::from_bytes(&f.bytes).unwrap(),
                );
                (v.to_bytes().unwrap(), v.annotate())
            }
            "chunk" => {
                // Legacy chunks deliberately store raw rows (including the
                // existing opaque-row fixture). Prove exact encoding without
                // pretending stricter runtime row validation accepts it.
                let old = snapshot::ChunkPayload::from_bytes(&f.bytes).unwrap();
                let v = r::ChunkPayload {
                    section: r::SectionKind::Legacy(old.section),
                    bucket: old.bucket,
                    rows: old.rows,
                };
                (v.to_bytes().unwrap(), v.annotate())
            }
            _ => continue,
        };
        assert_eq!(bytes, f.bytes, "{}/{}", f.format, f.name);
        assert_eq!(ann, f.ann, "{}/{} annotations", f.format, f.name);
        count += 1;
    }
    assert!(count >= 10, "all legacy root families exercised: {count}");
}
#[test]
fn normal_runtime_parents_roundtrip_without_default_decoder_activation() {
    let mut count = 0;
    for f in fixtures::all()
        .into_iter()
        .filter(|f| f.name.starts_with("runtime-v1-"))
    {
        cbor::validate(&f.bytes).unwrap();
        assert_eq!((f.roundtrip)(&f.bytes).unwrap(), f.bytes);
        match f.format {
            "mutation" => assert!(
                intent::Mutation::from_bytes(&f.bytes)
                    .unwrap_err()
                    .is_unknown()
            ),
            "entry" => assert!(
                entry::EntryPayload::from_bytes(&f.bytes)
                    .unwrap_err()
                    .is_unknown()
            ),
            "manifest" => assert!(
                snapshot::ManifestPayload::from_bytes(&f.bytes)
                    .unwrap_err()
                    .is_unknown()
            ),
            "chunk"
                if matches!(
                    f.name,
                    "runtime-v1-conflicts" | "runtime-v1-extended-conflicts"
                ) =>
            {
                let legacy = snapshot::ChunkPayload::from_bytes(&f.bytes).unwrap();
                assert!(
                    legacy
                        .rows_as::<snapshot::ConflictRow>()
                        .unwrap_err()
                        .is_unknown()
                );
            }
            "chunk" => assert!(
                snapshot::ChunkPayload::from_bytes(&f.bytes)
                    .unwrap_err()
                    .is_unknown()
            ),
            _ => panic!("unexpected runtime fixture"),
        }
        count += 1;
    }
    assert_eq!(count, 14);
}
#[test]
fn every_future_or_malformed_child_rejects_the_whole_normal_parent() {
    let mut count = 0;
    for f in fixtures::negative()
        .into_iter()
        .filter(|f| f.name.starts_with("runtime-v1-"))
    {
        cbor::validate(&f.bytes).expect("schema negatives are canonical CBOR");
        assert!((f.decode)(&f.bytes).is_err(), "{}/{}", f.format, f.name);
        count += 1;
    }
    assert_eq!(count, 19);
}
#[test]
fn runtime_mutation_preserves_every_95_header_field() {
    let f = fixtures::all()
        .into_iter()
        .find(|f| f.name == "runtime-v1-mixed" && f.format == "mutation")
        .unwrap();
    let v = r::Mutation::from_bytes(&f.bytes).unwrap();
    assert_eq!(v.base_seq, 41);
    assert_eq!(v.clock.tz, "Australia/Melbourne");
    assert!(v.on_behalf.is_some());
    assert!(v.conflict_mode.is_some());
    assert!(v.validated_at.is_some());
    assert!(v.room.is_some());
    assert!(matches!(
        &v.ops[..],
        [r::Op::Legacy(_), r::Op::FileAttach(_), r::Op::Legacy(_)]
    ));
    assert_eq!(v.to_bytes().unwrap(), f.bytes);
}
#[test]
fn current_entry_resurrection_position_survives_runtime_roundtrip() {
    let f = fixtures::all()
        .into_iter()
        .find(|f| f.format == "entry" && f.name == "runtime-v1-mixed")
        .unwrap();
    let entry = r::EntryPayload::from_bytes(&f.bytes).unwrap();
    assert_eq!(entry.resurrect, Some(41));
    assert_eq!(entry.to_bytes().unwrap(), f.bytes);
}

fn change_fmt(c: &mut Cbor) {
    let Cbor::Map(m) = c else {
        panic!("parent map")
    };
    let (_, v) = m.iter_mut().find(|(k, _)| *k == Cbor::Uint(0)).unwrap();
    *v = Cbor::Uint(2);
}
#[test]
fn future_parent_formats_remain_whole_unknown_errors() {
    for f in fixtures::all()
        .into_iter()
        .filter(|f| f.name.starts_with("runtime-v1-"))
    {
        if f.format == "mutation" {
            continue;
        }
        let mut c = cbor::decode(&f.bytes).unwrap();
        change_fmt(&mut c);
        let e = match f.format {
            "entry" => r::EntryPayload::from_cbor(&c).unwrap_err(),
            "manifest" => r::ManifestPayload::from_cbor(&c).unwrap_err(),
            "chunk" => r::ChunkPayload::from_cbor(&c).unwrap_err(),
            _ => panic!("fixture"),
        };
        assert!(e.is_unknown(), "{}/{}: {e}", f.format, f.name);
    }
}
