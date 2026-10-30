//! Regression fixture: signed cloud-copy history, real attachment crypto and
//! disposable SQLite; synthetic CP/LS, NOT browser/OPFS or migration qualification.
use super::*;
use r::api::Target;
use r::log::{LogPort, LogPush};
use r::replica::{AttachmentSource, AttachmentUploadParams, AttachmentUploadStatus};
use w::policy::{CState, DeviceEnrol, DeviceKind, MemberSet, PolicyOp, Role};

const ESCROW: B16 = B16([102; 16]);
const MEMBER: B16 = B16([103; 16]);
const MEMBER_ACCOUNT: B16 = B16([104; 16]);
const ESCROW_SIGN: [u8; 32] = [0x41; 32];
const ESCROW_KEM: [u8; 32] = [0x42; 32];
const MEMBER_SIGN: [u8; 32] = [0x51; 32];
const MEMBER_KEM: [u8; 32] = [0x52; 32];

fn settle(app: &mut App, service: &FakeLogService, device: B16) {
    let (head, head_chain) = service.head(&COLLECTION);
    app.on_log_push(LogPush::Head {
        collection: COLLECTION,
        head,
        head_chain,
    });
    let mut client = service.client(device);
    for _ in 0..20 {
        r::log::pump(app, &mut client, 100);
        app.tick();
    }
    assert_eq!(app.store().pending_count().unwrap(), 0);
    assert!(!app.keyring_rebuilding() && !app.keyring_rebuild_failed());
}

fn enrol(device: B16, account: B16, kind: DeviceKind, sign: &[u8; 32], kem: &[u8; 32]) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device,
        account,
        kind,
        sign_pk: B32(r::crypto::sign::DeviceSigner::from_seed(sign).public()),
        kem_pk: B32(r::crypto::hpke::KemKeyPair::from_secret(kem).pk),
        noise_pk: B32([0x61; 32]),
        sas_commit: None,
        local_root: None,
    })
}
struct Source(Vec<u8>);
impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), String> {
        out.copy_from_slice(&self.0[offset as usize..offset as usize + out.len()]);
        Ok(())
    }
}
fn bytes(size: usize) -> Vec<u8> {
    (0..size).map(|n| (n % 251) as u8).collect()
}

fn read(
    app: &mut App,
    session: SessionId,
    device: B16,
    service: &FakeLogService,
    file: B16,
) -> Vec<u8> {
    let (_, view) = app
        .read_file(session, Target::Id(file), None, None)
        .unwrap();
    let mut output = Vec::new();
    let mut finished = false;
    for _ in 0..200 {
        settle(app, service, device);
        for (target, push) in app.take_pushes() {
            assert_eq!(target, session);
            match push {
                r::api::Push::FileChunk(chunk) => {
                    assert_eq!(chunk.offset, output.len() as u64);
                    output.extend_from_slice(&chunk.bytes.0);
                    let ack = app.ack_chunks(
                        session,
                        r::api::StreamId(chunk.stream),
                        output.len() as u64,
                    );
                    // The final native frame has already retired its read lane;
                    // mirror the SDK's harmless final ACK without hiding others.
                    if let Err(error) = ack {
                        assert!(
                            chunk.last && error.code() == Some(ErrorCode::NotFound),
                            "{error:?}"
                        );
                    }
                    finished = chunk.last;
                }
                r::api::Push::Closed(problem) => panic!("file stream closed: {problem:?}"),
                _ => {}
            }
        }
        if finished {
            break;
        }
    }
    assert!(finished, "file stream did not finish");
    assert_eq!(output.len() as u64, view.size);
    output
}

#[test]
fn signed_member_reads_sequential_cloud_copy_attachments_on_disposable_sqlite() {
    exercise(0);
}

#[test]
fn member_snapshot_read_does_not_fence_the_next_4096_byte_download() {
    exercise(2013);
}

// Synthetic confirmed Gen0-shaped records, not customer data or an archive
// verifier bypass. This isolates the app store's post-import read boundary.
fn seed_imported_records(path: &std::path::Path, count: usize) {
    let index = Rc::new(RefCell::new(AppSql {
        inner: SqliteIndex::open(path, IndexDurability::Disposable).unwrap(),
        probe: Rc::default(),
    }));
    let mut store = TentativeStore::open(index, SqlStoreLimits::MOBILE).unwrap();
    for start in (0..count).step_by(64) {
        let rows = (start..(start + 64).min(count))
            .map(|n| {
                // 30 large documents and 1,983 small: 8,419,560 document bytes,
                // within 619 bytes of #80's retained aggregate. The first 1,024
                // native-ID-ordered rows exceed the unchanged 4MiB ABI.
                let size = if n % 64 == 0 && n / 64 < 30 {
                    262_144
                } else {
                    280
                };
                let doc = "x".repeat(size);
                let path = format!("records/{n:05}.md");
                r::store::RecordRow {
                    id: B16((n as u128 + 1000).to_be_bytes()),
                    path: path.clone(),
                    path_key: path,
                    revision: w::hash::sha256(doc.as_bytes()),
                    doc,
                    modified_seq: 0,
                    bucket: ((n * 1931) % 65536) as u16,
                    meta: r::store::RecordMeta::default(),
                }
            })
            .collect();
        store
            .commit(r::store::Tx {
                records_put: rows,
                ..Default::default()
            })
            .unwrap();
    }
}

fn exercise(records: usize) {
    let root = scratch(&format!("shared-cloud-copy-files-{records}"));
    let service = FakeLogService::new();
    let mut cp = r::testkit::TestControlPlane::signed(COLLECTION);
    cp.genesis_with_keys(&service, CState::CloudCopy, DEVICE, &SIGN, &KEM);
    cp.append(
        &service,
        vec![enrol(
            ESCROW,
            r::policy::SERVICE_ACCOUNT,
            DeviceKind::Escrow,
            &ESCROW_SIGN,
            &ESCROW_KEM,
        )],
    );
    let (mut owner, owner_session, _) = open(&root.join("owner.db"), Rc::default());
    settle(&mut owner, &service, DEVICE);
    let (mut escrow, _, _) = open_device(
        &root.join("escrow.db"),
        Rc::default(),
        ESCROW,
        ESCROW_SIGN,
        ESCROW_KEM,
        true,
    );
    settle(&mut escrow, &service, ESCROW);
    let sizes = [54usize, 4096, 196608, 2621433];
    for (i, size) in sizes.iter().enumerate() {
        let id = B16([i as u8 + 120; 16]);
        let mutation = owner
            .start_attachment_upload(
                AttachmentUploadParams {
                    file: id,
                    path: format!("files/{i}.bin"),
                    if_revision: None,
                    mutation: None,
                },
                Box::new(Source(bytes(*size))),
            )
            .unwrap();
        settle(&mut owner, &service, DEVICE);
        assert!(matches!(
            owner.attachment_upload_status(&mutation),
            Some(AttachmentUploadStatus::Captured(_))
        ));
    }
    cp.append(
        &service,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: MEMBER_ACCOUNT,
                role: Role::Editor,
            }),
            enrol(
                MEMBER,
                MEMBER_ACCOUNT,
                DeviceKind::AppRuntime,
                &MEMBER_SIGN,
                &MEMBER_KEM,
            ),
        ],
    );
    settle(&mut owner, &service, DEVICE);
    settle(&mut escrow, &service, ESCROW);
    if records != 0 {
        seed_imported_records(&root.join("member.db"), records);
    }
    let (mut member, member_session, _) = open_device(
        &root.join("member.db"),
        Rc::default(),
        MEMBER,
        MEMBER_SIGN,
        MEMBER_KEM,
        true,
    );
    settle(&mut member, &service, MEMBER);
    // No SQL key material is installed by the test. Native rebuild consumes the
    // escrow's actual signed/encrypted grants, including pre-enrolment history.
    assert!(member.store().meta(meta_keys::KEYRING).unwrap().is_none());
    for (i, size) in sizes.iter().enumerate() {
        let id = B16([i as u8 + 120; 16]);
        assert_eq!(
            read(&mut owner, owner_session, DEVICE, &service, id),
            bytes(*size)
        );
        assert_eq!(
            read(&mut member, member_session, MEMBER, &service, id),
            bytes(*size)
        );
        assert!(member.store().fenced().is_none());
        if i == 0 && records != 0 {
            assert_eq!(member.store().record_count().unwrap(), records as u64);
            let mut after = None;
            let mut read_count = 0;
            loop {
                let page = member
                    .store()
                    .records(r::store::Page { after, limit: 64 })
                    .unwrap();
                if page.is_empty() {
                    break;
                }
                read_count += page.len();
                after = page.last().map(|row| row.id);
            }
            assert_eq!(read_count, records);
            // This is the real snapshot builder's all_records(Page1024), not
            // an injected SQL fault. Its failure is normally non-fatal to the
            // snapshot task, but a disposable app store must fence uncertainty.
            let snapshot = member.build_snapshot_now();
            let next = member.get_file(member_session, Target::Id(B16([121; 16])));
            assert!(
                next.is_ok(),
                "next 4096-byte file metadata read: {next:?}; snapshot: {snapshot:?}"
            );
            assert!(snapshot.is_ok(), "snapshot builder failed: {snapshot:?}");
        }
    }
}
