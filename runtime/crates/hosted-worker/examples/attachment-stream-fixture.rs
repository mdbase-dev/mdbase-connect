//! Deterministic, synthetic signed fixture for actual hosted WASM streaming.
//! Writes canonical wire metadata and separate bounded ciphertext objects only.
use mdbn_replica::crypto::chunked_blob::AttachmentLimits;
use mdbn_replica::{
    attachments::AttachmentWriter,
    crypto::{TestEntropy, hpke::KemKeyPair, keys::Recipient, sign::DeviceSigner},
    fake::FakeLogService,
    log::{LogClient, LogRequest},
    seal::{KeyEvent, KeyringSealer, Sealer},
    testkit::{TEST_OWNER, TestControlPlane, signed_root},
};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileAttach, PutAttachmentFile},
    attachment_runtime_v1 as rt,
    cbor::{self, Cbor},
    common::{B16, B32, Bytes, Version},
    envelope::{Item, ItemKind, RekeyReason},
    intent::{OpClock, Source},
    log_service::AppendParams,
    policy::{
        CState, DeviceEnrol, DeviceKind, Genesis, Grant, GrantApprovalPayload, MemberSet, PolicyOp,
        Role,
    },
    schema::Wire,
};
use std::{fs, path::PathBuf};
const COL: B16 = B16([13; 16]);
const HOST: B16 = B16([102; 16]);
const OWNER: B16 = B16([101; 16]);
const ESCROW: B16 = B16([103; 16]);
const FILE: B16 = B16([119; 16]);
const GRANT: B16 = B16([81; 16]);
fn enrol(id: B16, kind: DeviceKind, sign: u8, kem: u8) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device: id,
        account: if kind == DeviceKind::Desktop {
            TEST_OWNER
        } else {
            mdbn_replica::policy::SERVICE_ACCOUNT
        },
        kind,
        sign_pk: B32(DeviceSigner::from_seed(&[sign; 32]).public()),
        kem_pk: B32(KemKeyPair::from_secret(&[kem; 32]).pk),
        // Actual X25519 identity, not arbitrary policy bytes. The deterministic
        // synthetic secret is id.0[0] repeated; never production material.
        noise_pk: B32(KemKeyPair::from_secret(&[id.0[0]; 32]).pk),
        sas_commit: None,
        local_root: None,
    })
}
fn item(
    svc: &FakeLogService,
    kind: ItemKind,
    signer: B16,
    body: Vec<u8>,
    epoch: Option<u64>,
    refs: Option<Vec<B32>>,
) -> Item {
    let (head, chain) = svc.head(&COL);
    Item {
        kind,
        collection: COL,
        seq: Some(head + 1),
        prev: Some(chain),
        epoch,
        signer: Some(signer),
        salt: None,
        idem: None,
        refs,
        stream: None,
        body: Bytes(body),
        sig: None,
    }
}
fn append(svc: &FakeLogService, i: &Item) {
    let (head, chain) = svc.head(&COL);
    svc.client(i.signer.unwrap())
        .call(LogRequest::Append(AppendParams {
            collection: COL,
            expect_seq: head + 1,
            expect_prev: chain,
            items: vec![Bytes(i.to_bytes().unwrap())],
        }))
        .unwrap();
}
// Standalone fixture writer only; never linked into the engine/Worker.
// Its explicitly requested new directory holds deterministic test material.
#[allow(clippy::disallowed_methods)]
fn main() {
    let dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("owned new output directory"),
    );
    assert!(!dir.exists());
    fs::create_dir(&dir).unwrap();
    let size = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "16778450".into())
        .parse::<u64>()
        .unwrap();
    assert!(size <= 1 << 30);
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.append(
        &svc,
        vec![
            PolicyOp::Genesis(Genesis {
                owner: TEST_OWNER,
                root: mdbn_replica::policy::key_id(&signed_root()),
                state: CState::CloudCopy,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Owner,
            }),
            enrol(HOST, DeviceKind::Hosted, 7, 8),
            enrol(ESCROW, DeviceKind::Escrow, 11, 12),
            enrol(OWNER, DeviceKind::Desktop, 9, 10),
        ],
    );
    let mut entropy = TestEntropy::new(71);
    let mut hosted = KeyringSealer::new(COL, HOST, &[7; 32], &[8; 32]);
    let recipients = [(HOST, 8), (ESCROW, 12), (OWNER, 10)].map(|(device, kem)| Recipient {
        device,
        kem_pk: KemKeyPair::from_secret(&[kem; 32]).pk,
    });
    let rekey = hosted
        .build_rekey(0, &recipients, RekeyReason::Initial, &mut entropy)
        .unwrap();
    assert!(matches!(
        hosted.accept_rekey(&rekey),
        KeyEvent::Keyed { .. }
    ));
    hosted.set_epoch(1);
    let mut i = item(
        &svc,
        ItemKind::Rekey,
        HOST,
        rekey.to_bytes().unwrap(),
        None,
        None,
    );
    hosted.sign(&mut i).unwrap();
    append(&svc, &i);
    let mut owner = KeyringSealer::new(COL, OWNER, &[9; 32], &[10; 32]);
    assert!(matches!(owner.accept_rekey(&rekey), KeyEvent::Keyed { .. }));
    owner.set_epoch(1);
    cp.append(
        &svc,
        vec![PolicyOp::Grant(Grant {
            grant: GRANT,
            installation: B16([86; 16]),
            app_id: "fixture".into(),
            account: TEST_OWNER,
            capabilities: vec!["collection.read".into()],
            client_pk: B32(KemKeyPair::from_secret(&[81; 32]).pk),
            file_folders: None,
            folder_scoped: None,
        })],
    );
    let approval = GrantApprovalPayload {
        grant: GRANT,
        client_pk: B32(KemKeyPair::from_secret(&[81; 32]).pk),
        capabilities: vec!["collection.read".into()],
        file_folders: None,
    };
    let mut i = item(
        &svc,
        ItemKind::GrantApproval,
        OWNER,
        approval.to_bytes().unwrap(),
        Some(1),
        None,
    );
    owner
        .seal(&mut i, &approval.to_bytes().unwrap(), false, &mut entropy)
        .unwrap();
    append(&svc, &i);
    let mut writer = AttachmentWriter::new(
        &hosted,
        COL,
        size,
        AttachmentLimits::default(),
        &mut entropy,
    )
    .unwrap();
    let mut descriptors = Vec::new();
    let mut offset = 0;
    loop {
        let n = writer.next_chunk_len() as usize;
        let bytes = (offset..offset + n as u64)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>();
        let object = writer.push_chunk(&hosted, &bytes, &mut entropy).unwrap();
        let name = format!("{}.bin", descriptors.len());
        fs::write(dir.join(&name), &object.bytes).unwrap();
        descriptors.push(Cbor::Array(vec![
            object.cipher_hash.to_cbor(),
            Cbor::Uint(object.bytes.len() as u64),
            Cbor::Text(name),
        ]));
        svc.client(OWNER)
            .call(LogRequest::PutObject {
                collection: COL,
                address: object.cipher_hash,
                kind: ItemKind::BlobPart,
                bytes: object.bytes,
            })
            .unwrap();
        offset += n as u64;
        if offset == size {
            break;
        }
    }
    let written = writer.finish(&hosted, &mut entropy).unwrap();
    let object = written.manifest;
    let name = "manifest.bin";
    fs::write(dir.join(name), &object.bytes).unwrap();
    descriptors.push(Cbor::Array(vec![
        object.cipher_hash.to_cbor(),
        Cbor::Uint(object.bytes.len() as u64),
        Cbor::Text(name.into()),
    ]));
    svc.client(OWNER)
        .call(LogRequest::PutObject {
            collection: COL,
            address: object.cipher_hash,
            kind: ItemKind::BlobPart,
            bytes: object.bytes,
        })
        .unwrap();
    let content = AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: COL,
            key_epoch: 1,
            attachment_id: written.descriptor.context.attachment_id,
            manifest_cipher_hash: written.descriptor.manifest_cipher_hash,
        },
        whole_plain_hash: written.expected.whole_plain_hash,
        total_plain_bytes: size,
    };
    let (head, _) = svc.head(&COL);
    let payload = rt::EntryPayload {
        sem: Version { major: 1, minor: 0 },
        mutation: rt::Mutation {
            id: B16([113; 16]),
            origin: OWNER,
            base_seq: head,
            clock: OpClock {
                instant: 1700000000000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([113; 32]),
            source: Source::Api,
            ops: vec![rt::Op::FileAttach(FileAttach {
                id: FILE,
                path: "files/large.bin".into(),
                content: content.clone(),
                if_revision: None,
                base: None,
            })],
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        },
        status: mdbn_wire::entry::Status::Applied,
        effects: vec![rt::Effect::PutAttachmentFile(PutAttachmentFile {
            id: FILE,
            path: "files/large.bin".into(),
            content,
        })],
        conflicts: None,
        aliases: None,
        texts: None,
        resurrect: None,
    };
    let mut refs = written.refs;
    refs.sort();
    let mut i = item(
        &svc,
        ItemKind::Entry,
        OWNER,
        Vec::new(),
        Some(1),
        Some(refs),
    );
    i.idem = Some(B16([113; 16]));
    owner
        .seal(&mut i, &payload.to_bytes().unwrap(), false, &mut entropy)
        .unwrap();
    append(&svc, &i);
    let original = svc.items(&COL).remove(0);
    let genesis_policy =
        mdbn_wire::policy::PolicyPayload::from_bytes(&Item::from_bytes(&original).unwrap().body.0)
            .unwrap();
    let pins = Cbor::Array(vec![
        Cbor::Array(vec![Cbor::Array(vec![
            mdbn_replica::policy::key_id(&signed_root()).to_cbor(),
            B32(signed_root()).to_cbor(),
        ])]),
        Cbor::Array(vec![Cbor::Array(vec![
            genesis_policy.cert.key_id().to_cbor(),
            genesis_policy.cert.policy_pk.to_cbor(),
            genesis_policy.cert.root.to_cbor(),
        ])]),
    ]);
    let config = Cbor::Map(vec![
        (Cbor::Uint(0), COL.to_cbor()),
        (Cbor::Uint(1), B16([2; 16]).to_cbor()),
        (Cbor::Uint(2), HOST.to_cbor()),
        (
            Cbor::Uint(3),
            Cbor::Array(vec![Cbor::Bytes(signed_root().to_vec())]),
        ),
        (
            Cbor::Uint(4),
            Cbor::Array(vec![OWNER.to_cbor(), HOST.to_cbor(), ESCROW.to_cbor()]),
        ),
        (Cbor::Uint(5), Cbor::Bytes(vec![7; 32])),
        (Cbor::Uint(6), Cbor::Bytes(vec![8; 32])),
        (Cbor::Uint(8), Cbor::Bytes(cbor::encode(&pins).unwrap())),
        (Cbor::Uint(9), Cbor::Bytes(original.clone())),
        (Cbor::Uint(10), mdbn_wire::hash::sha256(&original).to_cbor()),
    ]);
    let plan = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(cbor::encode(&config).unwrap())),
        (
            Cbor::Uint(1),
            Cbor::Array(svc.items(&COL).into_iter().map(Cbor::Bytes).collect()),
        ),
        (Cbor::Uint(2), written.expected.whole_plain_hash.to_cbor()),
        (Cbor::Uint(3), FILE.to_cbor()),
        (Cbor::Uint(4), GRANT.to_cbor()),
        (
            Cbor::Uint(5),
            B32(KemKeyPair::from_secret(&[81; 32]).pk).to_cbor(),
        ),
        (Cbor::Uint(6), Cbor::Uint(size)),
        (Cbor::Uint(7), Cbor::Array(descriptors)),
        (Cbor::Uint(8), svc.head(&COL).1.to_cbor()),
    ]);
    fs::write(dir.join("fixture.cbor"), cbor::encode(&plan).unwrap()).unwrap();
    println!("synthetic signed attachment fixture: {size} bytes");
}
