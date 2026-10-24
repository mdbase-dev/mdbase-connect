//! Collection keys, epochs and rotation (`sealed-envelope.md` §5), and the keyed
//! identifiers derived from them: idempotency tokens (`log-entry.md` §7) and
//! ephemeral stream IDs (`log-service-api.md` §8.1).

use std::collections::BTreeMap;

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Bytes, Uuid};
use mdbn_wire::envelope::{KeyGrantPayload, KeyWrap, RekeyPayload, RekeyReason, SealedBox};
use zeroize::Zeroizing;

use super::hpke::{self, KemKeyPair};
use super::seal::{open_with_salt, seal_with_salt};
use super::{CryptoError, CsprngEntropy, Secret32, ct_eq, hkdf32, mac, mac_parts};

/// A collection key of one epoch (32 random bytes).
pub type EpochKey = Secret32;

/// The epoch keys this replica holds, by epoch.
#[derive(Debug, Clone, Default)]
pub struct Keyring {
    keys: BTreeMap<u64, Secret32>,
}

impl Keyring {
    /// An empty keyring.
    pub fn new() -> Keyring {
        Keyring::default()
    }

    /// The key of `epoch`.
    pub fn get(&self, epoch: u64) -> Option<&Secret32> {
        self.keys.get(&epoch)
    }

    /// Add or replace a key.
    pub fn insert(&mut self, epoch: u64, key: Secret32) {
        self.keys.insert(epoch, key);
    }

    /// The highest epoch held.
    pub fn latest(&self) -> Option<(u64, &Secret32)> {
        self.keys.iter().next_back().map(|(e, k)| (*e, k))
    }

    /// Every `(epoch, key)` in epoch order.
    pub fn iter(&self) -> impl Iterator<Item = (u64, &Secret32)> {
        self.keys.iter().map(|(e, k)| (*e, k))
    }

    /// Serialize for the store (secret: the store protects it).
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        encode_history(self.keys.iter().map(|(e, k)| (*e, k)))
    }

    /// Parse [`Keyring::to_bytes`].
    pub fn from_bytes(b: &[u8]) -> Result<Keyring, CryptoError> {
        let mut k = Keyring::new();
        for (e, key) in decode_history(b)? {
            k.insert(e, key);
        }
        Ok(k)
    }
}

fn encode_history<'a>(it: impl Iterator<Item = (u64, &'a Secret32)>) -> Zeroizing<Vec<u8>> {
    let c = Cbor::Array(
        it.map(|(e, k)| Cbor::Array(vec![Cbor::Uint(e), Cbor::Bytes(k.expose().to_vec())]))
            .collect(),
    );
    let out = Zeroizing::new(cbor::encode(&c).unwrap_or_default());
    // The Cbor tree holds key copies; scrub them.
    if let Cbor::Array(mut items) = c {
        for i in &mut items {
            if let Cbor::Array(pair) = i
                && let Some(Cbor::Bytes(b)) = pair.get_mut(1)
            {
                zeroize::Zeroize::zeroize(b);
            }
        }
    }
    out
}

fn decode_history(b: &[u8]) -> Result<Vec<(u64, Secret32)>, CryptoError> {
    let c = cbor::decode(b).map_err(|_| CryptoError::Open)?;
    let Cbor::Array(items) = c else {
        return Err(CryptoError::Open);
    };
    let mut out = Vec::with_capacity(items.len());
    for i in items {
        match i {
            Cbor::Array(mut pair) if pair.len() == 2 => {
                let (first, second) = pair.split_at_mut(1);
                let (Cbor::Uint(e), Cbor::Bytes(k)) = (&first[0], &mut second[0]) else {
                    return Err(CryptoError::Open);
                };
                let arr: Result<[u8; 32], _> = k.as_slice().try_into();
                zeroize::Zeroize::zeroize(k);
                let arr = arr.map_err(|_| CryptoError::Open)?;
                out.push((*e, Secret32(arr)));
            }
            _ => return Err(CryptoError::Open),
        }
    }
    Ok(out)
}

/// `u32be(epoch)`. Epochs are `u32` on the wire inside these inputs; a larger
/// epoch is rejected rather than truncated.
fn epoch32(epoch: u64) -> Result<[u8; 4], CryptoError> {
    u32::try_from(epoch)
        .map(u32::to_be_bytes)
        .map_err(|_| CryptoError::Key)
}

/// `info` of an epoch key wrap: `"mdbase/v1/key-wrap" ‖ collection ‖ u32be(epoch) ‖ recipient`.
pub fn wrap_info(collection: &Uuid, epoch: u64, recipient: &Uuid) -> Result<Vec<u8>, CryptoError> {
    let mut v = b"mdbase/v1/key-wrap".to_vec();
    v.extend_from_slice(&collection.0);
    v.extend_from_slice(&epoch32(epoch)?);
    v.extend_from_slice(&recipient.0);
    Ok(v)
}

/// Wrap an epoch key for one device's KEM public key (HPKE base mode, empty AAD).
pub fn wrap_key(
    key: &Secret32,
    collection: &Uuid,
    epoch: u64,
    recipient: &Uuid,
    recipient_kem_pk: &[u8; 32],
    entropy: &mut dyn CsprngEntropy,
) -> Result<KeyWrap, CryptoError> {
    let info = wrap_info(collection, epoch, recipient)?;
    let (enc, ct) = hpke::seal(recipient_kem_pk, &info, b"", key.expose(), entropy)?;
    Ok(KeyWrap {
        device: *recipient,
        enc: B32(enc),
        ct: Bytes(ct),
    })
}

/// Unwrap an epoch key addressed to this device.
pub fn unwrap_key(
    wrap: &KeyWrap,
    collection: &Uuid,
    epoch: u64,
    kem: &KemKeyPair,
) -> Result<Secret32, CryptoError> {
    let info = wrap_info(collection, epoch, &wrap.device)?;
    let pt = hpke::open(kem, &wrap.enc.0, &info, b"", &wrap.ct.0)?;
    let arr: [u8; 32] = pt.as_slice().try_into().map_err(|_| CryptoError::Open)?;
    Ok(Secret32(arr))
}

/// The epoch key commitment (`sealed-envelope.md` §5.2):
///
/// ```text
/// K_kc   = HKDF-SHA256(ikm = K_new, salt = collection, info = "mdbase/v1/key-commit")
/// commit = MAC(K_kc, "mdbase/v1/key-commit", collection ‖ u32be(epoch))
/// ```
pub fn key_commit(key: &Secret32, collection: &Uuid, epoch: u64) -> Result<[u8; 32], CryptoError> {
    let k = hkdf32(key.expose(), &collection.0, b"mdbase/v1/key-commit");
    Ok(mac_parts(
        k.expose(),
        "mdbase/v1/key-commit",
        &[&collection.0, &epoch32(epoch)?],
    ))
}

/// Check, in constant time, that `key` is the key the epoch's `rekey` committed to.
/// Every key obtained from a `key_grant`, a history box or a recovery must pass
/// this before use; otherwise it is `key_inconsistent`.
pub fn check_commit(
    key: &Secret32,
    collection: &Uuid,
    epoch: u64,
    commit: &B32,
) -> Result<(), CryptoError> {
    if ct_eq(&key_commit(key, collection, epoch)?, &commit.0) {
        Ok(())
    } else {
        Err(CryptoError::KeyInconsistent)
    }
}

fn history_aad(collection: &Uuid, epoch: u64) -> Result<Vec<u8>, CryptoError> {
    let mut v = b"mdbase/v1/key-history".to_vec();
    v.extend_from_slice(&collection.0);
    v.extend_from_slice(&epoch32(epoch)?);
    Ok(v)
}

/// Seal the key history `[[epoch, key], …]` under the new epoch's key.
pub fn seal_history(
    new_key: &Secret32,
    collection: &Uuid,
    epoch: u64,
    history: &Keyring,
    entropy: &mut dyn CsprngEntropy,
) -> Result<SealedBox, CryptoError> {
    let mut salt = [0u8; 16];
    entropy.fill(&mut salt);
    let plain = encode_history(history.iter().filter(|(e, _)| *e < epoch));
    let ct = seal_with_salt(
        new_key.expose(),
        &salt,
        &history_aad(collection, epoch)?,
        &plain,
        false,
    )?;
    Ok(SealedBox {
        salt: B16(salt),
        ct: Bytes(ct),
    })
}

/// An epoch key from a history box, not yet checked against the commitment of
/// the `rekey` that created its epoch. The only way to use it is
/// [`Unverified::verify`].
pub struct Unverified {
    epoch: u64,
    key: Secret32,
}

impl std::fmt::Debug for Unverified {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Unverified(epoch {})", self.epoch)
    }
}

impl Unverified {
    /// The epoch this key claims to be.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Check against `commit` (of the rekey that created this epoch) and release
    /// the key; a mismatch is [`CryptoError::KeyInconsistent`].
    pub fn verify(self, collection: &Uuid, commit: &B32) -> Result<(u64, Secret32), CryptoError> {
        check_commit(&self.key, collection, self.epoch, commit)?;
        Ok((self.epoch, self.key))
    }
}

/// Open a key history box. The keys come back [`Unverified`].
pub fn open_history(
    new_key: &Secret32,
    collection: &Uuid,
    epoch: u64,
    b: &SealedBox,
) -> Result<Vec<Unverified>, CryptoError> {
    let plain = Zeroizing::new(open_with_salt(
        new_key.expose(),
        &b.salt.0,
        &history_aad(collection, epoch)?,
        &b.ct.0,
    )?);
    Ok(decode_history(&plain)?
        .into_iter()
        .map(|(epoch, key)| Unverified { epoch, key })
        .collect())
}

/// Verify every history key against the commitments of the rekeys that created
/// their epochs (control items are never compacted, so a replica knows them all).
/// A missing commitment or any mismatch is [`CryptoError::KeyInconsistent`], and
/// no key is released.
pub fn verify_history(
    history: Vec<Unverified>,
    collection: &Uuid,
    commits: &BTreeMap<u64, B32>,
) -> Result<Vec<(u64, Secret32)>, CryptoError> {
    let mut out = Vec::with_capacity(history.len());
    let mut ok = true;
    for u in history {
        match commits.get(&u.epoch) {
            Some(c) => match u.verify(collection, c) {
                Ok(k) => out.push(k),
                Err(_) => ok = false,
            },
            None => ok = false,
        }
    }
    if ok {
        Ok(out)
    } else {
        Err(CryptoError::KeyInconsistent)
    }
}

/// A recipient of a rekey: device ID and its enrolled KEM public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Recipient {
    /// Device ID.
    pub device: Uuid,
    /// `kem_pk`.
    pub kem_pk: [u8; 32],
}

/// Build a `rekey` payload: a fresh epoch key from the injected entropy, one wrap
/// per recipient (sorted by device ID; the caller passes **exactly** the devices
/// policy requires, `sealed-envelope.md` §5.2), the commitment and the history box
/// of `held` (every epoch `< from + 1`). Returns the payload and the new key.
pub fn build_rekey(
    collection: &Uuid,
    from: u64,
    held: &Keyring,
    recipients: &[Recipient],
    reason: RekeyReason,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(RekeyPayload, Secret32), CryptoError> {
    let epoch = from + 1;
    let key = Secret32::random(entropy);
    let mut rs = recipients.to_vec();
    rs.sort_by_key(|r| r.device);
    rs.dedup_by_key(|r| r.device);
    let mut wraps = Vec::with_capacity(rs.len());
    for r in &rs {
        wraps.push(wrap_key(
            &key, collection, epoch, &r.device, &r.kem_pk, entropy,
        )?);
    }
    let history = seal_history(&key, collection, epoch, held, entropy)?;
    Ok((
        RekeyPayload {
            epoch,
            from,
            commit: B32(key_commit(&key, collection, epoch)?),
            wraps,
            history,
            reason,
        },
        key,
    ))
}

/// What opening a `rekey` gave this device.
#[derive(Debug)]
pub enum RekeyOpened {
    /// This device is not among the recipients.
    NotARecipient,
    /// The new key, and every older epoch from the history box.
    Keys {
        /// The new epoch key.
        key: Secret32,
        /// Older epochs, to verify against their rekeys' commitments.
        history: Vec<Unverified>,
    },
    /// The unwrapped key does not match the commitment: `key_inconsistent`.
    Inconsistent,
}

/// Open a `rekey` as `device`: unwrap, check the commitment in constant time, open
/// the history box.
pub fn open_rekey(
    p: &RekeyPayload,
    collection: &Uuid,
    device: &Uuid,
    kem: &KemKeyPair,
) -> Result<RekeyOpened, CryptoError> {
    let Some(w) = p.wraps.iter().find(|w| w.device == *device) else {
        return Ok(RekeyOpened::NotARecipient);
    };
    let key = unwrap_key(w, collection, p.epoch, kem)?;
    if check_commit(&key, collection, p.epoch, &p.commit).is_err() {
        return Ok(RekeyOpened::Inconsistent);
    }
    let history = if p.from == 0 {
        Vec::new()
    } else {
        open_history(&key, collection, p.epoch, &p.history)?
    };
    Ok(RekeyOpened::Keys { key, history })
}

/// Build a `key_grant` for a newly enrolled device.
pub fn build_key_grant(
    collection: &Uuid,
    epoch: u64,
    key: &Secret32,
    recipient: &Recipient,
    entropy: &mut dyn CsprngEntropy,
) -> Result<KeyGrantPayload, CryptoError> {
    Ok(KeyGrantPayload {
        recipient: recipient.device,
        epoch,
        wrap: wrap_key(
            key,
            collection,
            epoch,
            &recipient.device,
            &recipient.kem_pk,
            entropy,
        )?,
    })
}

/// Open a `key_grant` addressed to this device and check the key against
/// `epoch_commit`, the `commit` of the `rekey` that created that epoch.
/// A mismatch is [`CryptoError::KeyInconsistent`].
pub fn open_key_grant(
    p: &KeyGrantPayload,
    collection: &Uuid,
    kem: &KemKeyPair,
    epoch_commit: &B32,
) -> Result<Secret32, CryptoError> {
    if p.wrap.device != p.recipient {
        return Err(CryptoError::Open);
    }
    let key = unwrap_key(&p.wrap, collection, p.epoch, kem)?;
    check_commit(&key, collection, p.epoch, epoch_commit)?;
    Ok(key)
}

/// A device's public keys as enrolled (`policy.md` `device-enrol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnrolledKeys {
    /// Device ID.
    pub device: Uuid,
    /// Ed25519 `sign_pk`.
    pub sign_pk: [u8; 32],
    /// X25519 `kem_pk`.
    pub kem_pk: [u8; 32],
    /// X25519 `noise_pk`.
    pub noise_pk: [u8; 32],
}

/// `sas_commit = H("mdbase/v1/sas-commit", collection ‖ N ‖ sign_pk_N ‖ kem_pk_N ‖ noise_pk_N ‖ r_N)`
/// (`sealed-envelope.md` §5.3 step 1).
pub fn sas_commit(collection: &Uuid, n: &EnrolledKeys, r_n: &[u8; 32]) -> [u8; 32] {
    let mut m = collection.0.to_vec();
    m.extend_from_slice(&n.device.0);
    m.extend_from_slice(&n.sign_pk);
    m.extend_from_slice(&n.kem_pk);
    m.extend_from_slice(&n.noise_pk);
    m.extend_from_slice(r_n);
    mdbn_wire::hash::h("mdbase/v1/sas-commit", &m).0
}

/// The full 32-byte approval fingerprint
/// `H("mdbase/v1/sas", collection ‖ A ‖ N ‖ sign_pk_A ‖ sign_pk_N ‖ kem_pk_N ‖ noise_pk_N ‖ r_A ‖ r_N)`
/// (step 4; the QR alternative shows all of it).
pub fn sas_fingerprint(
    collection: &Uuid,
    a: &EnrolledKeys,
    n: &EnrolledKeys,
    r_a: &[u8; 32],
    r_n: &[u8; 32],
) -> [u8; 32] {
    let mut m = collection.0.to_vec();
    m.extend_from_slice(&a.device.0);
    m.extend_from_slice(&n.device.0);
    m.extend_from_slice(&a.sign_pk);
    m.extend_from_slice(&n.sign_pk);
    m.extend_from_slice(&n.kem_pk);
    m.extend_from_slice(&n.noise_pk);
    m.extend_from_slice(r_a);
    m.extend_from_slice(r_n);
    mdbn_wire::hash::h("mdbase/v1/sas", &m).0
}

/// The six-digit code both devices show: `u32be(first 4 bytes of the fingerprint) mod 10^6`.
pub fn sas_code(
    collection: &Uuid,
    a: &EnrolledKeys,
    n: &EnrolledKeys,
    r_a: &[u8; 32],
    r_n: &[u8; 32],
) -> String {
    let d = sas_fingerprint(collection, a, n, r_a, r_n);
    let v = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{v:06}")
}

/// Compare a code the user typed with the expected one, in constant time.
pub fn sas_matches(expected: &str, typed: &str) -> bool {
    let t: String = typed.chars().filter(|c| c.is_ascii_digit()).collect();
    ct_eq(expected.as_bytes(), t.as_bytes())
}

/// The new device's side of the approval (`N`): commit, then reveal `r_N` at most
/// once (§5.3 step 3). After a reveal it refuses every further challenge until the
/// caller makes a fresh commitment (`approval-request`).
pub struct SasCommitter {
    r_n: Secret32,
    commit: [u8; 32],
    revealed: bool,
}

impl std::fmt::Debug for SasCommitter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SasCommitter")
            .field("commit", &mdbn_wire::render::hex(&self.commit))
            .field("revealed", &self.revealed)
            .finish_non_exhaustive()
    }
}

/// What the new device does with a challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reveal {
    /// Persist `state` **before** sending `r_N` to the approver, then show `code`.
    /// (Persisting first keeps the reveal-once rule across a crash.)
    Reveal {
        /// `r_N`.
        r_n: [u8; 32],
        /// The code to show.
        code: String,
        /// The committer's new persisted state (marked revealed).
        state: Zeroizing<Vec<u8>>,
    },
    /// `r_N` was already revealed: refuse, and commit afresh (`approval-request`).
    AlreadyRevealed,
}

impl SasCommitter {
    /// Draw `r_N` from the CSPRNG and compute the commitment for `N`'s enrolment.
    pub fn new(
        collection: &Uuid,
        me: &EnrolledKeys,
        entropy: &mut dyn CsprngEntropy,
    ) -> SasCommitter {
        let r_n = Secret32::random(entropy);
        let commit = sas_commit(collection, me, r_n.expose());
        SasCommitter {
            r_n,
            commit,
            revealed: false,
        }
    }

    /// Persisted form, `r_N ‖ revealed` (33 bytes; the same layout as the TS
    /// runtime). Secret until revealed: store it with the device secrets.
    pub fn state(&self) -> Zeroizing<Vec<u8>> {
        let mut v = Zeroizing::new(self.r_n.expose().to_vec());
        v.push(u8::from(self.revealed));
        v
    }

    /// Restore from [`SasCommitter::state`] after a restart.
    pub fn restore(
        collection: &Uuid,
        me: &EnrolledKeys,
        state: &[u8],
    ) -> Result<SasCommitter, CryptoError> {
        if state.len() != 33 || state[32] > 1 {
            return Err(CryptoError::Encoding);
        }
        let mut r = [0u8; 32];
        r.copy_from_slice(&state[..32]);
        let r_n = Secret32(r);
        zeroize::Zeroize::zeroize(&mut r);
        Ok(SasCommitter {
            commit: sas_commit(collection, me, r_n.expose()),
            r_n,
            revealed: state[32] == 1,
        })
    }

    /// Whether `r_N` has been revealed (a retry needs a fresh commitment).
    pub fn is_revealed(&self) -> bool {
        self.revealed
    }

    /// The commitment (`device-enrol` key 7, or an `approval-request`).
    pub fn commitment(&self) -> [u8; 32] {
        self.commit
    }

    /// Whether `N`'s enrol item (or latest `approval-request`) in the log carries
    /// exactly this commitment. If not, show no code (a control plane substituted it).
    pub fn check_logged(&self, logged: &[u8; 32]) -> bool {
        ct_eq(&self.commit, logged)
    }

    /// Answer the first accepted challenge `r_A` from approver `a`.
    pub fn reveal(
        &mut self,
        collection: &Uuid,
        a: &EnrolledKeys,
        me: &EnrolledKeys,
        r_a: &[u8; 32],
    ) -> Reveal {
        if self.revealed {
            return Reveal::AlreadyRevealed;
        }
        self.revealed = true;
        Reveal::Reveal {
            r_n: *self.r_n.expose(),
            code: sas_code(collection, a, me, r_a, self.r_n.expose()),
            state: self.state(),
        }
    }
}

/// The approver's side (`A`) for one commitment: draw `r_A` only after seeing the
/// commitment in its own view of the log; check the revealed `r_N`; at most 3
/// failed attempts per commitment.
pub struct SasApprover {
    commit: [u8; 32],
    r_a: Option<Secret32>,
    failures: u8,
}

impl std::fmt::Debug for SasApprover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SasApprover")
            .field("failures", &self.failures)
            .finish_non_exhaustive()
    }
}

/// Maximum failed attempts per commitment.
pub const SAS_MAX_FAILURES: u8 = 3;

impl SasApprover {
    /// Start from the latest commitment in this device's view of the log.
    pub fn new(logged_commit: [u8; 32]) -> SasApprover {
        SasApprover {
            commit: logged_commit,
            r_a: None,
            failures: 0,
        }
    }

    /// Draw the challenge `r_A`. `None` once the attempts are exhausted.
    pub fn challenge(&mut self, entropy: &mut dyn CsprngEntropy) -> Option<[u8; 32]> {
        if self.failures >= SAS_MAX_FAILURES {
            return None;
        }
        let r = Secret32::random(entropy);
        let out = *r.expose();
        self.r_a = Some(r);
        Some(out)
    }

    /// Check the revealed `r_N` against the commitment; on success return the code
    /// to show. A mismatch counts as a failed attempt and needs a new challenge.
    pub fn on_reveal(
        &mut self,
        collection: &Uuid,
        me: &EnrolledKeys,
        n: &EnrolledKeys,
        r_n: &[u8; 32],
    ) -> Option<String> {
        let r_a = self.r_a.take()?;
        if !ct_eq(&sas_commit(collection, n, r_n), &self.commit) {
            self.failures = self.failures.saturating_add(1);
            return None;
        }
        Some(sas_code(collection, me, n, r_a.expose(), r_n))
    }

    /// Record that the user saw different codes (a failed attempt).
    pub fn mismatch(&mut self) {
        self.failures = self.failures.saturating_add(1);
    }

    /// Whether this commitment is exhausted (the new device must commit afresh).
    pub fn exhausted(&self) -> bool {
        self.failures >= SAS_MAX_FAILURES
    }
}

/// `K_idem = HKDF-SHA256(ikm = K_epoch1, salt = collection_id, info = "mdbase/v1/idem")`.
pub fn idem_key(epoch1: &Secret32, collection: &Uuid) -> Secret32 {
    hkdf32(epoch1.expose(), &collection.0, b"mdbase/v1/idem")
}

/// The idempotency token of a mutation: first 16 bytes of `MAC(K_idem, "mdbase/v1/idem", id)`.
pub fn idem_token(k_idem: &Secret32, mutation: &Uuid) -> B16 {
    let m = mac(k_idem.expose(), "mdbase/v1/idem", &mutation.0);
    let mut t = [0u8; 16];
    t.copy_from_slice(&m[..16]);
    B16(t)
}

/// Purpose of an ephemeral stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPurpose {
    /// Presence.
    Presence = 1,
    /// A live room.
    Room = 2,
    /// Head witnesses (`log-entry.md` §11).
    HeadWitness = 3,
}

/// An ephemeral stream ID (`log-service-api.md` §8.1).
pub fn stream_id(
    epoch_key: &Secret32,
    collection: &Uuid,
    purpose: StreamPurpose,
    record: &Uuid,
) -> B16 {
    let k = hkdf32(epoch_key.expose(), &collection.0, b"mdbase/v1/stream-id");
    let m = mac_parts(
        k.expose(),
        "mdbase/v1/stream-id",
        &[&[purpose as u8], &record.0],
    );
    let mut t = [0u8; 16];
    t.copy_from_slice(&m[..16]);
    B16(t)
}
