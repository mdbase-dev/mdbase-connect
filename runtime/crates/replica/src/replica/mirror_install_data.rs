//! Charged borrowed envelope data and plaintext, not installation authority.
//!
//! Input, parsed metadata and every retained output share one attempt ledger.
//! Prospective work is charged before helper execution; failed operations never
//! refund work. This module has no Store, transport, cleanup or runtime caller.

use mdbn_wire::{common::B32, snapshot::BaseSource};
use zeroize::Zeroizing;

use crate::{
    crypto::{CryptoError, raw, seal::SEGMENT, seal::SEGMENT_CT, sign::Ed25519Verifier},
    mirror_install_budget::{self as budget, Buffer, Charge, Work, WorkingSet},
    policy::{Env, PolicyState, Rejected},
    seal::{KeyringSealer, OpenError, Sealer},
};

/// A resource refusal or the unchanged underlying decode/policy/open error.
#[derive(Debug)]
pub enum Error {
    /// The source belongs to another accounting ledger, not another collection.
    ForeignAccount,
    /// Admission failed before the refused helper's work or allocation.
    Budget(budget::Error),
    /// Strict envelope decode failed with the existing raw codec mapping.
    Decode(CryptoError),
    /// The existing policy predicate refused; no policy is mutated here.
    Policy(PolicyRefusal),
    /// Missing held key or the existing opaque cryptographic opening failure.
    Open(OpenError),
}
/// A retained policy rejection whose diagnostic allocation remains charged.
/// These selected predicates emit only fixed, short diagnostic strings; their
/// 256-byte peak is reserved before calling them, never after an error escapes.
#[derive(Debug)]
pub struct PolicyRefusal {
    rejection: Rejected,
    _charge: Charge,
}
impl PolicyRefusal {
    /// Borrow the original ordered rejection without extracting its allocation.
    pub fn rejection(&self) -> &Rejected {
        &self.rejection
    }
}
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::ForeignAccount, Self::ForeignAccount) => true,
            (Self::Budget(a), Self::Budget(b)) => a == b,
            (Self::Decode(a), Self::Decode(b)) => a == b,
            (Self::Policy(a), Self::Policy(b)) => a.rejection == b.rejection,
            (Self::Open(a), Self::Open(b)) => a == b,
            _ => false,
        }
    }
}
impl Eq for Error {}
impl From<budget::Error> for Error {
    fn from(error: budget::Error) -> Self {
        Self::Budget(error)
    }
}

// Costs are deterministic conservative pass-byte/node counters, not estimates
// of CPU instructions or wall time. Saturating prospective arithmetic refuses
// through the ledger's finite ceiling and permanently invalidates that attempt.
// N is the charged source CAPACITY. At most N CBOR nodes can occur in N bytes.
// Decode includes both planners, workspace initialization/copy/wipe, strict
// decode/schema lookups, metadata copies, key comparisons and failure cleanup.
// 128 byte passes conservatively cover the pinned depth/key-comparison paths;
// four N node visits cover repeated planning/decoding. No plaintext CBOR decoder
// or control/proof walker is called here.
fn decode_work(capacity: usize) -> Work {
    let n = capacity as u64;
    Work {
        pass_bytes: n.saturating_mul(128).saturating_add(4096),
        decoded_nodes: n.saturating_mul(4),
        ..Work::default()
    }
}
fn policy_work(capacity: usize, signature: bool) -> Work {
    Work {
        // Two typed traversals, body hashing, refs/scalar checks and fixed digest
        // framing. Every repeated call pays again, including failed predicates.
        pass_bytes: (capacity as u64).saturating_mul(4).saturating_add(4096),
        // The typed signature digest recursively parses the received map twice.
        // Source/ref predicates use parsed fields and do not call a CBOR walker.
        decoded_nodes: if signature {
            (capacity as u64).saturating_mul(2)
        } else {
            0
        },
        verifications: if signature { 2 } else { 1 },
        ..Work::default()
    }
}
fn open_work(capacity: usize, body_bytes: usize, max_plain: usize) -> Work {
    let n = capacity as u64;
    let segments = body_bytes.div_ceil(SEGMENT_CT) as u64;
    let padded = segments.saturating_mul(SEGMENT as u64);
    Work {
        // Five received-map walks (external/internal plan and AAD filling), AAD
        // initialization/copy/wipe; AAD authentication PER SEGMENT with padding;
        // ciphertext/decrypted temporary/padded-frame scans, copies and wipes;
        // bounded inflate/output initialization, growth overlap and output wipe;
        // fixed HKDF/frame/inflate-control work. AAD length is at most N.
        pass_bytes: n
            .saturating_mul(16)
            .saturating_add(
                segments
                    .saturating_mul(n.saturating_add(16))
                    .saturating_mul(2),
            )
            .saturating_add(padded.saturating_mul(16))
            .saturating_add((max_plain.max(8) as u64).saturating_mul(16))
            .saturating_add(64 * 1024 + 4096),
        // External/internal planning and AAD filling recursively parse five
        // received maps. Charge every possible encoded node on every walk.
        decoded_nodes: n.saturating_mul(5),
        ..Work::default()
    }
}
fn policy_result(result: Result<(), Rejected>, charge: Charge) -> Result<(), Error> {
    result.map_err(|rejection| {
        Error::Policy(PolicyRefusal {
            rejection,
            _charge: charge,
        })
    })
}
fn workspace(bytes: usize) -> Result<Zeroizing<Vec<u8>>, Error> {
    let mut out = Zeroizing::new(Vec::new());
    out.try_reserve_exact(bytes)
        .map_err(|_| Error::Budget(budget::Error::Allocation))?;
    if out.capacity() != bytes {
        return Err(Error::Budget(budget::Error::Allocation));
    }
    out.resize(bytes, 0);
    Ok(out)
}

/// Parsed DATA borrowing a charged immutable source. Not a signature, key,
/// currentness, source-closure or installation capability. No owned Item or
/// unchecked receipt constructor is exposed.
///
/// ```compile_fail,E0597
/// use mdbn_replica::{mirror_install_budget::WorkingSet, mirror_install_data::Envelope};
/// let budget = WorkingSet::default();
/// let receipt;
/// {
///     let input = budget.buffer(1).unwrap();
///     receipt = Envelope::decode(&budget, &input).unwrap();
/// }
/// let _ = receipt.received_digest();
/// ```
pub struct Envelope<'a> {
    // Allocation-owning fields drop before their lease; source remains borrowed.
    data: raw::BorrowedEnvelope<'a>,
    _workspace: Zeroizing<Vec<u8>>,
    _metadata_charge: Charge,
    input: &'a Buffer,
    ledger: WorkingSet,
}
impl std::fmt::Debug for Envelope<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChargedEnvelope")
            .field("source_capacity", &self.input.capacity())
            .finish_non_exhaustive()
    }
}
impl<'a> Envelope<'a> {
    /// Verify accounting identity, precharge complete prospective decoder work,
    /// then reserve the full decoder peak before workspace allocation/decoding.
    /// Transport/body initialization must already be admitted by the receiver;
    /// this API does not retroactively qualify those external operations.
    pub fn decode(ledger: &WorkingSet, input: &'a Buffer) -> Result<Self, Error> {
        if !ledger.owns_buffer(input) {
            return Err(Error::ForeignAccount);
        }
        ledger.precharge_candidate(decode_work(input.capacity()))?;
        let plan = raw::envelope_workspace_plan(input.as_slice()).map_err(Error::Decode)?;
        let charge = ledger.reserve(plan.decoder_peak_bytes() as u64)?;
        let mut space = workspace(plan.metadata_bytes())?;
        let data =
            raw::decode_envelope_borrowed(input.as_slice(), &mut space, plan.decoder_peak_bytes())
                .map_err(Error::Decode)?;
        Ok(Self {
            data,
            _workspace: space,
            _metadata_charge: charge,
            input,
            ledger: ledger.clone(),
        })
    }
    /// Digest of exact received bytes, not the typed known-field policy digest.
    /// Every call precharges both traversals and hashing; no signature verdict.
    pub fn received_digest(&self) -> Result<[u8; 32], Error> {
        self.ledger.precharge(Work {
            pass_bytes: (self.input.capacity() as u64)
                .saturating_mul(4)
                .saturating_add(4096),
            decoded_nodes: (self.input.capacity() as u64).saturating_mul(2),
            ..Work::default()
        })?;
        raw::signed_digest_from_bytes_borrowed(self.data.received()).map_err(Error::Decode)
    }
    /// Existing base-header ordering and typed signature semantics, using real
    /// Ed25519 verification. Policy is caller DATA, not authenticated lineage.
    /// No state clone, fake verifier, mutation or continuing permit is created.
    pub fn check_base_header(&self, policy: &PolicyState) -> Result<(), Error> {
        self.ledger
            .precharge(policy_work(self.input.capacity(), true))?;
        let charge = self.ledger.reserve(256)?;
        let result = policy.check_base_header_borrowed(
            &self.data,
            &Env {
                verifier: &Ed25519Verifier,
                trusted_roots: &[],
                policy_pins: None,
            },
        );
        policy_result(result, charge)
    }
    /// Existing source predicate only; not a header or authenticated-source proof.
    pub fn check_base_source(&self, policy: &PolicyState, source: BaseSource) -> Result<(), Error> {
        self.ledger
            .precharge(policy_work(self.input.capacity(), false))?;
        let charge = self.ledger.reserve(256)?;
        policy_result(
            policy.check_base_source_borrowed(&self.data, source),
            charge,
        )
    }
    /// Existing manifest-ref predicate only; not complete reference closure.
    pub fn check_base_payload(&self, policy: &PolicyState, manifest: &B32) -> Result<(), Error> {
        self.ledger
            .precharge(policy_work(self.input.capacity(), false))?;
        let charge = self.ledger.reserve(256)?;
        policy_result(
            policy.check_base_payload_borrowed(&self.data, manifest),
            charge,
        )
    }
    pub(crate) fn precharge_key_lookup(&self) -> Result<(), Error> {
        self.ledger.precharge(Work {
            pass_bytes: 4096,
            ..Work::default()
        })?;
        Ok(())
    }
    pub(crate) fn borrowed(&self) -> &raw::BorrowedEnvelope<'a> {
        &self.data
    }
    // Only the concrete held-key sealer calls this, AFTER its epoch/key lookup.
    // The actual opening call below repeats that lookup; no permit is retained.
    pub(crate) fn open_after_key_check<'b>(
        &'b self,
        sealer: &KeyringSealer,
        max_plain: usize,
    ) -> Result<Plaintext<'b>, Error> {
        self.ledger.precharge(open_work(
            self.input.capacity(),
            self.data.body().len(),
            max_plain,
        ))?;
        let plan = raw::open_workspace_plan(&self.data, max_plain)
            .map_err(|_| Error::Open(OpenError::Aead))?;
        let charge = self.ledger.reserve(plan.peak_bytes() as u64)?;
        let mut aad = workspace(plan.aad_bytes())?;
        let plain = sealer
            .open_bounded_borrowed(&self.data, &mut aad, max_plain, plan.peak_bytes())
            .map_err(Error::Open)?;
        Ok(Plaintext {
            body: Zeroizing::new(plain),
            _crypto_charge: charge,
            _receipt: self,
        })
    }
}

/// Non-extractable plaintext. Its full conservative crypto lease outlives every
/// borrow; input and metadata leases remain live because the receipt is borrowed.
/// No grow/clone/Vec conversion, publication or persistence callback is offered.
///
/// ```compile_fail,E0597
/// use mdbn_replica::{mirror_install_budget::WorkingSet, mirror_install_data::Envelope,
///     seal::KeyringSealer};
/// use mdbn_wire::common::B16;
/// let budget = WorkingSet::default();
/// let input = budget.buffer(1).unwrap();
/// let sealer = KeyringSealer::new(B16([1; 16]), B16([2; 16]), &[3; 32], &[4; 32]);
/// let output;
/// {
///     let receipt = Envelope::decode(&budget, &input).unwrap();
///     output = sealer.open_charged_borrowed(&receipt, 1).unwrap();
/// }
/// let _ = output.as_slice();
/// ```
pub struct Plaintext<'a> {
    body: Zeroizing<Vec<u8>>,
    _crypto_charge: Charge,
    _receipt: &'a Envelope<'a>,
}
impl std::fmt::Debug for Plaintext<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChargedPlaintext")
            .field("bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}
impl Plaintext<'_> {
    /// Borrow bytes only while the plaintext and all its accounting are live.
    pub fn as_slice(&self) -> &[u8] {
        &self.body
    }
}

#[cfg(test)]
#[path = "mirror_install_data_tests.rs"]
mod tests;
