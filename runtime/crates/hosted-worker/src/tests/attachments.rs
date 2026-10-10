//! Metadata-only apply and the replica-owned read pin's security boundaries.
use super::*;
use mdbn_replica::Store;
use mdbn_replica::api::{SessionId, Target};
use mdbn_replica::attachments::{Need, PlainSink};
use mdbn_wire::attachment::{
    AttachmentContentV1, AttachmentRefV1, FileAttach, FileContent, PutAttachmentFile,
};
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::common::B64;
use mdbn_wire::envelope::Item;
use mdbn_wire::intent::{OpClock, Source};
use mdbn_wire::log_service::AppendParams;

pub(super) const FILE: B16 = B16([0x77; 16]);
pub(super) const PATH: &str = "files/large.bin";

fn attach(svc: &FakeLogService, tag: u8, size: u64) -> AttachmentContentV1 {
    let raw = vec![tag; 32]; // Opaque object; apply must not attempt to decrypt it.
    let address = mdbn_wire::hash::sha256(&raw);
    let content = AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: COL,
            key_epoch: 1,
            attachment_id: B32([tag; 32]),
            manifest_cipher_hash: address,
        },
        whole_plain_hash: B32([tag; 32]),
        total_plain_bytes: size,
    };
    let mut log = svc.client(OWNER_DEV);
    log.call(LogRequest::PutObject {
        collection: COL,
        address,
        kind: ItemKind::BlobPart,
        bytes: raw,
    })
    .unwrap();
    attach_content(svc, tag, content, vec![address])
}

pub(super) fn attach_content(
    svc: &FakeLogService,
    tag: u8,
    content: AttachmentContentV1,
    refs: Vec<B32>,
) -> AttachmentContentV1 {
    let mut log = svc.client(OWNER_DEV);
    let (head, prev) = svc.head(&COL);
    let payload = rt::EntryPayload {
        sem: Version { major: 1, minor: 0 },
        mutation: rt::Mutation {
            id: B16([tag; 16]),
            origin: OWNER_DEV,
            base_seq: head,
            clock: OpClock {
                instant: 1_700_000_000_000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([tag; 32]),
            source: Source::Api,
            ops: vec![rt::Op::FileAttach(FileAttach {
                id: FILE,
                path: PATH.into(),
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
            path: PATH.into(),
            content: content.clone(),
        })],
        conflicts: None,
        aliases: None,
        texts: None,
        resurrect: None,
    };
    let item = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(head + 1),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(OWNER_DEV),
        salt: Some(B16([0; 16])),
        idem: Some(B16([tag; 16])),
        refs: Some(refs),
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: Some(B64([0; 64])),
    };
    log.call(LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: head + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }))
    .unwrap();
    content
}

fn loaded() -> (FakeLogService, Hosted, u64, AttachmentContentV1) {
    let svc = world();
    let content = attach(&svc, 0x44, 600_000_000);
    let mut h = open(&svc);
    h.pump(false);
    assert!(h.e.serving());
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    assert!(s > 0);
    (svc, h, s, content)
}

#[test]
fn hosted_applies_large_attachment_descriptor_without_fetching_or_materializing_bytes() {
    let (svc, h, _, content) = loaded();
    let row = h.e.replica().store().file(&FILE).unwrap().unwrap();
    assert_eq!(row.content, FileContent::AttachmentV1(content));
    assert_eq!(row.local, mdbn_replica::store::FileLocal::Remote);
    assert_eq!(h.e.replica().attachment_fetch_status(&FILE), None);
    assert!(
        svc.object_gets(&COL).is_empty(),
        "metadata apply must issue no object fetch"
    );
    assert!(!h.e.replica().store().materializes_attachments());
}

#[test]
fn read_pin_uses_confirmed_descriptor_and_pins_revision_across_replacement() {
    let (svc, mut h, s, content) = loaded();
    let read =
        h.e.replica_mut()
            .hosted_attachment_read(
                SessionId(s),
                Target::Id(FILE),
                Some((7, 11)),
                Some(content.whole_plain_hash),
            )
            .unwrap();
    assert_eq!(read.view().size, 600_000_000);
    assert_eq!(
        read.need(),
        Some(Need::Manifest {
            address: content.reference.manifest_cipher_hash
        })
    );
    let newer = attach(&svc, 0x45, 50_000_000);
    assert!(h.e.bind_log(COL));
    h.pump(false);
    assert_eq!(
        h.e.replica().store().file(&FILE).unwrap().unwrap().content,
        FileContent::AttachmentV1(newer)
    );
    h.e.replica().hosted_attachment_read_check(&read).unwrap();
    assert_eq!(read.view().digest, content.whole_plain_hash);
    assert_eq!(
        read.need(),
        Some(Need::Manifest {
            address: content.reference.manifest_cipher_hash
        })
    );
    assert!(svc.object_gets(&COL).is_empty());
}

#[test]
fn revision_ranges_closed_sessions_and_cross_wake_pins_fail_closed() {
    let (svc, mut h, s, content) = loaded();
    for range in [
        Some((u64::MAX, 1)),
        Some((600_000_001, 0)),
        Some((599_999_999, 2)),
    ] {
        let e =
            h.e.replica_mut()
                .hosted_attachment_read(SessionId(s), Target::Id(FILE), range, None)
                .unwrap_err();
        assert_eq!(e.0.code, "invalid_request");
    }
    let e =
        h.e.replica_mut()
            .hosted_attachment_read(SessionId(s), Target::Id(FILE), None, Some(B32([1; 32])))
            .unwrap_err();
    assert_eq!(e.0.code, "conflict");
    let read =
        h.e.replica_mut()
            .hosted_attachment_read(
                SessionId(s),
                Target::Id(FILE),
                None,
                Some(content.whole_plain_hash),
            )
            .unwrap();
    let mut other = open_with_entropy(&svc, 19);
    other.pump(false);
    assert_eq!(
        other
            .e
            .replica()
            .hosted_attachment_read_check(&read)
            .unwrap_err()
            .0
            .code,
        "unavailable"
    );
    h.e.close(s);
    assert_eq!(
        h.e.replica()
            .hosted_attachment_read_check(&read)
            .unwrap_err()
            .0
            .code,
        "unauthenticated"
    );
}

#[test]
fn missing_read_capability_and_folder_scope_cannot_capture_a_pin() {
    let (svc, mut cp) = world_with_cp();
    attach(&svc, 0x44, 600_000_000);
    let mut h = open(&svc);
    h.pump(false);
    for (g, caps, folders, code) in [
        (B16([0x61; 16]), vec!["records.create"], None, "forbidden"),
        (
            B16([0x62; 16]),
            vec!["collection.read"],
            Some(vec!["private".into()]),
            "not_found",
        ),
    ] {
        cp.append(
            &svc,
            vec![mdbn_wire::policy::PolicyOp::Grant(
                mdbn_wire::policy::Grant {
                    grant: g,
                    installation: B16([0x56; 16]),
                    app_id: "app".into(),
                    account: TEST_OWNER,
                    capabilities: caps.into_iter().map(str::to_owned).collect(),
                    client_pk: B32(CLIENT_PK),
                    folder_scoped: folders.as_ref().map(|_| true),
                    file_folders: folders,
                },
            )],
        );
        assert!(h.e.bind_log(COL));
        h.pump(false);
        let (s, _) = h.e.hello(Some((g, CLIENT_PK)), &hello());
        assert!(s > 0);
        let e =
            h.e.replica_mut()
                .hosted_attachment_read(SessionId(s), Target::Id(FILE), None, None)
                .unwrap_err();
        assert_eq!(e.0.code, code);
    }
}

#[test]
fn corrupted_manifest_and_out_of_order_chunk_release_no_plaintext() {
    struct Never;
    impl PlainSink for Never {
        fn write(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
            panic!("unauthenticated bytes released")
        }
    }
    let (_, mut h, s, _) = loaded();
    let mut read =
        h.e.replica_mut()
            .hosted_attachment_read(SessionId(s), Target::Id(FILE), Some((0, 1)), None)
            .unwrap();
    assert_eq!(
        h.e.replica()
            .hosted_attachment_manifest(&mut read, b"not an authenticated manifest")
            .unwrap_err()
            .0
            .code,
        "unavailable"
    );
    assert_eq!(
        h.e.replica()
            .hosted_attachment_chunk(&mut read, 0, b"bad", &mut Never)
            .unwrap_err()
            .0
            .code,
        "invalid_request"
    );
    assert_eq!(
        h.e.replica()
            .hosted_attachment_finish(read)
            .unwrap_err()
            .0
            .code,
        "invalid_request"
    );
}
