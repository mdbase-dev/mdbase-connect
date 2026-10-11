//! Hosted Grant sessions through the wire open_upload producer: create, then
//! replace (FakeLog; not provider durability or the Worker host).
use super::*;
use crate::api::ClientApi;
use mdbn_wire::client::{OpenUploadParams, OpenUploadResult, UploadChunkParams};

fn editor_ready() -> (Hosted, FakeLogService) {
    let (svc, mut cp) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::Grant(
            mdbn_wire::policy::Grant {
                grant: G1,
                installation: B16([0x56; 16]),
                app_id: "app".into(),
                account: TEST_OWNER,
                capabilities: vec![
                    "collection.read".into(),
                    "records.create".into(),
                    "records.edit".into(),
                ],
                client_pk: mdbn_wire::common::B32([G1.0[0]; 32]),
                file_folders: None,
                folder_scoped: None,
            },
        )],
    );
    let mut h = crypto_open(&svc, MemStore::new());
    h.r.planner = Box::new(crate::plan::CorePlanner);
    h.pump();
    verified(&h);
    (h, svc)
}

fn upload(
    h: &mut Hosted,
    session: SessionId,
    p: &OpenUploadParams,
    bytes: &[u8],
) -> OpenUploadResult {
    let mut opened = None;
    for _ in 0..6 {
        match h.r.open_upload(session, p.clone()) {
            Ok(r) => {
                opened = Some(r);
                break;
            }
            Err(e) => {
                assert_eq!(e.problem().reason.as_deref(), Some("file_upload_pending"));
                h.pump();
            }
        }
    }
    let opened = opened.expect("open settled");
    h.r.upload_chunk(
        session,
        UploadChunkParams {
            transfer: p.transfer,
            index: 0,
            bytes: mdbn_wire::common::Bytes(bytes.to_vec()),
        },
    )
    .unwrap();
    for _ in 0..8 {
        h.pump();
        match h.r.commit_upload(session, p.transfer) {
            Ok(_) => break,
            Err(e) => assert_eq!(e.problem().reason.as_deref(), Some("file_upload_pending")),
        }
    }
    h.pump();
    h.r.abort_upload(session, p.transfer).unwrap();
    opened
}

#[test]
fn hosted_grant_creates_then_replaces_through_open_upload() {
    let (mut h, _svc) = editor_ready();
    let session = h.session(G1);
    let create = OpenUploadParams {
        transfer: B16([0xd1; 16]),
        path: "files/hosted.bin".into(),
        size: 3,
        digest: None,
        file_id: None,
        if_revision: None,
        mutation_id: Some(B16([0xd2; 16])),
    };
    let file = upload(&mut h, session, &create, b"old").file_id.unwrap();
    let before = h.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    assert_eq!(before.digest, mdbn_wire::hash::sha256(b"old"));

    let replace = OpenUploadParams {
        transfer: B16([0xd3; 16]),
        size: 5,
        file_id: Some(file),
        if_revision: Some(before.digest),
        mutation_id: Some(B16([0xd4; 16])),
        ..create
    };
    assert_eq!(
        upload(&mut h, session, &replace, b"fresh").file_id,
        Some(file)
    );
    let after = h.r.get_file(session, crate::api::Target::Id(file)).unwrap();
    assert_eq!(
        (after.path.as_str(), after.digest),
        ("files/hosted.bin", mdbn_wire::hash::sha256(b"fresh"))
    );
    let receipt = h.r.receipt(session, B16([0xd4; 16])).unwrap();
    assert_eq!(receipt.state, mdbn_wire::client::ReceiptState::Confirmed);
}
