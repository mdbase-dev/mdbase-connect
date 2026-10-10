// Test-only original signed cut producer; no application/provider use.
use mdbn_log_service::{
    model::{ObjectMeta, SnapshotRow},
    restore_plan::{InventoryDigest, RestorePlan},
    testkit::{ControlPlane, Device, id16, key, object, sign_digest},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::B32,
    envelope::{Item, ItemKind},
    hash::{chain_hash, h, sha256},
    policy::DeviceKind,
    ref_index::ref_index_item,
    schema::Wire,
};
fn signing_inputs() -> (Cbor, Cbor) {
    let signing = key(b"offline/test-only/completion-signer");
    let context = sha256(b"offline/test-only/capture-context");
    let trust = map(vec![
        Cbor::Text("mdbase-native-backup-trust/1".into()),
        Cbor::Text("backup-completion".into()),
        Cbor::Text("offline-test".into()),
        id16("placeholder").to_cbor(),
        B32(signing.verifying_key().to_bytes()).to_cbor(),
        Cbor::Array(vec![B32([0x21; 32]).to_cbor()]),
        context.to_cbor(),
        B32([0x22; 32]).to_cbor(),
    ]);
    let completion = map(vec![
        Cbor::Text("mdbase-native-backup-completion/1".into()),
        Cbor::Text("backup-completion".into()),
        Cbor::Text("offline-test".into()),
        id16("placeholder").to_cbor(),
        B32([0; 32]).to_cbor(),
        Cbor::Uint(6),
        B32([0; 32]).to_cbor(),
        Cbor::Null,
        Cbor::Uint(0),
        Cbor::Uint(0),
        context.to_cbor(),
        B32([0; 32]).to_cbor(),
    ]);
    (trust, completion)
}
fn signed(mut value: Cbor) -> Cbor {
    let signature = sign_digest(
        &key(b"offline/test-only/completion-signer"),
        &h("mdbase/v1/native-backup-completion", &bytes(&value)),
    );
    let Cbor::Map(fields) = &mut value else {
        panic!("map")
    };
    fields.push((Cbor::Uint(12), signature.to_cbor()));
    value
}

pub(crate) struct Cut {
    pub(crate) trust: Vec<u8>,
    pub(crate) completion: Vec<u8>,
    pub(crate) header: Vec<u8>,
    pub(crate) finish: Vec<u8>,
    pub(crate) pages: Vec<Vec<u8>>,
    pub(crate) objects: Vec<(B32, Vec<u8>)>,
}
fn map(values: Vec<Cbor>) -> Cbor {
    Cbor::Map(
        values
            .into_iter()
            .enumerate()
            .map(|(key, value)| (Cbor::Uint(key as u64), value))
            .collect(),
    )
}
fn bytes(value: &Cbor) -> Vec<u8> {
    cbor::encode(value).unwrap()
}
fn field(value: &mut Cbor, key: usize, replacement: Cbor) {
    let Cbor::Map(fields) = value else {
        panic!("map")
    };
    fields[key].1 = replacement;
}
pub(crate) fn fixture(compacted: bool, indexed: bool, large: bool) -> Cut {
    source(compacted, indexed, large, false, false)
}
pub(crate) fn source(
    compacted: bool,
    indexed: bool,
    large: bool,
    different_publisher: bool,
    extra_roots: bool,
) -> Cut {
    shaped(
        compacted,
        indexed,
        large.then_some(ItemKind::BlobPart),
        different_publisher,
        extra_roots,
        2,
        0,
        0,
    )
}

/// High-overlap inventories share all retained roots across each snapshot.
#[allow(
    dead_code,
    reason = "Shared fixture helper is used by the resource suite"
)]
pub(crate) fn resource_fixture(
    snapshots: usize,
    members: usize,
    indices: usize,
    large: bool,
) -> Cut {
    shaped(
        false,
        true,
        large.then_some(ItemKind::BlobPart),
        true,
        true,
        snapshots,
        members,
        indices,
    )
}

#[allow(
    dead_code,
    reason = "Shared fixture helper is used by the resource suite"
)]
pub(crate) fn resource_manifest_fixture() -> Cut {
    shaped(false, false, Some(ItemKind::Manifest), true, true, 2, 0, 0)
}

#[allow(clippy::too_many_arguments, reason = "Test-only cut shape parameters")]
fn shaped(
    compacted: bool,
    indexed: bool,
    large_kind: Option<ItemKind>,
    different_publisher: bool,
    extra_roots: bool,
    snapshot_count: usize,
    member_count: usize,
    index_count: usize,
) -> Cut {
    let cp = ControlPlane::new("offline/test-only/full-cut");
    let c = id16("offline/test-only/full-cut/collection");
    let owner = id16("offline/test-only/full-cut/owner");
    let device = Device::new("offline/test-only/full-cut/device", owner);
    let genesis = cp.genesis(c, owner);
    let publisher = Device::new("offline/test-only/full-cut/publisher", owner);
    let pointer_author = if different_publisher {
        publisher.id
    } else {
        device.id
    };
    let enrol = cp.policy_item(
        c,
        2,
        chain_hash(&genesis),
        vec![
            device.enrol(DeviceKind::Desktop),
            publisher.enrol(DeviceKind::Desktop),
        ],
        2,
    );
    let rekey = device.rekey(c, 3, chain_hash(&enrol), 0, &[device.id]);
    let blob = object(
        c,
        ItemKind::BlobPart,
        1,
        vec![
            5;
            if large_kind == Some(ItemKind::BlobPart) {
                9 * 1024 * 1024 - 1024
            } else {
                64
            }
        ],
    );
    let blob_address = sha256(&blob);
    let chunk = object(c, ItemKind::Chunk, 1, vec![6; 64]);
    let chunk_address = sha256(&chunk);
    let orphan = object(c, ItemKind::Chunk, 1, vec![7; 64]);
    let orphan_address = sha256(&orphan);
    let mut objects = vec![
        (blob_address, blob),
        (chunk_address, chunk),
        (orphan_address, orphan),
    ];
    let mut direct = vec![blob_address, chunk_address];
    for number in 0..member_count {
        let raw = object(
            c,
            ItemKind::BlobPart,
            1,
            (number as u64).to_be_bytes().to_vec(),
        );
        let address = sha256(&raw);
        direct.push(address);
        objects.push((address, raw));
    }
    let mut expanded = direct.clone();
    if indexed && index_count != 0 {
        let mut members = direct.clone();
        members.sort();
        direct.clear();
        // Distinct overlapping index suffixes, each within the shared wire cap.
        for number in 0..index_count {
            let raw = ref_index_item(c, &members[number..])
                .unwrap()
                .to_bytes()
                .unwrap();
            let address = sha256(&raw);
            direct.push(address);
            objects.push((address, raw));
        }
    } else if indexed {
        let mut members = direct.clone();
        members.sort();
        let first = ref_index_item(c, &members).unwrap().to_bytes().unwrap();
        let first_address = sha256(&first);
        let second = ref_index_item(c, &[blob_address])
            .unwrap()
            .to_bytes()
            .unwrap();
        let second_address = sha256(&second);
        objects.extend([(first_address, first), (second_address, second)]);
        direct = vec![first_address, second_address];
    }
    direct.sort();
    let manifest = device.manifest(
        c,
        1,
        direct.clone(),
        vec![
            8;
            if large_kind == Some(ItemKind::Manifest) {
                9 * 1024 * 1024 - 1024
            } else {
                64
            }
        ],
    );
    let manifest_address = sha256(&manifest);
    objects.push((manifest_address, manifest));
    objects.sort_by_key(|(address, _)| *address);
    let head = if compacted {
        9
    } else {
        4.max(snapshot_count as u64)
    };
    let rf = if compacted { 9 } else { 1 };
    let mut signed_items = vec![(1, genesis.clone()), (2, enrol), (3, rekey)];
    for seq in if compacted { head..=head } else { 4..=head } {
        let entry = device.entry(
            c,
            seq,
            if compacted {
                B32([21; 32])
            } else {
                chain_hash(&signed_items.last().unwrap().1)
            },
            1,
            id16(&format!("offline/test-only/full-cut/idem/{seq}")),
            Some(vec![blob_address]),
            vec![9; 64],
        );
        signed_items.push((seq, entry));
    }
    let chain = chain_hash(&signed_items.last().unwrap().1);
    let mut item_digest = InventoryDigest::items();
    let mut object_digest = InventoryDigest::objects();
    let mut snapshot_digest = InventoryDigest::snapshots();
    let mut sections: Vec<Vec<Cbor>> = (0..6).map(|_| vec![]).collect();
    let mut used = 0;
    for (seq, raw) in &signed_items {
        let item = Item::from_bytes(raw).unwrap();
        item_digest.item(*seq, raw).unwrap();
        used += raw.len() as u64;
        sections[0].push(Cbor::Array(vec![
            Cbor::Uint(*seq),
            Cbor::Uint(item.kind.value()),
            Cbor::Bytes(raw.clone()),
            Cbor::int(*seq as i64 + 100),
        ]));
    }
    let mut roots = vec![manifest_address];
    roots.append(&mut expanded);
    roots.extend(&direct);
    if extra_roots {
        roots.push(orphan_address);
    }
    roots.sort();
    roots.dedup();
    let pointers: Vec<_> = if snapshot_count == 2 {
        vec![(3, 103, false), (head, 104, true)]
    } else {
        (1..=snapshot_count as u64)
            .map(|seq| (seq, 100 + seq as i64, seq == head))
            .collect()
    };
    // Pointers share roots; original times/endorsement feed existing digest.
    for &(seq, time, endorsed) in &pointers {
        sections[1].push(Cbor::Array(vec![
            Cbor::Uint(seq),
            manifest_address.to_cbor(),
            pointer_author.to_cbor(),
            Cbor::int(time),
            Cbor::Uint(endorsed as u64),
        ]));
    }
    let mut edge_id = 1;
    for (seq, raw) in &signed_items {
        for address in Item::from_bytes(raw).unwrap().refs.iter().flatten() {
            sections[2].push(Cbor::Array(vec![
                Cbor::Uint(edge_id),
                address.to_cbor(),
                Cbor::Uint(0),
                Cbor::Uint(*seq),
            ]));
            edge_id += 1;
        }
    }
    for &(seq, _, _) in &pointers {
        for address in &roots {
            sections[2].push(Cbor::Array(vec![
                Cbor::Uint(edge_id),
                address.to_cbor(),
                Cbor::Uint(1),
                Cbor::Uint(seq),
            ]));
            edge_id += 1;
        }
    }
    let mut object_bytes = 0;
    for (index, (address, raw)) in objects.iter().enumerate() {
        let item = Item::from_bytes(raw).unwrap();
        let kind = item.kind.value();
        let size = raw.len() as u64;
        used += size;
        object_bytes += size;
        let meta = ObjectMeta {
            address: *address,
            kind,
            size,
            checksum: sha256(raw),
            committed: true,
            created_at: 200 + index as i64,
        };
        object_digest.object(&meta).unwrap();
        sections[3].push(Cbor::Array(vec![
            Cbor::Uint(index as u64 + 1),
            address.to_cbor(),
            Cbor::Uint(kind),
            Cbor::Uint(size),
            meta.checksum.to_cbor(),
            Cbor::int(meta.created_at),
        ]));
    }
    for &(seq, time, endorsed) in pointers.iter().rev() {
        snapshot_digest
            .snapshot(
                &SnapshotRow {
                    seq,
                    manifest: manifest_address,
                    author: pointer_author,
                    created_at: time,
                    endorsed,
                    refs: vec![],
                },
                &roots,
            )
            .unwrap();
    }
    let mut tokens: Vec<_> = signed_items
        .iter()
        .filter_map(|(seq, raw)| {
            Item::from_bytes(raw)
                .unwrap()
                .idem
                .map(|token| (token, *seq, -5))
        })
        .collect();
    if compacted {
        tokens.push((id16("offline/test-only/full-cut/expired-compacted"), 4, -9));
    }
    tokens.sort();
    for (index, (token, seq, expires)) in tokens.iter().enumerate() {
        sections[4].push(Cbor::Array(vec![
            Cbor::Uint(index as u64 + 1),
            token.to_cbor(),
            Cbor::Uint(*seq),
            Cbor::int(*expires),
        ]));
    }
    sections[5].push(Cbor::Array(vec![
        Cbor::Uint(1),
        B32([19; 32]).to_cbor(),
        Cbor::int(120),
    ]));
    let plan = RestorePlan::parse(&Cbor::Array(vec![
        Cbor::Uint(1),
        Cbor::Uint(used),
        Cbor::Uint(head),
        chain.to_cbor(),
        Cbor::Uint(rf),
        item_digest.finish().to_cbor(),
        object_digest.finish().to_cbor(),
        snapshot_digest.finish().to_cbor(),
    ]))
    .unwrap();
    let session = id16("offline/test-only/full-cut/session");
    let revision = 12;
    let header = bytes(&map(vec![
        Cbor::Text("mdbase-next-backup/1".into()),
        c.to_cbor(),
        session.to_cbor(),
        Cbor::Uint(head),
        chain.to_cbor(),
        Cbor::Uint(rf),
        Cbor::Uint(revision),
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Array(vec![Cbor::Uint(1000); 4]),
            Cbor::Uint(30),
            Cbor::int(100),
        ]),
        Cbor::int(200),
        Cbor::Uint(used),
        Cbor::Text("rotate-url-secret-before-restored-traffic".into()),
    ]));
    let mut pages = vec![];
    let mut previous = sha256(&header);
    for (section, rows) in sections.iter().enumerate() {
        for batch in rows
            .chunks(if section == 0 { 32 } else { 100 })
            .map(|chunk| chunk.to_vec())
            .chain(std::iter::once(vec![]))
        {
            let done = batch.is_empty();
            let raw = bytes(&map(vec![
                Cbor::Uint(1),
                c.to_cbor(),
                session.to_cbor(),
                Cbor::Uint(revision),
                Cbor::Uint(pages.len() as u64 + 1),
                previous.to_cbor(),
                Cbor::Uint(section as u64 + 1),
                Cbor::Array(batch),
                Cbor::Bool(done),
                Cbor::Uint(head),
                chain.to_cbor(),
            ]));
            previous = sha256(&raw);
            pages.push(raw);
        }
    }
    let finish = bytes(&map(vec![
        Cbor::Uint(1),
        c.to_cbor(),
        session.to_cbor(),
        Cbor::Uint(head),
        chain.to_cbor(),
        Cbor::Uint(revision),
        Cbor::Uint(pages.len() as u64),
        previous.to_cbor(),
    ]));
    let (mut trust, mut completion) = signing_inputs();
    field(&mut trust, 3, c.to_cbor());
    field(&mut trust, 5, Cbor::Array(vec![cp.root_pk().to_cbor()]));
    field(&mut trust, 7, sha256(&genesis).to_cbor());
    for (key, value) in [
        (3, c.to_cbor()),
        (4, sha256(&header).to_cbor()),
        (5, Cbor::Uint(pages.len() as u64)),
        (6, previous.to_cbor()),
        (7, plan.to_cbor()),
        (8, Cbor::Uint(objects.len() as u64)),
        (9, Cbor::Uint(object_bytes)),
        (11, sha256(&finish).to_cbor()),
    ] {
        field(&mut completion, key, value);
    }
    Cut {
        trust: bytes(&trust),
        completion: bytes(&signed(completion)),
        header,
        finish,
        pages,
        objects,
    }
}
