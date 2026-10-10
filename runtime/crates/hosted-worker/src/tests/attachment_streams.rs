//! Engine streaming lifecycle over synthetic log policy and REAL attachment crypto.
//! This is not production log/admission or whole-Worker memory qualification.
use super::attachments::{FILE, attach_content};
use super::*;
use mdbn_replica::attachments::AttachmentWriter;
use mdbn_replica::crypto::chunked_blob::{
    AttachmentLimits, AttachmentRefV1, ExpectedFileV1, VerifiedManifestV1,
};
use mdbn_replica::crypto::{CsprngEntropy, Secret32, keys::Recipient};
use mdbn_replica::seal::{KeyEvent, KeyringSealer, OpenError, SealError, Sealer};
use mdbn_wire::attachment::AttachmentContentV1;
use mdbn_wire::client::FileChunk;
use mdbn_wire::envelope::KeyGrantPayload;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

struct AttachmentSealer {
    plain: PlainSealer,
    crypto: KeyringSealer,
}
impl AttachmentSealer {
    fn new() -> Self {
        let mut keys = mdbn_replica::crypto::keys::Keyring::new();
        keys.insert(1, Secret32([9; 32]));
        let bytes = keys.to_bytes();
        let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
        stored.extend_from_slice(&bytes);
        let mut crypto = KeyringSealer::new(COL, HOSTED_DEV, &[7; 32], &[8; 32]);
        crypto.import(&stored).unwrap();
        crypto.set_epoch(1);
        Self {
            plain: PlainSealer::for_device(HOSTED_DEV),
            crypto,
        }
    }
}
impl Sealer for AttachmentSealer {
    fn set_epoch(&mut self, e: u64) {
        self.plain.set_epoch(e);
        self.crypto.set_epoch(e);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.plain.current_epoch()
    }
    fn idem_token(&self, id: &B16) -> Option<B16> {
        self.plain.idem_token(id)
    }
    fn seal(
        &mut self,
        i: &mut mdbn_wire::envelope::Item,
        p: &[u8],
        c: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.plain.seal(i, p, c, e)
    }
    fn seal_object(
        &mut self,
        i: &mut mdbn_wire::envelope::Item,
        p: &[u8],
        c: bool,
        s: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.plain.seal_object(i, p, c, s, e)
    }
    fn blob_part_addresses(&self, b: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        self.plain.blob_part_addresses(b)
    }
    fn sign(&self, i: &mut mdbn_wire::envelope::Item) -> Result<(), SealError> {
        self.plain.sign(i)
    }
    fn open(&self, i: &mdbn_wire::envelope::Item, b: &[u8]) -> Result<Vec<u8>, OpenError> {
        self.plain.open(i, b)
    }
    fn verifier(&self) -> &dyn mdbn_replica::policy::SigVerifier {
        &super::signed_control_plain::ControlVerifier
    }
    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
        self.plain.accept_rekey(p)
    }
    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
        self.plain.accept_key_grant(p)
    }
    fn build_rekey(
        &mut self,
        f: u64,
        r: &[Recipient],
        reason: RekeyReason,
        e: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError> {
        self.plain.build_rekey(f, r, reason, e)
    }
    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.plain.export()
    }
    fn import(&mut self, b: &[u8]) -> Result<(), SealError> {
        self.plain.import(b)
    }
    fn open_attachment_manifest(
        &self,
        d: &AttachmentRefV1,
        x: ExpectedFileV1,
        b: &[u8],
        l: AttachmentLimits,
    ) -> Result<VerifiedManifestV1, OpenError> {
        self.crypto.open_attachment_manifest(d, x, b, l)
    }
    fn open_attachment_chunk(
        &self,
        m: &VerifiedManifestV1,
        i: u64,
        b: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        self.crypto.open_attachment_chunk(m, i, b)
    }
    fn open_attachment_chunk_in_place(
        &self,
        m: &VerifiedManifestV1,
        i: u64,
        b: &mut [u8],
    ) -> Result<std::ops::Range<usize>, OpenError> {
        self.crypto.open_attachment_chunk_in_place(m, i, b)
    }
}

struct Fixture {
    svc: FakeLogService,
    cp: TestControlPlane,
    h: Hosted,
    session: u64,
    content: AttachmentContentV1,
    objects: BTreeMap<B32, Vec<u8>>,
    plain: Vec<u8>,
}
fn fixture(size: usize) -> Fixture {
    let (svc, cp) = world_with_cp();
    let sealer = AttachmentSealer::new();
    let mut entropy = mdbn_replica::crypto::TestEntropy::new(71);
    let plain = (0..size).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    let mut writer = AttachmentWriter::new(
        &sealer.crypto,
        COL,
        size as u64,
        AttachmentLimits::default(),
        &mut entropy,
    )
    .unwrap();
    let mut objects = BTreeMap::new();
    let mut offset = 0;
    loop {
        let len = writer.next_chunk_len() as usize;
        let object = writer
            .push_chunk(&sealer.crypto, &plain[offset..offset + len], &mut entropy)
            .unwrap();
        objects.insert(object.cipher_hash, object.bytes);
        offset += len;
        if offset == size {
            break;
        }
    }
    let written = writer.finish(&sealer.crypto, &mut entropy).unwrap();
    objects.insert(written.manifest.cipher_hash, written.manifest.bytes);
    let content = AttachmentContentV1 {
        reference: mdbn_wire::attachment::AttachmentRefV1 {
            collection: COL,
            key_epoch: 1,
            attachment_id: written.descriptor.context.attachment_id,
            manifest_cipher_hash: written.descriptor.manifest_cipher_hash,
        },
        whole_plain_hash: written.expected.whole_plain_hash,
        total_plain_bytes: written.expected.total_plain_bytes,
    };
    let mut log = svc.client(OWNER_DEV);
    for (address, bytes) in &objects {
        log.call(LogRequest::PutObject {
            collection: COL,
            address: *address,
            kind: ItemKind::BlobPart,
            bytes: bytes.clone(),
        })
        .unwrap();
    }
    attach_content(
        &svc,
        0x71,
        content.clone(),
        objects.keys().copied().collect(),
    );
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(2)),
        zones: Box::new(UtcOnly),
    };
    let e = Engine::open_with(
        config(&svc),
        MemStore::new(),
        Box::new(sealer),
        host,
        HostedProfile::default(),
    )
    .unwrap();
    let mut h = Hosted {
        e,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    assert!(h.e.bind_log(COL));
    h.pump(false);
    assert!(h.e.serving());
    let (session, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    assert!(session > 0);
    h.e.poll();
    Fixture {
        svc,
        cp,
        h,
        session,
        content,
        objects,
        plain,
    }
}
fn read(f: &mut Fixture, range: Option<(u64, u64)>) -> u64 {
    let mut p = vec![(Cbor::Uint(0), FILE.to_cbor())];
    if let Some((o, n)) = range {
        p.push((
            Cbor::Uint(1),
            Cbor::Array(vec![Cbor::Uint(o), Cbor::Uint(n)]),
        ));
    }
    p.push((Cbor::Uint(2), f.content.whole_plain_hash.to_cbor()));
    f.h.e
        .frame(f.session, &request(501, "read_file", Cbor::Map(p)));
    f.h.e
        .poll()
        .into_iter()
        .find_map(|o| {
            let Out::Frame(_, bytes) = o else {
                return None;
            };
            match ClientFrame::from_bytes(&bytes).unwrap() {
                ClientFrame::Response(r) if r.id == 501 => match r.result.unwrap() {
                    Cbor::Map(fields) => fields.into_iter().find_map(|(k, v)| {
                        if k == Cbor::Uint(0) {
                            if let Cbor::Uint(s) = v { Some(s) } else { None }
                        } else {
                            None
                        }
                    }),
                    _ => None,
                },
                _ => None,
            }
        })
        .unwrap()
}
fn lease(f: &mut Fixture) -> Option<(u64, B32)> {
    let Cbor::Array(fields) = f.h.e.attachment_object()? else {
        panic!()
    };
    let Cbor::Uint(ticket) = fields[0] else {
        panic!()
    };
    let Cbor::Bytes(address) = &fields[2] else {
        panic!()
    };
    Some((ticket, B32(address.clone().try_into().unwrap())))
}
fn supply(f: &mut Fixture, ticket: u64, address: B32) -> bool {
    let bytes = &f.objects[&address];
    assert!(f.h.e.attachment_reserve(ticket, bytes.len() as u64));
    for segment in bytes.chunks(1 << 20) {
        assert!(f.h.e.attachment_write(ticket, segment));
    }
    f.h.e
        .attachment_complete(ticket, mdbn_wire::hash::sha256(bytes))
}
fn chunks(f: &mut Fixture) -> Vec<FileChunk> {
    f.h.e
        .poll()
        .into_iter()
        .filter_map(|o| {
            let Out::Frame(_, bytes) = o else {
                return None;
            };
            assert!(bytes.len() <= crate::runtime::MAX_OUT_FRAME);
            match ClientFrame::from_bytes(&bytes).unwrap() {
                ClientFrame::Push(p) if p.kind == "file_chunk" => {
                    Some(FileChunk::from_cbor(&p.payload).unwrap())
                }
                _ => None,
            }
        })
        .collect()
}
fn ack(f: &mut Fixture, stream: u64, offset: u64) {
    f.h.e.frame(
        f.session,
        &request(
            502,
            "ack_chunks",
            Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Uint(stream)),
                (Cbor::Uint(1), Cbor::Uint(offset)),
            ]),
        ),
    );
}

#[test]
fn engine_queue_preflight_is_not_a_pin_and_busy_reply_rechecks_authority() {
    let mut f = fixture(500);
    let frame = request(
        901,
        "read_file",
        Cbor::Map(vec![
            (Cbor::Uint(0), FILE.to_cbor()),
            (Cbor::Uint(2), f.content.whole_plain_hash.to_cbor()),
        ]),
    );
    assert!(f.h.e.attachment_call_requires_slot(f.session, &frame));
    assert!(!f.h.e.attachment_active(f.session));
    assert!(f.h.e.attachment_object().is_none());
    f.h.e.attachment_call_busy(f.session, &frame);
    let out = f.h.e.poll();
    let response = out
        .into_iter()
        .find_map(|o| match o {
            Out::Frame(_, b) => match ClientFrame::from_bytes(&b).unwrap() {
                ClientFrame::Response(r) if r.id == 901 => Some(r),
                _ => None,
            },
            _ => None,
        })
        .unwrap();
    let problem = response.problem.unwrap();
    assert_eq!(problem.code, "unavailable");
    assert_eq!(problem.reason.as_deref(), Some("hosted_chunk_busy"));
    assert_eq!(
        problem.details,
        Some(mdbn_wire::common::Value::Map(vec![(
            "retry_after_ms".into(),
            mdbn_wire::common::Value::Int(1000),
        )]))
    );
    assert!(!f.h.e.attachment_active(f.session));
    let denied = f.session + 1000;
    assert!(!f.h.e.attachment_call_requires_slot(denied, &frame));
    f.h.e.attachment_call_busy(denied, &frame);
    for o in f.h.e.poll() {
        if let Out::Frame(_, b) = o
            && let ClientFrame::Response(r) = ClientFrame::from_bytes(&b).unwrap()
        {
            assert_ne!(
                r.problem.unwrap().reason.as_deref(),
                Some("hosted_chunk_busy")
            );
        }
    }
    read(&mut f, None);
    assert!(f.h.e.attachment_active(f.session));
    assert!(!f.h.e.attachment_call_requires_slot(f.session, &frame));
}

#[test]
fn engine_authenticated_stream_full_range_and_empty_reads() {
    for (size, range) in [
        (12345, None),
        (0, None),
        (12345, Some((10, 100))),
        (12345, Some((12345, 0))),
    ] {
        let mut f = fixture(size);
        let stream = read(&mut f, range);
        let mut got = Vec::new();
        let start = range.map_or(0, |r| r.0);
        let len = range.map_or(size as u64, |r| r.1);
        let mut last = false;
        for _ in 0..100 {
            if let Some((ticket, address)) = lease(&mut f) {
                assert!(supply(&mut f, ticket, address));
            }
            for c in chunks(&mut f) {
                assert_eq!(c.stream, stream);
                assert_eq!(c.offset, start + got.len() as u64);
                got.extend_from_slice(&c.bytes.0);
                last = c.last;
                if !last {
                    ack(&mut f, stream, c.offset + c.bytes.0.len() as u64);
                }
            }
            if last {
                break;
            }
        }
        assert!(last);
        assert_eq!(got, f.plain[start as usize..(start + len) as usize]);
        assert!(lease(&mut f).is_none());
    }
}
#[test]
fn engine_ack_window_bounds_output_and_range_fetches_only_intersecting_chunks() {
    let chunk = 8usize << 20;
    let mut f = fixture(chunk + 1234);
    let stream = read(&mut f, None);
    for _ in 0..2 {
        let (ticket, address) = lease(&mut f).unwrap();
        assert!(supply(&mut f, ticket, address));
    }
    let mut emitted = 0u64;
    for _ in 0..20 {
        for c in chunks(&mut f) {
            assert!(!c.last);
            emitted += c.bytes.0.len() as u64;
        }
    }
    assert_eq!(emitted, chunk as u64);
    assert!(chunks(&mut f).is_empty());
    assert!(lease(&mut f).is_none());
    ack(&mut f, stream, emitted + 1);
    assert!(
        lease(&mut f).is_none(),
        "future ACK cannot expand the window"
    );
    ack(&mut f, stream, emitted);
    let (ticket, address) = lease(&mut f).unwrap();
    assert!(supply(&mut f, ticket, address));
    let result = chunks(&mut f);
    assert_eq!(result.len(), 1);
    assert!(result[0].last);
    assert_eq!(result[0].offset, emitted);
    assert_eq!(result[0].bytes.0, f.plain[chunk..]);
    let mut f = fixture(chunk + 1234);
    let stream = read(&mut f, Some((chunk as u64 + 3, 7)));
    let (ticket, address) = lease(&mut f).unwrap();
    assert_eq!(address, f.content.reference.manifest_cipher_hash);
    assert!(supply(&mut f, ticket, address));
    let (ticket, address) = lease(&mut f).unwrap();
    assert!(supply(&mut f, ticket, address));
    let result = chunks(&mut f);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].stream, stream);
    assert!(result[0].last);
    assert_eq!(result[0].bytes.0, f.plain[chunk + 3..chunk + 10]);
    assert!(lease(&mut f).is_none());
}

#[test]
fn engine_cancellation_is_session_scoped_and_stale_tickets_cannot_cancel_new_read() {
    let mut f = fixture(500);
    let stream = read(&mut f, None);
    let (old, address) = lease(&mut f).unwrap();
    let (other, _) = f.h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    assert!(other > 0);
    let cancel = request(
        503,
        "cancel_stream",
        Cbor::Map(vec![(Cbor::Uint(0), Cbor::Uint(stream))]),
    );
    f.h.e.frame(other, &cancel);
    assert!(f.h.e.attachment_allowed(old));
    f.h.e.frame(f.session, &cancel);
    assert!(!f.h.e.attachment_allowed(old));
    assert!(!f.h.e.attachment_reserve(old, 10));
    let _new = read(&mut f, None);
    let (ticket, _) = lease(&mut f).unwrap();
    assert!(ticket > old);
    f.h.e.attachment_failed(old);
    assert!(f.h.e.attachment_allowed(ticket));
    assert!(supply(&mut f, ticket, address));
}
#[test]
fn engine_revocation_timeout_and_retired_transport_block_ciphertext_supply() {
    let mut f = fixture(500);
    read(&mut f, None);
    let (ticket, _) = lease(&mut f).unwrap();
    f.h.e.retire_log();
    assert!(!f.h.e.attachment_allowed(ticket));
    assert!(!f.h.e.attachment_write(ticket, b"x"));
    assert!(f.h.e.bind_log(COL));
    f.h.pump(false);
    let (next, _) = lease(&mut f).unwrap();
    assert!(next > ticket);
    f.cp.revoke(&f.svc, HOSTED_DEV);
    f.h.e.retire_log();
    assert!(f.h.e.bind_log(COL));
    f.h.pump(false);
    assert!(!f.h.e.attachment_allowed(next));
    assert!(!f.h.e.attachment_reserve(next, 10));
    assert!(chunks(&mut f).is_empty());
    let mut f = fixture(500);
    read(&mut f, None);
    let (ticket, _) = lease(&mut f).unwrap();
    f.h.e.tick(1_700_000_060_000);
    assert!(!f.h.e.attachment_allowed(ticket));
    assert!(!f.h.e.attachment_reserve(ticket, 10));
}
#[test]
fn engine_app_grant_revocation_drops_authenticated_plaintext_before_output() {
    let mut f = fixture(8 << 20);
    read(&mut f, None);
    for _ in 0..2 {
        let (ticket, address) = lease(&mut f).unwrap();
        assert!(supply(&mut f, ticket, address));
    }
    f.cp.append(
        &f.svc,
        vec![mdbn_wire::policy::PolicyOp::GrantRevoke(
            mdbn_wire::policy::GrantRevoke { grant: GRANT },
        )],
    );
    f.h.e.retire_log();
    assert!(f.h.e.bind_log(COL));
    f.h.pump(false);
    assert!(
        f.h.e.serving(),
        "only app grant is revoked, not hosted custody"
    );
    assert!(
        chunks(&mut f).is_empty(),
        "no held authenticated bytes after app READ revocation"
    );
    assert!(lease(&mut f).is_none());
}

#[test]
fn engine_direct_region_requires_exact_pending_commit_and_refuses_stale_windows() {
    let mut f = fixture(500);
    read(&mut f, None);
    let (ticket, address) = lease(&mut f).unwrap();
    assert!(
        f.h.e
            .attachment_reserve(ticket, f.objects[&address].len() as u64)
    );
    assert!(!f.h.e.attachment_written(ticket, 10));
    assert!(f.h.e.attachment_region(ticket, (1 << 20) + 1).is_none());
    assert!(f.h.e.attachment_region(ticket, 10).is_some());
    assert!(f.h.e.attachment_region(ticket, 1).is_none());
    assert!(!f.h.e.attachment_write(ticket, b"x"));
    assert!(!f.h.e.attachment_written(ticket, 11));
    assert!(!f.h.e.attachment_written(ticket + 1, 10));
    assert!(f.h.e.attachment_written(ticket, 10));
    assert!(!f.h.e.attachment_written(ticket, 10));
    assert!(f.h.e.attachment_region(ticket, 10).is_some());
    f.h.e.retire_log();
    assert!(f.h.e.attachment_region(ticket, 1).is_none());
    assert!(!f.h.e.attachment_written(ticket, 10));
    assert!(f.h.e.bind_log(COL));
    f.h.pump(false);
    let (next, _) = lease(&mut f).unwrap();
    assert!(next > ticket);
    assert!(f.h.e.attachment_region(ticket, 1).is_none());
    f.h.e.attachment_failed(ticket);
    assert!(f.h.e.attachment_allowed(next));
}

#[test]
fn engine_direct_region_pending_completion_fails_closed_without_output() {
    let mut f = fixture(500);
    read(&mut f, None);
    let (ticket, address) = lease(&mut f).unwrap();
    let bytes = &f.objects[&address];
    assert!(f.h.e.attachment_reserve(ticket, bytes.len() as u64));
    assert!(f.h.e.attachment_region(ticket, 10).is_some());
    assert!(
        !f.h.e
            .attachment_complete(ticket, mdbn_wire::hash::sha256(bytes))
    );
    assert!(!f.h.e.attachment_allowed(ticket));
    assert!(!f.h.e.attachment_written(ticket, 10));
    assert!(chunks(&mut f).is_empty());
}

#[test]
fn engine_checksum_truncation_and_tamper_release_no_app_bytes() {
    for mode in [0, 1, 2] {
        let mut f = fixture(500);
        read(&mut f, None);
        let (ticket, address) = lease(&mut f).unwrap();
        let mut bytes = f.objects[&address].clone();
        assert!(f.h.e.attachment_reserve(ticket, bytes.len() as u64));
        if mode == 0 {
            bytes.pop();
        }
        if mode == 1 {
            let last = bytes.len() - 1;
            bytes[last] ^= 1;
        }
        assert!(f.h.e.attachment_write(ticket, &bytes));
        let checksum = if mode == 2 {
            B32([1; 32])
        } else {
            mdbn_wire::hash::sha256(&bytes)
        };
        assert!(!f.h.e.attachment_complete(ticket, checksum));
        assert!(chunks(&mut f).is_empty());
        assert!(!f.h.e.attachment_allowed(ticket));
    }
}

#[test]
fn engine_read_holds_shared_region_and_handoff_is_full_wipe_same_pointer() {
    use crate::RegionOwner;
    use mdbn_replica::api::SessionId;
    let mut f = fixture(500);
    read(&mut f, None);
    let region = f.h.e.test_attachment_region();
    let held = region.held_lease().unwrap();
    let pointer = region.borrow(held).unwrap().as_ptr();
    let upload = RegionOwner::Upload {
        session: SessionId(f.session),
        mutation: FILE,
    };
    assert!(region.acquire(upload).is_none());
    region.borrow(held).unwrap().fill(0xac);
    f.h.e.close(f.session);
    let region = f.h.e.test_attachment_region();
    assert!(region.held_lease().is_none());
    for owner in [
        upload,
        RegionOwner::Rehash {
            session: SessionId(f.session),
            mutation: FILE,
        },
    ] {
        let lease = region.acquire(owner).unwrap();
        let backing = region.borrow(lease).unwrap();
        assert_eq!(backing.as_ptr(), pointer);
        assert_eq!(backing.len(), 9 << 20);
        assert!(backing.iter().all(|b| *b == 0));
        backing.fill(0xba);
        assert!(!region.release(held));
        assert!(region.borrow(lease).unwrap().iter().all(|b| *b == 0xba));
        assert!(region.release(lease));
    }
    let (session, _) = f.h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    f.session = session;
    read(&mut f, None);
    let region = f.h.e.test_attachment_region();
    let held = region.held_lease().unwrap();
    assert_eq!(region.borrow(held).unwrap().as_ptr(), pointer);
    assert!(region.borrow(held).unwrap().iter().all(|b| *b == 0));
}

#[test]
fn engine_read_cannot_acquire_upload_owned_region_and_denial_precedes_busy() {
    use crate::RegionOwner;
    use mdbn_replica::api::SessionId;
    let mut f = fixture(500);
    let upload =
        f.h.e
            .test_attachment_region()
            .acquire(RegionOwner::Upload {
                session: SessionId(f.session),
                mutation: FILE,
            })
            .unwrap();
    f.h.e
        .test_attachment_region()
        .borrow(upload)
        .unwrap()
        .fill(0xbd);
    let frame = request(
        951,
        "read_file",
        Cbor::Map(vec![(Cbor::Uint(0), FILE.to_cbor())]),
    );
    for session in [f.session, f.session + 1000] {
        f.h.e.frame(session, &frame);
        let response =
            f.h.e
                .poll()
                .into_iter()
                .find_map(|o| match o {
                    Out::Frame(_, b) => match ClientFrame::from_bytes(&b).unwrap() {
                        ClientFrame::Response(r) if r.id == 951 => Some(r),
                        _ => None,
                    },
                    _ => None,
                })
                .unwrap();
        let problem = response.problem.unwrap();
        if session == f.session {
            assert_eq!(problem.code, "unavailable");
            assert_eq!(problem.reason.as_deref(), Some("hosted_chunk_busy"));
            assert_eq!(
                problem.details,
                Some(mdbn_wire::common::Value::Map(vec![(
                    "retry_after_ms".into(),
                    mdbn_wire::common::Value::Int(1000),
                )]))
            );
        } else {
            assert_ne!(problem.reason.as_deref(), Some("hosted_chunk_busy"));
        }
        assert!(!f.h.e.attachment_active(session));
        assert!(f.h.e.attachment_object().is_none());
        assert!(
            f.h.e
                .test_attachment_region()
                .borrow(upload)
                .unwrap()
                .iter()
                .all(|b| *b == 0xbd)
        );
    }
}

#[test]
fn engine_stale_read_tickets_and_cleanup_never_touch_successor_region() {
    use crate::RegionOwner;
    use mdbn_replica::api::SessionId;
    // Simulate a stale FileReads state after an owner handoff. Every consumer
    // must independently refuse; neither stale output nor cleanup can use it.
    for cleanup in 0..7 {
        let mut f = fixture(500);
        let stream = read(&mut f, None);
        let (ticket, address) = lease(&mut f).unwrap();
        assert!(
            f.h.e
                .attachment_reserve(ticket, f.objects[&address].len() as u64)
        );
        assert!(f.h.e.attachment_region(ticket, 10).is_some());
        let region = f.h.e.test_attachment_region();
        let old = region.held_lease().unwrap();
        assert!(region.release(old));
        let new = region
            .acquire(RegionOwner::Upload {
                session: SessionId(f.session),
                mutation: FILE,
            })
            .unwrap();
        region.borrow(new).unwrap().fill(0xce);
        assert!(!f.h.e.attachment_allowed(ticket));
        assert!(!f.h.e.attachment_reserve(ticket, 10));
        assert!(f.h.e.attachment_region(ticket, 10).is_none());
        assert!(!f.h.e.attachment_written(ticket, 10));
        assert!(!f.h.e.attachment_write(ticket, b"x"));
        ack(&mut f, stream, 0);
        match cleanup {
            0 => f.h.e.close(f.session),
            1 => f.h.e.tick(1_700_000_060_000),
            2 => f.h.e.retire_log(),
            3 => f.h.e.attachment_failed(ticket),
            4 => {
                assert!(!f.h.e.attachment_complete(ticket, address));
            }
            5 => {
                assert!(f.h.e.attachment_object().is_none());
            }
            _ => f.h.e.frame(
                f.session,
                &request(
                    952,
                    "cancel_stream",
                    Cbor::Map(vec![(Cbor::Uint(0), Cbor::Uint(stream))]),
                ),
            ),
        }
        assert!(chunks(&mut f).is_empty());
        let region = f.h.e.test_attachment_region();
        assert!(region.owns(new));
        assert!(region.borrow(new).unwrap().iter().all(|b| *b == 0xce));
    }
}

#[test]
fn engine_success_and_idle_release_lease_transport_retirement_only_scrubs() {
    let mut f = fixture(500);
    read(&mut f, None);
    for _ in 0..2 {
        let (ticket, address) = lease(&mut f).unwrap();
        assert!(supply(&mut f, ticket, address));
    }
    assert!(chunks(&mut f).last().unwrap().last);
    assert!(f.h.e.test_attachment_region().held_lease().is_none());
    read(&mut f, None);
    let (ticket, _) = lease(&mut f).unwrap();
    assert!(f.h.e.attachment_reserve(ticket, 10));
    let region = f.h.e.test_attachment_region();
    let held = region.held_lease().unwrap();
    region.borrow(held).unwrap().fill(0xdf);
    f.h.e.retire_log();
    let region = f.h.e.test_attachment_region();
    assert!(region.owns(held));
    assert!(region.borrow(held).unwrap().iter().all(|b| *b == 0));
    f.h.e.tick(1_700_000_060_000);
    assert!(f.h.e.test_attachment_region().held_lease().is_none());
}

#[test]
fn engine_authenticated_held_read_span_never_outputs_successor_upload_bytes() {
    use crate::RegionOwner;
    use mdbn_replica::api::SessionId;
    let mut f = fixture(500);
    read(&mut f, None);
    for _ in 0..2 {
        let (ticket, address) = lease(&mut f).unwrap();
        assert!(supply(&mut f, ticket, address));
    }
    let region = f.h.e.test_attachment_region();
    let old = region.held_lease().unwrap();
    assert!(region.release(old));
    let new = region
        .acquire(RegionOwner::Upload {
            session: SessionId(f.session),
            mutation: FILE,
        })
        .unwrap();
    region.borrow(new).unwrap().fill(0xef);
    assert!(
        chunks(&mut f).is_empty(),
        "held span is not a region permit"
    );
    let region = f.h.e.test_attachment_region();
    assert!(region.owns(new));
    assert!(region.borrow(new).unwrap().iter().all(|b| *b == 0xef));
}
