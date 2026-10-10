//! `Noise_IK_25519_ChaChaPoly_SHA256` (Noise revision 34) for client sessions
//! (`replica-client-api.md` §12.2–12.3), byte-compatible with the SDK's
//! `transport/noise.ts` and checked against the same cacophony test vector.
//!
//! ```text
//! <- s
//! ...
//! -> e, es, s, ss
//! <- e, ee, se
//! ```
//!
//! No rekeying: sessions end after 2^30 messages in either direction (§12.3).
//! All-zero DH outputs are rejected: a `recovery` device has no Noise key,
//! and an all-zero static key must never complete a handshake).
//!
//! Native/WASM deterministic shared production cryptography; no internal dependencies, clocks, I/O
//! or ambient entropy. Callers supply static/ephemeral secrets and prologues.
//! Production secrets must come from a CSPRNG; seeded inputs belong only in tests
//! and simulation. This crate authenticates a peer key/payload, **not admission**:
//! callers enforce device/grant/prologue policy before serving any operation.
//! Handshakes are single-use; discard their state after any error.

#![cfg_attr(
    not(feature = "testing"),
    doc = r#"
Normal consumers cannot export transport keys:
```compile_fail
fn no_key_export(transport: &mdbn_noise::Transport) {
    let _ = transport.testing_keys();
}
```
"#
)]

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

/// Protocol name.
pub const PROTOCOL_NAME: &[u8] = b"Noise_IK_25519_ChaChaPoly_SHA256";
/// Largest Noise message.
pub const MAX_MESSAGE: usize = 65_535;
const TAGLEN: usize = 16;
/// Largest plaintext in one transport message.
pub const MAX_PLAINTEXT: usize = MAX_MESSAGE - TAGLEN;
/// Messages per direction before the session must end (§12.3).
pub const MAX_SESSION_MESSAGES: u64 = 1 << 30;

/// Handshake or transport failure. Deliberately uninformative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoiseError {
    /// A message was malformed or failed authentication.
    Decrypt,
    /// A DH output was all zero (low-order or zero key).
    WeakKey,
    /// Too large, or the session's message budget is spent.
    Limit,
}

impl std::fmt::Display for NoiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            NoiseError::Decrypt => "noise: message failed to authenticate",
            NoiseError::WeakKey => "noise: weak key",
            NoiseError::Limit => "noise: limit reached",
        })
    }
}

impl std::error::Error for NoiseError {}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

fn hkdf2(ck: &[u8; 32], ikm: &[u8]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let temp = Zeroizing::new(hmac(ck, &[ikm]));
    let o1 = Zeroizing::new(hmac(&temp[..], &[&[1u8]]));
    let o2 = Zeroizing::new(hmac(&temp[..], &[&o1[..], &[2u8]]));
    (o1, o2)
}

fn dh(sk: &StaticSecret, pk: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>, NoiseError> {
    let out = Zeroizing::new(sk.diffie_hellman(&PublicKey::from(*pk)).to_bytes());
    if out.iter().all(|b| *b == 0) {
        return Err(NoiseError::WeakKey);
    }
    Ok(out)
}

fn nonce(n: u64) -> Nonce {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_le_bytes());
    Nonce::from(b)
}

/// One direction's cipher state.
pub struct CipherState {
    key: Option<Zeroizing<[u8; 32]>>,
    n: u64,
}

impl CipherState {
    fn empty() -> CipherState {
        CipherState { key: None, n: 0 }
    }

    fn with_key(k: &[u8; 32]) -> CipherState {
        CipherState {
            key: Some(Zeroizing::new(*k)),
            n: 0,
        }
    }

    /// Encrypt with associated data (identity when no key yet).
    pub fn encrypt(&mut self, ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let Some(k) = &self.key else {
            return Ok(plaintext.to_vec());
        };
        if self.n >= MAX_SESSION_MESSAGES {
            return Err(NoiseError::Limit);
        }
        let c = ChaCha20Poly1305::new(Key::from_slice(&k[..]))
            .encrypt(
                &nonce(self.n),
                Payload {
                    msg: plaintext,
                    aad: ad,
                },
            )
            .map_err(|_| NoiseError::Limit)?;
        self.n += 1;
        Ok(c)
    }

    /// Decrypt with associated data (identity when no key yet).
    pub fn decrypt(&mut self, ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let Some(k) = &self.key else {
            return Ok(ciphertext.to_vec());
        };
        if self.n >= MAX_SESSION_MESSAGES {
            return Err(NoiseError::Limit);
        }
        let p = ChaCha20Poly1305::new(Key::from_slice(&k[..]))
            .decrypt(
                &nonce(self.n),
                Payload {
                    msg: ciphertext,
                    aad: ad,
                },
            )
            .map_err(|_| NoiseError::Decrypt)?;
        self.n += 1;
        Ok(p)
    }
}

struct Symmetric {
    ck: [u8; 32],
    h: [u8; 32],
    cs: CipherState,
}

impl Drop for Symmetric {
    fn drop(&mut self) {
        self.ck.zeroize();
    }
}

impl Symmetric {
    fn new(prologue: &[u8]) -> Symmetric {
        // The name is exactly 32 bytes, so h = name, padded (no hash).
        let mut h = [0u8; 32];
        h.copy_from_slice(PROTOCOL_NAME);
        let mut s = Symmetric {
            ck: h,
            h,
            cs: CipherState::empty(),
        };
        s.mix_hash(prologue);
        s
    }

    fn mix_hash(&mut self, data: &[u8]) {
        let mut d = Sha256::new();
        d.update(self.h);
        d.update(data);
        self.h = d.finalize().into();
    }

    fn mix_key(&mut self, ikm: &[u8]) {
        let (ck, k) = hkdf2(&self.ck, ikm);
        self.ck = *ck;
        self.cs = CipherState::with_key(&k);
    }

    fn encrypt_and_hash(&mut self, p: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let h = self.h;
        let c = self.cs.encrypt(&h, p)?;
        self.mix_hash(&c);
        Ok(c)
    }

    fn decrypt_and_hash(&mut self, c: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let h = self.h;
        let p = self.cs.decrypt(&h, c)?;
        self.mix_hash(c);
        Ok(p)
    }

    fn split(&self) -> (CipherState, CipherState) {
        let (k1, k2) = hkdf2(&self.ck, &[]);
        (CipherState::with_key(&k1), CipherState::with_key(&k2))
    }
}

/// An established session: send with `tx`, receive with `rx`.
pub struct Transport {
    /// Outgoing.
    pub tx: CipherState,
    /// Incoming.
    pub rx: CipherState,
    /// The handshake hash (channel binding).
    pub handshake_hash: [u8; 32],
    /// The peer's static public key, as authenticated.
    pub remote_static: [u8; 32],
}

/// Zeroizing outgoing/incoming key copies, available only to test tooling.
#[cfg(feature = "testing")]
pub type TestingTransportKeys = (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>);

impl Transport {
    /// Copies of outgoing/incoming cipher keys for test-only exposure oracles.
    ///
    /// Normal consumers do not compile this method. Copies zeroize on drop;
    /// reading them changes neither keys nor message counters.
    #[cfg(feature = "testing")]
    pub fn testing_keys(&self) -> Option<TestingTransportKeys> {
        Some((
            Zeroizing::new(**self.tx.key.as_ref()?),
            Zeroizing::new(**self.rx.key.as_ref()?),
        ))
    }

    /// Encrypt one transport message.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(NoiseError::Limit);
        }
        self.tx.encrypt(&[], plaintext)
    }

    /// Decrypt one transport message.
    pub fn open(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if message.len() > MAX_MESSAGE {
            return Err(NoiseError::Limit);
        }
        self.rx.decrypt(&[], message)
    }
}

/// IK responder. Single-shot: one message 1, then one message 2.
pub struct Responder {
    sym: Symmetric,
    s: StaticSecret,
    re: [u8; 32],
    rs: [u8; 32],
}

impl Responder {
    /// Start with the responder's static secret and the prologue.
    pub fn new(static_secret: &[u8; 32], prologue: &[u8]) -> Responder {
        let s = StaticSecret::from(*static_secret);
        let mut sym = Symmetric::new(prologue);
        sym.mix_hash(PublicKey::from(&s).as_bytes()); // <- s
        Responder {
            sym,
            s,
            re: [0; 32],
            rs: [0; 32],
        }
    }

    /// Read message 1 (`e, es, s, ss`); returns its payload and the initiator's
    /// static key.
    pub fn read_message_1(&mut self, msg: &[u8]) -> Result<(Vec<u8>, [u8; 32]), NoiseError> {
        if msg.len() < 32 + 48 + TAGLEN || msg.len() > MAX_MESSAGE {
            return Err(NoiseError::Decrypt);
        }
        self.re.copy_from_slice(&msg[..32]);
        self.sym.mix_hash(&self.re);
        let es = dh(&self.s, &self.re)?;
        self.sym.mix_key(&es[..]);
        let rs = self.sym.decrypt_and_hash(&msg[32..80])?;
        self.rs.copy_from_slice(&rs);
        let ss = dh(&self.s, &self.rs)?;
        self.sym.mix_key(&ss[..]);
        let payload = self.sym.decrypt_and_hash(&msg[80..])?;
        Ok((payload, self.rs))
    }

    /// Write message 2 (`e, ee, se`) with `payload`, using the ephemeral secret
    /// `e` (from the host CSPRNG in production; fixed only in test vectors).
    pub fn write_message_2(
        mut self,
        e: &[u8; 32],
        payload: &[u8],
    ) -> Result<(Vec<u8>, Transport), NoiseError> {
        let e = StaticSecret::from(*e);
        let epub = PublicKey::from(&e).to_bytes();
        let mut out = epub.to_vec();
        self.sym.mix_hash(&epub);
        let ee = dh(&e, &self.re)?;
        self.sym.mix_key(&ee[..]);
        let se = dh(&e, &self.rs)?;
        self.sym.mix_key(&se[..]);
        out.extend(self.sym.encrypt_and_hash(payload)?);
        if out.len() > MAX_MESSAGE {
            return Err(NoiseError::Limit);
        }
        let (c1, c2) = self.sym.split();
        Ok((
            out,
            Transport {
                tx: c2,
                rx: c1,
                handshake_hash: self.sym.h,
                remote_static: self.rs,
            },
        ))
    }
}

/// IK initiator (the CLI and tests).
pub struct Initiator {
    sym: Symmetric,
    s: StaticSecret,
    e: StaticSecret,
    rs: [u8; 32],
}

impl Initiator {
    /// Start with our static secret, the responder's static key and the prologue.
    pub fn new(static_secret: &[u8; 32], remote_static: &[u8; 32], prologue: &[u8]) -> Initiator {
        let mut sym = Symmetric::new(prologue);
        sym.mix_hash(remote_static);
        Initiator {
            sym,
            s: StaticSecret::from(*static_secret),
            e: StaticSecret::from([0u8; 32]),
            rs: *remote_static,
        }
    }

    /// Write message 1 with `payload` and the ephemeral secret `e`.
    pub fn write_message_1(&mut self, e: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.e = StaticSecret::from(*e);
        let epub = PublicKey::from(&self.e).to_bytes();
        let mut out = epub.to_vec();
        self.sym.mix_hash(&epub);
        let es = dh(&self.e, &self.rs)?;
        self.sym.mix_key(&es[..]);
        let spub = PublicKey::from(&self.s).to_bytes();
        out.extend(self.sym.encrypt_and_hash(&spub)?);
        let ss = dh(&self.s, &self.rs)?;
        self.sym.mix_key(&ss[..]);
        out.extend(self.sym.encrypt_and_hash(payload)?);
        if out.len() > MAX_MESSAGE {
            return Err(NoiseError::Limit);
        }
        Ok(out)
    }

    /// Read message 2; returns its payload and the session.
    pub fn read_message_2(mut self, msg: &[u8]) -> Result<(Vec<u8>, Transport), NoiseError> {
        if msg.len() < 32 + TAGLEN || msg.len() > MAX_MESSAGE {
            return Err(NoiseError::Decrypt);
        }
        let mut re = [0u8; 32];
        re.copy_from_slice(&msg[..32]);
        self.sym.mix_hash(&re);
        let ee = dh(&self.e, &re)?;
        self.sym.mix_key(&ee[..]);
        let se = dh(&self.s, &re)?;
        self.sym.mix_key(&se[..]);
        let payload = self.sym.decrypt_and_hash(&msg[32..])?;
        let (c1, c2) = self.sym.split();
        Ok((
            payload,
            Transport {
                tx: c1,
                rx: c2,
                handshake_hash: self.sym.h,
                remote_static: self.rs,
            },
        ))
    }
}

/// The public key of an X25519 secret.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        assert_eq!(s.len() % 2, 0);
        s.as_bytes()
            .chunks_exact(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect()
    }
    fn k(s: &str) -> [u8; 32] {
        h(s).try_into().unwrap()
    }

    /// The cacophony vector the SDK also uses
    /// (`packages/sdk/test/fixtures/noise-ik-25519-chachapoly-sha256.json`).
    fn cacophony_case() {
        let prologue = h("4a6f686e2047616c74");
        let init_s = k("e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1");
        let init_e = k("893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a");
        let resp_s = k("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893");
        let resp_e = k("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b");
        let resp_pub = k("31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62");
        assert_eq!(public_key(&resp_s), resp_pub);
        let msgs = [
            (
                "4c756477696720766f6e204d69736573",
                "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7",
            ),
            (
                "4d757272617920526f746862617264",
                "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5",
            ),
            (
                "462e20412e20486179656b",
                "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8",
            ),
            (
                "4361726c204d656e676572",
                "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667",
            ),
            (
                "4a65616e2d426170746973746520536179",
                "62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4",
            ),
            (
                "457567656e2042f6686d20766f6e2042617765726b",
                "029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024",
            ),
        ];

        let mut ini = Initiator::new(&init_s, &resp_pub, &prologue);
        let mut resp = Responder::new(&resp_s, &prologue);
        let m1 = ini.write_message_1(&init_e, &h(msgs[0].0)).unwrap();
        assert_eq!(m1, h(msgs[0].1));
        let (p1, rs) = resp.read_message_1(&m1).unwrap();
        assert_eq!(p1, h(msgs[0].0));
        assert_eq!(rs, public_key(&init_s));
        let (m2, mut rt) = resp.write_message_2(&resp_e, &h(msgs[1].0)).unwrap();
        assert_eq!(m2, h(msgs[1].1));
        let (p2, mut it) = ini.read_message_2(&m2).unwrap();
        assert_eq!(p2, h(msgs[1].0));
        assert_eq!(
            it.handshake_hash.to_vec(),
            h("0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7")
        );
        assert_eq!(it.handshake_hash, rt.handshake_hash);
        for (i, (p, c)) in msgs[2..].iter().enumerate() {
            let (from, to) = if i % 2 == 0 {
                (&mut it, &mut rt)
            } else {
                (&mut rt, &mut it)
            };
            let ct = from.seal(&h(p)).unwrap();
            assert_eq!(ct, h(c));
            assert_eq!(to.open(&ct).unwrap(), h(p));
        }
    }

    fn wrong_prologue_or_key_case() {
        let s = [7u8; 32];
        let c = [9u8; 32];
        let mut ini = Initiator::new(&c, &public_key(&s), b"a");
        let m1 = ini.write_message_1(&[3u8; 32], b"hi").unwrap();
        assert!(Responder::new(&s, b"b").read_message_1(&m1).is_err());
        assert!(
            Responder::new(&[8u8; 32], b"a")
                .read_message_1(&m1)
                .is_err()
        );
        assert!(Responder::new(&s, b"a").read_message_1(&m1).is_ok());
    }

    fn limits_case() {
        let s = [7u8; 32];
        let mut ini = Initiator::new(&[9u8; 32], &public_key(&s), b"limit-test");
        let mut resp = Responder::new(&s, b"limit-test");
        let m1 = ini.write_message_1(&[3u8; 32], b"").unwrap();
        resp.read_message_1(&m1).unwrap();
        let (m2, mut rt) = resp.write_message_2(&[4u8; 32], b"").unwrap();
        let (_, mut it) = ini.read_message_2(&m2).unwrap();
        assert_eq!(it.seal(&vec![0; MAX_PLAINTEXT + 1]), Err(NoiseError::Limit));
        assert_eq!(rt.open(&vec![0; MAX_MESSAGE + 1]), Err(NoiseError::Limit));
        let max = vec![0x42; MAX_PLAINTEXT];
        let ct = it.seal(&max).unwrap();
        assert_eq!(ct.len(), MAX_MESSAGE);
        assert_eq!(rt.open(&ct).unwrap(), max);
        let ct = it.seal(b"valid").unwrap();
        let mut bad = ct.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(rt.open(&bad), Err(NoiseError::Decrypt));
        assert_eq!(rt.open(&ct).unwrap(), b"valid");
        it.tx.n = MAX_SESSION_MESSAGES;
        rt.rx.n = MAX_SESSION_MESSAGES;
        assert_eq!(it.seal(b""), Err(NoiseError::Limit));
        assert_eq!(rt.open(&ct), Err(NoiseError::Limit));
    }

    fn weak_key_case() {
        let mut ini = Initiator::new(&[9u8; 32], &[0u8; 32], b"");
        assert_eq!(
            ini.write_message_1(&[3u8; 32], b""),
            Err(NoiseError::WeakKey)
        );
        // A low-order responder ephemeral is refused before any transport exists.
        let mut ini = Initiator::new(&[9; 32], &public_key(&[7; 32]), b"");
        ini.write_message_1(&[3; 32], b"").unwrap();
        assert!(matches!(
            ini.read_message_2(&[0; 48]),
            Err(NoiseError::WeakKey)
        ));
        // Likewise for a responder receiving a low-order initiator ephemeral.
        assert_eq!(
            Responder::new(&[7; 32], b"").read_message_1(&[0; 96]),
            Err(NoiseError::WeakKey)
        );
    }

    #[cfg(feature = "testing")]
    #[test]
    fn testing_transport_keys_are_reciprocal_copies_without_counter_effects() {
        let mut client = Initiator::new(&[9; 32], &public_key(&[7; 32]), b"testing-key-oracle");
        let mut server = Responder::new(&[7; 32], b"testing-key-oracle");
        let m1 = client.write_message_1(&[3; 32], b"").unwrap();
        server.read_message_1(&m1).unwrap();
        let (m2, mut server) = server.write_message_2(&[4; 32], b"").unwrap();
        let (_, mut client) = client.read_message_2(&m2).unwrap();
        let (mut tx, rx) = client.testing_keys().unwrap();
        let (server_tx, server_rx) = server.testing_keys().unwrap();
        assert!(
            tx == server_rx && rx == server_tx,
            "directional keys must be reciprocal"
        );
        assert!(tx != rx, "directions must use different keys");
        tx[0] ^= 1;
        let (unchanged, _) = client.testing_keys().unwrap();
        assert!(
            unchanged != tx && unchanged == server_rx,
            "getter returns independent copies"
        );
        assert!(client.tx.n == 0 && client.rx.n == 0 && server.tx.n == 0 && server.rx.n == 0);
        let ct = client.seal(b"first").unwrap();
        assert_eq!(server.open(&ct).unwrap(), b"first");
        assert!(client.tx.n == 1 && server.rx.n == 1);
        let (still_same, _) = client.testing_keys().unwrap();
        assert!(
            still_same == unchanged,
            "getter must not reset or replace a cipher key"
        );
        let ct = client.seal(b"second").unwrap();
        assert_eq!(server.open(&ct).unwrap(), b"second");
        assert!(client.tx.n == 2 && server.rx.n == 2);
        assert!(
            Transport {
                tx: CipherState::empty(),
                rx: CipherState::empty(),
                handshake_hash: [0; 32],
                remote_static: [0; 32]
            }
            .testing_keys()
            .is_none()
        );
    }

    #[test]
    fn cacophony_ik_vector() {
        cacophony_case();
    }

    #[test]
    fn wrong_prologue_or_key_fails() {
        wrong_prologue_or_key_case();
    }

    #[test]
    fn message_and_session_limits_and_tamper_preserve_receive_nonce() {
        limits_case();
    }

    #[test]
    fn all_zero_remote_static_is_refused() {
        weak_key_case();
    }

    // Test-only raw ABI: `cargo rustc --lib --crate-type cdylib --target
    // wasm32-unknown-unknown -- --cfg test`. No test entropy or ABI in production.
    // A failed assertion traps; success returns 1. Native tests call the SAME
    // cases, including the pinned transcript bytes/hash and private nonce budget.
    #[cfg(target_family = "wasm")]
    // Linkage-only exception on the test ABI; no unsafe operations. Production
    // retains the workspace deny and has neither this symbol nor test fixtures.
    #[allow(unsafe_code)]
    #[unsafe(no_mangle)]
    pub extern "C" fn noise_conformance(case: u32) -> u32 {
        match case {
            0 => cacophony_case(),
            1 => wrong_prologue_or_key_case(),
            2 => limits_case(),
            3 => weak_key_case(),
            _ => return 0,
        }
        1
    }
}
