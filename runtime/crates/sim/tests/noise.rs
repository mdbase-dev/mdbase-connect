//! Native component evidence using the shared production IK, not a crypto fork.
//! These are not daemon admission, real relay, acknowledged-write or gate-1 tests.
//! The oracle registers caller static/ephemeral inputs (raw and clamped) and
//! derived transport keys. Internal handshake chaining/mix keys are not inspected.

use mdbn_core::host::Entropy;
use mdbn_noise::{Initiator, NoiseError, Responder, Transport, public_key};
use mdbn_sim::rng::{SeededTestEntropy, SimRng};
use mdbn_sim::tap::{Party, Tap};
use mdbn_wire::hash::sha256;

const PROLOGUE: &[u8] = b"mdbase-native-sim/noise-component/v1";
const CLIENT_BODY: &[u8] = b"private-client-path/record-id/body/native-noise-component";
const SERVER_BODY: &[u8] = b"private-server-path/record-id/body/native-noise-component";

struct Inputs {
    client_static: [u8; 32],
    server_static: [u8; 32],
    client_ephemeral: [u8; 32],
    server_ephemeral: [u8; 32],
}
impl Inputs {
    fn new(seed: u64, session: &str, tap: &mut Tap) -> Self {
        let world = SimRng::new(seed);
        let mut secret = |label: &str, session: &str| {
            let mut bytes = [0; 32];
            SeededTestEntropy::from_world(&world, &format!("noise/{session}/{label}"))
                .fill(&mut bytes);
            // Register BEFORE constructing any packet or exposing bytes to relay.
            tap.secret(label, &bytes);
            let mut clamped = bytes;
            clamped[0] &= 248;
            clamped[31] = (clamped[31] & 127) | 64;
            tap.secret(&format!("{label}/clamped"), &clamped);
            bytes
        };
        Self {
            client_static: secret("client-static", "device"),
            server_static: secret("server-static", "device"),
            client_ephemeral: secret("client-ephemeral", session),
            server_ephemeral: secret("server-ephemeral", session),
        }
    }
}
fn tap() -> Tap {
    let mut tap = Tap::default();
    tap.require_party(Party::Relay);
    tap.marker("client-body", CLIENT_BODY);
    tap.marker("server-body", SERVER_BODY);
    tap
}
fn packet(tap: &mut Tap, path: &str, bytes: &[u8]) {
    tap.require(path);
    tap.scan_path(Party::Relay, path, "actual production Noise packet", bytes);
}
fn clean(tap: &Tap) {
    assert!(
        tap.hits.is_empty(),
        "ciphertext exposed a registered marker or caller key"
    );
    assert!(tap.unscanned().is_empty());
    assert!(tap.unscanned_parties().is_empty());
    assert!(tap.per_party[&Party::Relay] >= 2);
}
fn register_transport_keys(tap: &mut Tap, transport: &Transport, endpoint: &str) {
    let (tx, rx) = transport
        .testing_keys()
        .expect("established transport has cipher keys");
    tap.secret(&format!("noise/{endpoint}/tx"), &tx[..]);
    tap.secret(&format!("noise/{endpoint}/rx"), &rx[..]);
}
fn handshake(seed: u64, session: &str, tap: &mut Tap) -> (Transport, Transport, Vec<Vec<u8>>) {
    let keys = Inputs::new(seed, session, tap);
    let mut client = Initiator::new(
        &keys.client_static,
        &public_key(&keys.server_static),
        PROLOGUE,
    );
    let mut server = Responder::new(&keys.server_static, PROLOGUE);
    let m1 = client
        .write_message_1(&keys.client_ephemeral, CLIENT_BODY)
        .unwrap();
    packet(tap, "relay:noise-message-1", &m1);
    let (p1, peer) = server.read_message_1(&m1).unwrap();
    assert_eq!(p1, CLIENT_BODY);
    assert_eq!(peer, public_key(&keys.client_static));
    let (m2, server) = server
        .write_message_2(&keys.server_ephemeral, SERVER_BODY)
        .unwrap();
    register_transport_keys(tap, &server, "server"); // BEFORE message 2 reaches relay
    packet(tap, "relay:noise-message-2", &m2);
    let (p2, client) = client.read_message_2(&m2).unwrap();
    register_transport_keys(tap, &client, "client"); // BEFORE first transport seal/send
    assert_eq!(p2, SERVER_BODY);
    assert_eq!(client.remote_static, public_key(&keys.server_static));
    assert_eq!(server.remote_static, peer);
    assert_eq!(client.handshake_hash, server.handshake_hash);
    (client, server, vec![m1, m2])
}
fn transcript(seed: u64) -> Vec<u8> {
    let mut tap = tap();
    let (mut client, mut server, mut frames) = handshake(seed, "initial", &mut tap);
    for _ in 0..4 {
        let c = client.seal(CLIENT_BODY).unwrap();
        packet(&mut tap, "relay:noise-client-transport", &c);
        assert_eq!(server.open(&c).unwrap(), CLIENT_BODY);
        frames.push(c);
        let c = server.seal(SERVER_BODY).unwrap();
        packet(&mut tap, "relay:noise-server-transport", &c);
        assert_eq!(client.open(&c).unwrap(), SERVER_BODY);
        frames.push(c);
    }
    assert_eq!(frames.len(), 10);
    for path in [
        "relay:noise-message-1",
        "relay:noise-message-2",
        "relay:noise-client-transport",
        "relay:noise-server-transport",
    ] {
        assert!(tap.per_path[path] > 0, "required path must be non-vacuous");
    }
    assert_eq!(tap.per_party[&Party::Relay], 10);
    clean(&tap);
    // Length delimiters keep distinct packet sequences independently meaningful.
    let bytes: Vec<_> = frames
        .into_iter()
        .flat_map(|f| {
            let mut framed = (f.len() as u64).to_le_bytes().to_vec();
            framed.extend(f);
            framed
        })
        .collect();
    sha256(&bytes).0.to_vec()
}

#[test]
fn seeded_production_noise_is_repeatable_and_tapped_on_each_actual_path() {
    let mut previous = None;
    for seed in 0..200 {
        let digest = transcript(seed);
        if seed % 10 == 0 {
            assert_eq!(digest, transcript(seed));
        }
        if let Some(previous) = previous {
            assert_ne!(digest, previous);
        }
        previous = Some(digest);
    }
}

#[test]
fn derived_transport_key_oracle_detects_deliberate_leaks_in_all_encodings() {
    for encoding in 0..5 {
        let mut tap = tap();
        let (_, server, _) = handshake(2, "oracle-negative-control", &mut tap);
        clean(&tap);
        let (key, _) = server.testing_keys().unwrap();
        let bytes = match encoding {
            0 => key.to_vec(),
            1 => mdbn_wire::render::hex(&key[..]).into_bytes(),
            2 => mdbn_sim::tap::base64(&key[..], false, true),
            3 => mdbn_sim::tap::base64(&key[..], true, true),
            _ => mdbn_sim::tap::base64(&key[..], true, false),
        };
        // A deliberate test-only leak proves learned-key registration is live.
        packet(&mut tap, "relay:deliberate-test-key-leak", &bytes);
        assert!(
            tap.hits
                .iter()
                .any(|h| h.kind == mdbn_sim::oracle::Kind::KeyExposure),
            "derived key must be detected in each encoding"
        );
        assert!(tap.unscanned().is_empty());
        assert!(tap.unscanned_parties().is_empty());
    }
}

#[test]
fn tamper_and_replay_refuse_without_skipping_an_honest_receive() {
    let mut tap = tap();
    let (mut client, mut server, _) = handshake(3, "initial", &mut tap);
    let honest = client.seal(CLIENT_BODY).unwrap();
    packet(&mut tap, "relay:noise-client-transport", &honest);
    let mut forged = honest.clone();
    *forged.last_mut().unwrap() ^= 1;
    packet(&mut tap, "relay:noise-tamper", &forged);
    assert_eq!(server.open(&forged), Err(NoiseError::Decrypt));
    assert_eq!(server.open(&honest).unwrap(), CLIENT_BODY);
    packet(&mut tap, "relay:noise-replay", &honest);
    assert_eq!(server.open(&honest), Err(NoiseError::Decrypt));
    let next = client.seal(CLIENT_BODY).unwrap();
    packet(&mut tap, "relay:noise-client-transport", &next);
    assert_eq!(server.open(&next).unwrap(), CLIENT_BODY);
    clean(&tap);
}

#[test]
fn dropped_ordered_message_requires_fresh_handshake_not_counter_restoration() {
    let mut tap = tap();
    let (mut client, mut server, _) = handshake(16, "initial", &mut tap);
    let old_hash = client.handshake_hash;
    let lost = client.seal(CLIENT_BODY).unwrap();
    packet(&mut tap, "relay:noise-dropped", &lost);
    let later = client.seal(CLIENT_BODY).unwrap();
    packet(&mut tap, "relay:noise-out-of-order", &later);
    assert_eq!(server.open(&later), Err(NoiseError::Decrypt));
    // Discard both old sessions. No persisted counters or cipher keys are used.
    drop((client, server));
    let (mut client, mut server, _) = handshake(16, "fresh-ephemerals", &mut tap);
    assert_ne!(client.handshake_hash, old_hash);
    let fresh = client.seal(CLIENT_BODY).unwrap();
    packet(&mut tap, "relay:noise-client-transport", &fresh);
    assert_ne!(fresh, lost);
    assert_eq!(server.open(&lost), Err(NoiseError::Decrypt));
    assert_eq!(server.open(&fresh).unwrap(), CLIENT_BODY);
    clean(&tap);
}

#[test]
fn caller_must_admit_the_authenticated_key_before_serving_any_operation() {
    let mut tap = tap();
    let keys = Inputs::new(53, "denied", &mut tap);
    let mut client = Initiator::new(
        &keys.client_static,
        &public_key(&keys.server_static),
        PROLOGUE,
    );
    let m1 = client
        .write_message_1(&keys.client_ephemeral, CLIENT_BODY)
        .unwrap();
    packet(&mut tap, "relay:noise-message-1", &m1);
    let mut responder = Responder::new(&keys.server_static, PROLOGUE);
    let (_, authenticated) = responder.read_message_1(&m1).unwrap();
    assert_eq!(authenticated, public_key(&keys.client_static));
    let approved = public_key(&[0x51; 32]);
    let mut served = 0;
    let admitted = authenticated == approved;
    if admitted {
        served += 1;
    }
    assert!(
        !admitted,
        "cryptographic authentication is not caller admission"
    );
    assert_eq!(served, 0);
    assert!(tap.hits.is_empty());
    assert!(tap.unscanned_parties().is_empty());
    assert_eq!(tap.per_party[&Party::Relay], 1);
    // A caller rejects by discarding handshake state before message 2/operations.
    drop(responder);
}

#[test]
fn wrong_prologue_discards_state_and_fresh_matching_handshake_succeeds() {
    let mut tap = tap();
    let keys = Inputs::new(137, "initial", &mut tap);
    let mut client = Initiator::new(
        &keys.client_static,
        &public_key(&keys.server_static),
        PROLOGUE,
    );
    let m1 = client
        .write_message_1(&keys.client_ephemeral, CLIENT_BODY)
        .unwrap();
    packet(&mut tap, "relay:noise-message-1", &m1);
    let mut wrong = Responder::new(&keys.server_static, b"another-grant-prologue");
    assert_eq!(wrong.read_message_1(&m1), Err(NoiseError::Decrypt));
    drop((wrong, client));
    let _ = handshake(137, "fresh-ephemerals", &mut tap);
    clean(&tap);
}
