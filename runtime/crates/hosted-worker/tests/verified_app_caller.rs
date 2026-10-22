//! Real Noise IK initial app provenance; no policy/CP/serving authority.
use mdbn_hosted_worker::noise_sessions::NoiseSessions;
use mdbn_noise::{Initiator, Transport, public_key};
use mdbn_wire::common::{B16, B32};

const SERVER: [u8; 32] = [7; 32];
const CLIENT: [u8; 32] = [9; 32];

fn prologue() -> Vec<u8> {
    let mut p = b"mdbase/v1/client".to_vec();
    p.extend_from_slice(&[1; 16]);
    p.extend_from_slice(&[2; 16]);
    p.extend_from_slice(&[3; 16]);
    p
}

fn open(s: &mut NoiseSessions, p: &[u8]) -> (u32, Transport) {
    let h = s.start(&SERVER, p).unwrap();
    let mut i = Initiator::new(&CLIENT, &public_key(&SERVER), p);
    let m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
    let (payload, peer) = s.read1(h, &m1).unwrap();
    assert_eq!(payload, b"hello");
    assert_eq!(peer, public_key(&CLIENT));
    let m2 = s.write2(h, &[2; 32], b"welcome").unwrap();
    let (payload, t) = i.read_message_2(&m2).unwrap();
    assert_eq!(payload, b"welcome");
    (h, t)
}

#[test]
fn real_message_one_binds_app_claims_to_actual_peer_before_message_two() {
    let p = prologue();
    let mut s = NoiseSessions::default();
    let h = s.start(&SERVER, &p).unwrap();
    assert!(s.app_caller(h).is_none(), "prologue alone proves no peer");
    assert!(s.app_caller(h + 1).is_none());
    let mut i = Initiator::new(&CLIENT, &public_key(&SERVER), &p);
    let m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
    let (payload, peer) = s.read1(h, &m1).unwrap();
    assert_eq!(payload, b"hello");
    assert_eq!(peer, public_key(&CLIENT));
    assert!(
        s.peer(h).is_none(),
        "ordinary established-peer observer unchanged"
    );
    let caller = s.app_caller(h).unwrap();
    assert_eq!(caller.collection(), B16([1; 16]));
    assert_eq!(caller.grant(), B16([2; 16]));
    assert_eq!(caller.target_device(), B16([3; 16]));
    assert_eq!(caller.client_pk(), B32(public_key(&CLIENT)));
    assert_eq!(caller.responder_pk(), B32(public_key(&SERVER)));
    assert_eq!(format!("{caller:?}"), "VerifiedAppCaller { .. }");
    let m2 = s.write2(h, &[2; 32], b"welcome").unwrap();
    let (payload, mut t) = i.read_message_2(&m2).unwrap();
    assert_eq!(payload, b"welcome");
    assert_eq!(s.peer(h), Some(public_key(&CLIENT)));
    assert_eq!(s.app_caller(h).unwrap().client_pk(), caller.client_pk());
    assert_eq!(s.open(h, &t.seal(b"frame").unwrap()).unwrap(), b"frame");
    assert_eq!(t.open(&s.seal(h, b"reply").unwrap()).unwrap(), b"reply");
}

#[test]
fn arbitrary_or_invalid_app_prologues_preserve_noise_but_never_mint_app_proof() {
    let mut variants = vec![Vec::new(), b"ordinary".to_vec(), prologue()[..63].to_vec()];
    let mut longer = prologue();
    longer.push(0);
    variants.push(longer);
    let mut tag = prologue();
    tag[0] ^= 1;
    variants.push(tag);
    for offset in [16, 32, 48] {
        let mut zero = prologue();
        zero[offset..offset + 16].fill(0);
        variants.push(zero);
    }
    for p in variants {
        let mut s = NoiseSessions::default();
        let (h, mut t) = open(&mut s, &p);
        assert!(s.app_caller(h).is_none());
        assert_eq!(s.peer(h), Some(public_key(&CLIENT)));
        assert_eq!(s.open(h, &t.seal(b"frame").unwrap()).unwrap(), b"frame");
        assert_eq!(t.open(&s.seal(h, b"reply").unwrap()).unwrap(), b"reply");
        s.drop_session(h);
        assert!(s.is_empty());
    }
}

#[test]
fn changed_prologue_message_or_server_key_refuses_without_a_caller() {
    for offset in [0, 16, 32, 48] {
        let p = prologue();
        let mut other = p.clone();
        other[offset] ^= 1;
        let mut s = NoiseSessions::default();
        let h = s.start(&SERVER, &p).unwrap();
        let mut i = Initiator::new(&CLIENT, &public_key(&SERVER), &other);
        let m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
        assert!(s.read1(h, &m1).is_err());
        assert!(s.app_caller(h).is_none());
        assert!(s.is_empty());
    }
    for tamper in [false, true] {
        let p = prologue();
        let mut s = NoiseSessions::default();
        let h = s.start(&SERVER, &p).unwrap();
        let server = if tamper { SERVER } else { [8; 32] };
        let mut i = Initiator::new(&CLIENT, &public_key(&server), &p);
        let mut m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
        if tamper {
            let last = m1.len() - 1;
            m1[last] ^= 1;
        }
        assert!(s.read1(h, &m1).is_err());
        assert!(s.app_caller(h).is_none());
        assert!(s.is_empty());
    }
}

#[test]
fn failure_drop_clear_and_new_instance_do_not_restore_proof() {
    let p = prologue();
    let mut s = NoiseSessions::default();
    let (h, mut t) = open(&mut s, &p);
    let historical = s.app_caller(h).unwrap().clone();
    let mut bad = t.seal(b"frame").unwrap();
    bad[0] ^= 1;
    assert!(s.open(h, &bad).is_err());
    assert!(s.app_caller(h).is_none());
    assert_eq!(
        historical.grant(),
        B16([2; 16]),
        "clone is historical, not a lease"
    );

    let (h, _) = open(&mut s, &p);
    s.drop_session(h);
    assert!(s.app_caller(h).is_none());
    let (h, _) = open(&mut s, &p);
    s.clear();
    assert!(s.app_caller(h).is_none());
    let next = s.start(&SERVER, &p).unwrap();
    assert!(
        next > h,
        "ordinary monotonically allocated handles preserved"
    );
    assert!(s.app_caller(next).is_none());
    let mut fresh = NoiseSessions::default();
    let _new_handle = fresh.start(&SERVER, &p).unwrap();
    assert!(
        fresh.app_caller(h).is_none(),
        "new RAM instance cannot restore proof"
    );
    assert!(
        fresh.app_caller(1).is_none(),
        "even a reused numeric handle proves nothing"
    );
}

#[test]
fn failed_repeated_message_one_or_premature_message_two_drops_session() {
    let p = prologue();
    let mut s = NoiseSessions::default();
    let h = s.start(&SERVER, &p).unwrap();
    assert!(s.write2(h, &[2; 32], b"welcome").is_err());
    assert!(s.app_caller(h).is_none());
    assert!(s.is_empty());

    let h = s.start(&SERVER, &p).unwrap();
    let mut i = Initiator::new(&CLIENT, &public_key(&SERVER), &p);
    let m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
    s.read1(h, &m1).unwrap();
    assert!(s.app_caller(h).is_some());
    assert!(s.read1(h, &m1).is_err());
    assert!(s.app_caller(h).is_none());
    assert!(s.is_empty());
}

#[test]
fn simultaneous_real_peers_keep_separate_authenticated_prologues() {
    let p = prologue();
    let mut other = p.clone();
    other[32..48].fill(4);
    let mut s = NoiseSessions::default();
    let first = s.start(&SERVER, &p).unwrap();
    let second = s.start(&SERVER, &other).unwrap();
    for (h, secret, scope) in [(first, CLIENT, p), (second, [10; 32], other)] {
        let mut i = Initiator::new(&secret, &public_key(&SERVER), &scope);
        s.read1(h, &i.write_message_1(&[1; 32], b"hello").unwrap())
            .unwrap();
    }
    assert_eq!(s.app_caller(first).unwrap().grant(), B16([2; 16]));
    assert_eq!(s.app_caller(second).unwrap().grant(), B16([4; 16]));
    assert_eq!(
        s.app_caller(first).unwrap().client_pk(),
        B32(public_key(&CLIENT))
    );
    assert_eq!(
        s.app_caller(second).unwrap().client_pk(),
        B32(public_key(&[10; 32]))
    );
    s.drop_session(first);
    assert!(s.app_caller(first).is_none());
    assert!(s.app_caller(second).is_some());
}
