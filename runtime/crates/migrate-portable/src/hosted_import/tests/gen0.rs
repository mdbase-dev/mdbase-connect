//! Ordered, paged traversal and completed-read planning regressions.

use super::*;
use crate::preflight::EntityKind;
use mdbn_wire::common::B32;

fn key(n: u64, kind: EntityKind) -> Key {
    Key {
        kind,
        id: format!("00000000-0000-0000-0000-{n:012x}"),
    }
}
fn meta(class: Class, size: u64) -> Meta {
    Meta {
        class,
        path: "x.md".into(),
        content: B32([1; 32]),
        size,
    }
}

#[test]
fn buckets_hash_raw_uuid_bytes_and_pages_cover_every_placement_once() {
    let mut spill = super::both::Both::new();
    let mut expected = BTreeMap::new();
    let resource = Key {
        kind: EntityKind::Resource,
        id: "mdbase.yaml".into(),
    };
    expected.insert(resource.clone(), meta(Class::Resource, 3));
    for n in 0..80 {
        let k = key(
            n,
            if n < 40 {
                EntityKind::Record
            } else {
                EntityKind::File
            },
        );
        let hash = mdbn_wire::hash::sha256(&crate::ids::uuid(&k.id).unwrap().0);
        assert_eq!(
            bucket16(&k).unwrap(),
            u16::from_be_bytes([hash.0[0], hash.0[1]])
        );
        expected.insert(
            k,
            meta(
                if n < 40 {
                    Class::Record
                } else {
                    Class::Attachment
                },
                n,
            ),
        );
    }
    for (k, m) in &expected {
        spill.put_placement(Generation::S0, k, m).unwrap();
    }
    for bits in [0, 1, 4, 8] {
        let mut seen = BTreeMap::new();
        for bucket in std::iter::once(None).chain((0..(1 << bits)).map(Some)) {
            let mut after = None;
            loop {
                let page = spill
                    .placements_in_bucket(Generation::S0, bits, bucket, after.as_ref(), 3)
                    .unwrap();
                assert!(page.len() <= 3);
                assert!(page.windows(2).all(|w| w[0].0 < w[1].0));
                for (k, m) in &page {
                    assert!(seen.insert(k.clone(), m.clone()).is_none());
                    if let Some(b) = bucket {
                        assert_ne!(k.kind, EntityKind::Resource);
                        assert_eq!(u64::from(bucket16(k).unwrap()) >> (16 - bits), b);
                    } else {
                        assert_eq!(k, &resource);
                    }
                }
                let Some((last, _)) = page.last() else { break };
                after = Some(last.clone());
            }
        }
        assert_eq!(seen, expected);
    }
    assert!(
        spill
            .placements_in_bucket(Generation::S0, 17, None, None, 1)
            .is_err()
    );
    assert!(
        spill
            .placements_in_bucket(Generation::S0, 4, Some(16), None, 1)
            .is_err()
    );
    assert!(
        spill
            .placements_in_bucket(Generation::S0, 0, Some(0), None, 1001)
            .is_err()
    );
    assert!(
        spill
            .placements_in_bucket(Generation::S0, 0, Some(0), None, 0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(bucket_range(0, 0).unwrap(), (0, u16::MAX));
    assert_eq!(bucket_range(16, 65535).unwrap(), (65535, 65535));
}

#[test]
fn stats_count_resolved_rows_and_exclude_oversized_text_from_doc_bytes() {
    let mut stats = ImportStats::default();
    for (class, size) in [
        (Class::Resource, 2),
        (Class::Record, 512 << 10),
        (Class::Attachment, 7),
        (Class::UnindexedMarkdown, 2 << 20),
    ] {
        stats.add(&meta(class, size)).unwrap();
    }
    assert_eq!(
        stats,
        ImportStats {
            resources: 1,
            records: 1,
            attachments: 1,
            unindexed: 1,
            doc_bytes: 512 << 10,
            file_object_refs_upper_bound: 5
        }
    );
    assert_eq!(stats.bucket_bits(), 0);
    stats.add(&meta(Class::Record, 1)).unwrap();
    assert_eq!(stats.bucket_bits(), 1);
    assert_eq!(
        ImportStats {
            attachments: 501,
            ..ImportStats::default()
        }
        .bucket_bits(),
        1
    );
    assert_eq!(
        ImportStats {
            doc_bytes: u64::MAX,
            ..ImportStats::default()
        }
        .bucket_bits(),
        16
    );
    let mut overflow = ImportStats {
        doc_bytes: u64::MAX,
        ..ImportStats::default()
    };
    let before = overflow;
    assert!(overflow.add(&meta(Class::Record, 1)).is_err());
    assert_eq!(overflow, before);
}

#[test]
fn hosted_fmt1_preflight_counts_complete_generated_refs_and_refuses_uncertainty() {
    // Empty bucket sections and all five finish chunks are included.
    assert_eq!(ImportStats::default().hosted_fmt1_preflight().unwrap(), 11);
    assert!(
        ImportStats {
            attachments: 1,
            ..ImportStats::default()
        }
        .hosted_fmt1_preflight()
        .is_err(),
        "missing file refs inventory cannot admit an import"
    );
    let direct = ImportStats {
        resources: 2038,
        ..ImportStats::default()
    };
    assert_eq!(direct.hosted_fmt1_preflight().unwrap(), 2048);
    let over = ImportStats {
        resources: 2039,
        ..direct
    };
    assert!(
        over.hosted_fmt1_preflight()
            .unwrap_err()
            .to_string()
            .contains("hosted_ref_index_import_unqualified")
    );
    let mut file = ImportStats::default();
    file.add(&meta(Class::Attachment, (2048 * 8) << 20))
        .unwrap();
    assert!(
        file.hosted_fmt1_preflight().is_err(),
        "one attachment may require thousands of refs"
    );
    let mut empty_file = ImportStats::default();
    empty_file.add(&meta(Class::Attachment, 0)).unwrap();
    assert_eq!(empty_file.file_object_refs_upper_bound, 2);
    assert_eq!(empty_file.hosted_fmt1_preflight().unwrap(), 15);
    assert!(
        ImportStats {
            records: u64::MAX,
            ..ImportStats::default()
        }
        .hosted_fmt1_preflight()
        .is_err()
    );
    let mut stats = ImportStats {
        file_object_refs_upper_bound: u64::MAX,
        ..ImportStats::default()
    };
    let old = stats;
    assert!(stats.add(&meta(Class::UnindexedMarkdown, 1)).is_err());
    assert_eq!(
        stats, old,
        "overflow must not partially change planning state"
    );
}

#[test]
fn preflight_counts_declared_empty_file_sections_without_any_file_rows() {
    let stats = ImportStats {
        records: 129,
        doc_bytes: 129 << 20,
        ..ImportStats::default()
    };
    assert_eq!(stats.bucket_bits(), 9);
    // Counting only the three non-file sections would accept this plan. Native
    // with_attachments/with_unindexed=true also emits empty chunks in each bucket.
    assert!(2 * stats.records + (1 << stats.bucket_bits()) * 3 + 6 <= 2048);
    let err = stats.hosted_fmt1_preflight().unwrap_err().to_string();
    assert!(err.contains("hosted_ref_index_import_unqualified"));
    assert!(
        err.contains("2824"),
        "all five sections must be reserved: {err}"
    );
}

#[test]
fn driver_refuses_unqualified_ref_inventory_before_any_gen0_effect_and_unfences() {
    let mut world = World::new(123, Faults::default());
    world.legacy.ents.insert(
        key(9999, EntityKind::File),
        super::world::LEnt {
            table: Table::Files,
            path: "big-attachment.bin".into(),
            content: B32([8; 32]),
            size: (2048 * 8) << 20,
        },
    );
    let mut spill = super::both::Both::new();
    let mut driver = Driver::resume_mode(&mut spill, COLLECTION, true).unwrap();
    for _ in 0..1000 {
        let a = driver.poll(&mut spill).unwrap();
        assert!(
            !matches!(
                a,
                Action::ImportGen0 { .. } | Action::FinishGen0 | Action::AppendBase { .. }
            ),
            "preflight must precede writer/upload/base effects"
        );
        if let Action::Done(step) = a {
            assert_eq!(step, Step::RolledBack);
            assert!(
                driver
                    .checkpoint()
                    .failure
                    .as_deref()
                    .unwrap()
                    .contains("hosted_ref_index_import_unqualified")
            );
            assert_eq!(world.legacy.state, super::world::LState::Active);
            return;
        }
        if matches!(a, Action::Continue | Action::Wait(_)) {
            continue;
        }
        let Next::Outcome(o) = world.perform(&a, &mut spill) else {
            panic!("no faults")
        };
        driver.complete(&mut spill, o).unwrap();
    }
    panic!("refused import must settle its fence rollback");
}

#[test]
fn driver_resources_then_buckets_refuses_bad_progress_and_restarts_from_source() {
    let mut world = World::new(123, Faults::default());
    let mut spill = MemSpill::default();
    let mut driver = Driver::resume_mode(&mut spill, COLLECTION, true).unwrap();
    loop {
        let a = driver.poll(&mut spill).unwrap();
        if let Action::ImportGen0 {
            bits,
            bucket,
            after,
        } = a
        {
            assert_eq!(bucket, None);
            assert_eq!(after, None);
            let placements = spill.placements(Generation::S0).unwrap();
            let mut expected = ImportStats::default();
            for m in placements.values() {
                expected.add(m).unwrap();
            }
            assert_eq!(driver.import_stats(), Some(expected));
            assert_eq!(bits, expected.bucket_bits());
            break;
        }
        if matches!(a, Action::Continue | Action::Wait(_)) {
            continue;
        }
        let Next::Outcome(o) = world.perform(&a, &mut spill) else {
            panic!("no faults")
        };
        driver.complete(&mut spill, o).unwrap();
    }
    let original = driver.poll(&mut spill).unwrap();
    assert!(
        driver
            .complete(
                &mut spill,
                Outcome::Gen0Progress {
                    last: None,
                    done: false
                }
            )
            .is_err()
    );
    assert!(
        driver
            .complete(
                &mut spill,
                Outcome::Gen0Progress {
                    last: Some(key(999, EntityKind::Record)),
                    done: true
                }
            )
            .is_err()
    );
    assert_eq!(driver.poll(&mut spill).unwrap(), original);
    driver
        .complete(
            &mut spill,
            Outcome::Gen0Progress {
                last: None,
                done: true,
            },
        )
        .unwrap();
    assert!(matches!(
        driver.poll(&mut spill).unwrap(),
        Action::ImportGen0 {
            bucket: Some(0),
            after: None,
            ..
        }
    ));
    // RAM staging is deliberately not resumed: a new S0 read recreates counts,
    // writer, digest and objects; the acknowledged fence remains durable.
    driver = Driver::resume_mode(&mut spill, COLLECTION, true).unwrap();
    assert_eq!(driver.import_stats(), None);
    assert!(matches!(
        driver.poll(&mut spill).unwrap(),
        Action::OpenSource {
            generation: Generation::S0,
            expect_head: Some(_)
        }
    ));
}
