//! Local snapshot-row validation; no transport or cryptographic admission substitute.
use super::*;
use crate::store::RecordMeta;
use mdbn_wire::common::B16;
use mdbn_wire::intent::{BlobRef, MediaClass};
use mdbn_wire::unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1};

fn add_entity(index: &mut DigestIndex, kind: u8, id: B16, path: &str) -> Result<(), String> {
    let content = FileContent::Blob(BlobRef {
        plain_hash: B32([2; 32]),
        blob_id: B32([3; 32]),
        size: 2_000_000,
        id_epoch: 1,
        part_size: 8_388_608,
    });
    let path_key = mdbn_core::paths::path_key(path);
    match kind {
        0 => index.record(&RecordRow {
            id,
            path: path.into(),
            path_key,
            doc: "bytes\n".into(),
            revision: B32([2; 32]),
            modified_seq: 1,
            bucket: bucket16(&id),
            meta: RecordMeta::default(),
        }),
        1 | 2 => index.file(&FileRow {
            id,
            path: path.into(),
            path_key,
            content,
            kind: if kind == 1 {
                FileKindV1::Ordinary
            } else {
                FileKindV1::UnindexedOversizedMarkdown
            },
            media: MediaClass::Other,
            modified_seq: 1,
            bucket: bucket16(&id),
            local: FileLocal::Remote,
        }),
        _ => index.tombstone(&TombstoneRow {
            id,
            path: path.into(),
            path_key,
            kind: if kind == 3 {
                EntityKind::Record
            } else {
                EntityKind::File
            },
            last: match kind {
                3 => TombstoneLast::Doc("old bytes\n".into()),
                4 => {
                    let FileContent::Blob(b) = content else {
                        unreachable!()
                    };
                    TombstoneLast::Blob(b)
                }
                _ => TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 { content }),
            },
            seq: 1,
            time: 2,
        }),
    }
}

#[test]
fn snapshot_validation_entity_namespace_is_shared_in_both_orders() {
    for first in 0..6 {
        for second in 0..6 {
            let mut index = DigestIndex::default();
            add_entity(&mut index, first, B16([1; 16]), "first.md").unwrap();
            let before = index.digest();
            assert_eq!(
                add_entity(&mut index, second, B16([1; 16]), "second.md"),
                Err("two entries share an ID".into()),
                "{first} then {second}"
            );
            assert_eq!(index.digest(), before, "refusal must not replace prior row");
            add_entity(&mut index, second, B16([4; 16]), "second.md").unwrap();
        }
    }
}

fn entity_chunk(kind: u8, id: B16, path: &str) -> ChunkPayload {
    let blob = BlobRef {
        plain_hash: B32([2; 32]),
        blob_id: B32([3; 32]),
        size: 2_000_000,
        id_epoch: 1,
        part_size: 8_388_608,
    };
    let payload = UnindexedMarkdownPayloadV1 {
        content: FileContent::Blob(blob.clone()),
    };
    let (section, row) = match kind {
        0 => (
            SectionKind::Legacy(L::Records),
            WRecordRow {
                id,
                path: path.into(),
                doc: TextOrBlob::Text("bytes\n".into()),
            }
            .to_cbor(),
        ),
        1 => (
            SectionKind::Legacy(L::Files),
            WFileRow {
                id,
                path: path.into(),
                blob,
                media: MediaClass::Other,
            }
            .to_cbor(),
        ),
        2 => (
            SectionKind::UnindexedMarkdownFiles,
            mdbn_wire::unindexed_markdown::UnindexedMarkdownFileRowV1 {
                id,
                path: path.into(),
                payload,
                media: MediaClass::Other,
            }
            .to_cbor(),
        ),
        3 | 4 => (
            SectionKind::Legacy(L::Tombstones),
            WTombstoneRow {
                id,
                path: path.into(),
                kind: if kind == 3 {
                    EntityKind::Record
                } else {
                    EntityKind::File
                },
                last: if kind == 3 {
                    TextOrBlob::Text("old bytes\n".into())
                } else {
                    TextOrBlob::Blob(blob)
                },
                seq: 1,
                time: 2,
            }
            .to_cbor(),
        ),
        _ => (
            SectionKind::UnindexedMarkdownTombstones,
            mdbn_wire::unindexed_markdown::UnindexedMarkdownTombstoneRowV1 {
                id,
                path: path.into(),
                payload,
                seq: 1,
                time: 2,
            }
            .to_cbor(),
        ),
    };
    ChunkPayload {
        section,
        bucket: 0,
        rows: vec![row],
    }
}

fn deliver_chunk(r: &mut Replica<crate::mem::MemStore>, chunk: &ChunkPayload) {
    use super::upgrade_tests::{manifest, object, response};
    let plain = enc(&chunk.to_cbor());
    let bytes = object(ItemKind::Chunk, &chunk.to_cbor());
    let reference = ChunkRef {
        address: mdbn_wire::hash::sha256(&bytes),
        plain_hash: mdbn_wire::hash::sha256(&plain),
        rows: chunk.rows.len() as u64,
        plain_size: plain.len() as u64,
        bucket: 0,
    };
    r.install = Some(Install::Chunks {
        manifest: Box::new(manifest()),
        queue: vec![(chunk.section, reference)],
        next: 0,
    });
    r.test_on_native_snapshot_reply(response(bytes));
}

#[test]
fn snapshot_validation_cross_chunk_refusal_clears_staging_and_preserves_prior_state() {
    use super::upgrade_tests::{assert_prior, manifest, replica};
    // Exercise row admission at the already-verified manifest boundary, not a
    // signature/admission proof. Both orders span each live/native/tomb family.
    for first in 0..6 {
        for second in 0..6 {
            let mut r = replica();
            // Local row-validation model: both current-policy and manifest
            // epoch bounds are1. This is NOT authenticated policy/admission.
            r.policy.epoch = 1;
            r.install_epoch = 1;
            r.install_chunk(
                &manifest(),
                &entity_chunk(first, B16([1; 16]), "first.md"),
                true,
            )
            .unwrap();
            let expected_inventory = match first {
                0 => (2, 0, 0, 0),
                1 | 2 => (1, 1, 0, 0),
                _ => (1, 0, 1, 0),
            };
            assert_eq!(r.store.staged_inventory(), Some(expected_inventory));
            deliver_chunk(&mut r, &entity_chunk(second, B16([1; 16]), "second.md"));
            assert_prior(&r, IncidentKind::Integrity, true);
            assert_eq!(
                r.store.staged_inventory(),
                None,
                "all side tables discarded"
            );
            assert!(r.store.tombstone(&B16([1; 16])).unwrap().is_none());
            let reason = format!("{:?}", r.incidents.values().next().unwrap().details);
            assert!(
                reason.contains("two entries share an ID"),
                "{first}/{second}: {reason}"
            );
        }
    }
}

#[test]
fn snapshot_validation_alias_rejection_is_atomic_but_legacy_names_can_stage() {
    use super::upgrade_tests::{assert_prior, manifest, replica};
    for path in ["../old.md", "/old.md", "a//old.md"] {
        let mut r = replica();
        let chunk = ChunkPayload {
            section: SectionKind::Legacy(L::Aliases),
            bucket: 0,
            rows: vec![
                Alias {
                    path: path.into(),
                    record: B16([1; 16]),
                }
                .to_cbor(),
            ],
        };
        deliver_chunk(&mut r, &chunk);
        assert_prior(&r, IncidentKind::Integrity, true);
        let reason = format!("{:?}", r.incidents.values().next().unwrap().details);
        assert!(reason.contains("relative lookup key"));
    }
    for path in ["old/CON.md", "old/question?.md"] {
        let mut r = replica();
        let chunk = ChunkPayload {
            section: SectionKind::Legacy(L::Aliases),
            bucket: 0,
            rows: vec![
                Alias {
                    path: path.into(),
                    record: B16([1; 16]),
                }
                .to_cbor(),
            ],
        };
        r.install_chunk(&manifest(), &chunk, true).unwrap();
        assert_eq!(r.store.staged_inventory(), Some((1, 0, 0, 1)));
        assert!(r.store.aliases().unwrap().is_empty(), "not yet confirmed");
        assert_eq!(
            r.install_index.aliases[&mdbn_core::paths::path_key(path)].0,
            path
        );
        // Inspect the fake's staged alias by swapping in this isolated positive
        // row test; this does not qualify manifest/digest authentication.
        r.store
            .commit(Tx {
                stage: crate::store::Stage::Swap,
                ..Tx::default()
            })
            .unwrap();
        assert_eq!(
            r.store.aliases().unwrap(),
            vec![AliasRow {
                path: path.into(),
                path_key: mdbn_core::paths::path_key(path),
                record: B16([1; 16]),
            }]
        );
    }
}

#[test]
fn snapshot_validation_store_digest_propagates_namespace_corruption() {
    let mut store = crate::mem::MemStore::new();
    let id = B16([1; 16]);
    store
        .commit(Tx {
            records_put: vec![RecordRow {
                id,
                path: "live.md".into(),
                path_key: "live.md".into(),
                doc: "live\n".into(),
                revision: B32([2; 32]),
                modified_seq: 1,
                bucket: bucket16(&id),
                meta: RecordMeta::default(),
            }],
            tombstones_put: vec![TombstoneRow {
                id,
                kind: EntityKind::Record,
                path: "old.md".into(),
                path_key: "old.md".into(),
                last: TombstoneLast::Doc("old\n".into()),
                seq: 1,
                time: 2,
            }],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        matches!(state_digest(&store), Err(StoreError::Corrupt(reason)) if reason == "two entries share an ID")
    );
}

#[test]
fn snapshot_validation_aliases_are_lookup_keys_not_materialization_paths() {
    for path in [
        "old/CON.md",
        "old/question?.md",
        ".obsidian/old.md",
        "Notes/Café.md",
    ] {
        assert!(alias_path_ok(path), "{path}");
    }
    for path in [
        "",
        "/root.md",
        "../old.md",
        "a/./old.md",
        "a//old.md",
        "a\\old.md",
        "a\0old.md",
        "a\nold.md",
    ] {
        assert!(!alias_path_ok(path), "{path:?}");
    }
    assert!(alias_path_ok(&"x".repeat(4096)));
    assert!(!alias_path_ok(&"x".repeat(4097)));
}
