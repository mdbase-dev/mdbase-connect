use mdbn_wire::common::{B16, B32};
use mdbn_wire::intent::BlobRef;
use mdbn_wire::unindexed_markdown::FileKindV1;

use super::*;
use crate::mem::MemStore;
use crate::store::{FileLocal, FileRow, RecordMeta, RecordRow, Store, Tx};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

fn id(rng: &mut Rng) -> Uuid {
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&rng.next().to_be_bytes());
    b[8..].copy_from_slice(&rng.next().to_be_bytes());
    B16(b)
}

fn blob(rng: &mut Rng, size: u64) -> FileContent {
    FileContent::Blob(BlobRef {
        plain_hash: B32(mdbn_wire::hash::sha256(&rng.next().to_be_bytes()).0),
        size,
        blob_id: B32(mdbn_wire::hash::sha256(&rng.next().to_le_bytes()).0),
        id_epoch: 1,
        part_size: 8 << 20,
    })
}

/// The streamed digest equals the replica's own digest of the same confirmed
/// state, for random states with and without unindexed files and settings.
#[test]
fn streamed_state_digest_equals_the_store_digest() {
    for seed in 0..60u64 {
        let mut rng = Rng(seed);
        let mut store = MemStore::new();
        let mut tx = Tx::default();
        let mut resources: Vec<(String, String)> = (0..(rng.next() % 5))
            .map(|i| (format!("types/t{i}.md"), format!("type {i} {}", rng.next())))
            .collect();
        resources.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        tx.resources_put = resources.clone();
        let mut records: Vec<(Uuid, String, String)> = (0..(rng.next() % 300))
            .map(|i| {
                (
                    id(&mut rng),
                    format!("n/{i}.md"),
                    format!("# {i} {}", rng.next()),
                )
            })
            .collect();
        records.sort_by(|a, b| a.0.cmp(&b.0));
        for (rid, path, doc) in &records {
            tx.records_put.push(RecordRow {
                id: *rid,
                path: path.clone(),
                path_key: mdbn_core::paths::path_key(path),
                doc: doc.clone(),
                revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                modified_seq: 0,
                bucket: bucket16(rid),
                meta: RecordMeta::default(),
            });
        }
        let unindexed = seed % 2 == 0;
        let mut files: Vec<(Uuid, String, FileContent, bool)> = (0..(rng.next() % 40))
            .map(|i| {
                let u = unindexed && i % 3 == 0;
                let path = if u {
                    format!("big/{i}.md")
                } else {
                    format!("f/{i}.png")
                };
                (id(&mut rng), path, blob(&mut rng, 2 << 20), u)
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (fid, path, content, u) in &files {
            tx.files_put.push(FileRow {
                kind: if *u {
                    FileKindV1::UnindexedOversizedMarkdown
                } else {
                    FileKindV1::Ordinary
                },
                id: *fid,
                path: path.clone(),
                path_key: mdbn_core::paths::path_key(path),
                content: content.clone(),
                media: MediaClass::Other,
                modified_seq: 0,
                bucket: bucket16(fid),
                local: FileLocal::Remote,
            });
        }
        let settings = if seed % 3 == 0 {
            let mut s = crate::convert::winclusion(&Default::default());
            s.exclude.get_or_insert_with(Vec::new).push("tmp/**".into());
            tx.settings = Some(s.clone());
            s
        } else {
            crate::convert::winclusion(&Default::default())
        };
        store.commit(tx).unwrap();
        let want = super::super::snapshot::state_digest(&store).unwrap();

        let counts = DigestCounts {
            resources: resources.len() as u64,
            records: records.len() as u64,
            files: files.len() as u64,
            unindexed: files.iter().filter(|f| f.3).count() as u64,
        };
        let mut d = StateDigestStream::new(counts, &settings);
        for (p, t) in &resources {
            d.resource(p, t).unwrap();
        }
        for (rid, path, doc) in &records {
            d.record(*rid, path, mdbn_wire::hash::sha256(doc.as_bytes()))
                .unwrap();
        }
        for (fid, path, content, _) in &files {
            d.file(*fid, path, content).unwrap();
        }
        for (fid, path, content, _) in files.iter().filter(|f| f.3) {
            d.unindexed(*fid, path, content, MediaClass::Other).unwrap();
        }
        assert_eq!(d.finish().unwrap(), want, "seed {seed}");
    }
}

#[test]
fn streamed_digest_refuses_wrong_counts_and_order() {
    let settings = crate::convert::winclusion(&Default::default());
    let counts = DigestCounts {
        records: 2,
        ..DigestCounts::default()
    };
    let mut d = StateDigestStream::new(counts, &settings);
    d.record(B16([2; 16]), "b.md", B32([0; 32])).unwrap();
    assert!(
        d.record(B16([1; 16]), "a.md", B32([0; 32])).is_err(),
        "descending"
    );
    let d = StateDigestStream::new(counts, &settings);
    assert!(d.finish().is_err(), "rows missing");
    let mut d = StateDigestStream::new(DigestCounts::default(), &settings);
    assert!(
        d.record(B16([1; 16]), "a.md", B32([0; 32])).is_err(),
        "more than counted"
    );
    let mut d = StateDigestStream::new(counts, &settings);
    d.record(B16([1; 16]), "a.md", B32([0; 32])).unwrap();
    d.record(B16([2; 16]), "b.md", B32([0; 32])).unwrap();
    assert!(d.resource("x", "y").is_err(), "a row after its section");
}

#[test]
fn array_heads_are_canonical() {
    for n in [0u64, 1, 23, 24, 255, 256, 65_535, 65_536, 1 << 32] {
        let want = mdbn_wire::cbor::encode(&Cbor::Array(vec![Cbor::Null; n.min(70_000) as usize]))
            .unwrap();
        if n <= 70_000 {
            assert_eq!(array_head(n), want[..array_head(n).len()].to_vec(), "{n}");
        }
    }
    assert_eq!(array_head(1 << 32)[0], 0x9b);
}

#[test]
fn bucket_bits_follow_the_builder() {
    assert_eq!(bucket_bits(0), 0);
    assert_eq!(bucket_bits(TARGET_CHUNK), 0);
    assert_eq!(bucket_bits(TARGET_CHUNK + 1), 1);
    assert_eq!(bucket_bits(u64::MAX), 16);
}

#[test]
fn hosted_joint_budget_charges_sum_not_independent_limits() {
    assert_eq!(shared_budget(512 << 10, 512 << 10), Ok(()));
    assert_eq!(
        shared_budget(512 << 10, (512 << 10) + 1),
        Err(HostedGen0Error::Budget)
    );
    assert_eq!(shared_budget(usize::MAX, 1), Err(HostedGen0Error::Budget));
    let mut writer = Gen0Writer::new(B16([0x75; 16]), 0, false, false);
    writer.refs = Vec::with_capacity(10_000);
    let retained = retained_budget(&writer).unwrap();
    assert!(retained < HOSTED_RETAINED_BYTES);
    const { assert!(800_000 < HOSTED_OUTPUT_BYTES) };
    assert_eq!(
        shared_budget(retained, 800_000),
        Err(HostedGen0Error::Budget)
    );
    // The pre-effect reservation also refuses that retained/output combination.
    assert_eq!(
        output_preflight(&writer, 0, HOSTED_OUTPUT_OBJECTS, 0),
        Err(HostedGen0Error::Budget)
    );
}

#[test]
fn hosted_output_metadata_capacity_and_actual_sum_are_checked() {
    let mut writer = Gen0Writer::new(B16([0x76; 16]), 0, false, false);
    writer.refs = Vec::with_capacity(10_000);
    let object = Gen0Object {
        address: B32([0x77; 32]),
        kind: ItemKind::Chunk,
        bytes: Vec::with_capacity(800_000),
    };
    let output = vec![object];
    let output_bytes = output_budget(&output, HOSTED_OUTPUT_OBJECTS).unwrap();
    assert_eq!(
        shared_budget(retained_budget(&writer).unwrap(), output_bytes),
        Err(HostedGen0Error::Budget)
    );
    let metadata: Vec<Gen0Object> =
        Vec::with_capacity(HOSTED_OUTPUT_BYTES / std::mem::size_of::<Gen0Object>() + 1);
    assert_eq!(
        output_budget(&metadata, HOSTED_OUTPUT_OBJECTS),
        Err(HostedGen0Error::Budget)
    );
}
