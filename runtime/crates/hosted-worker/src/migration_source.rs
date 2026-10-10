//! Bounded, public-only migration-source signature checking.
//!
//! This is NOT migration admission: a signature does not inspect current CP-key
//! revocation, prove source transaction/run currentness, or mint a region lease.
//! The Engine must bind a fresh FULL native admission and its expected-admission
//! revocation inspection, then retain a private proof and recheck every boundary.
//! Pins come only from authenticated native configuration, never witness input.

use mdbn_replica::VerifiedHostedAdmission;
use mdbn_replica::crypto::sign::Ed25519Verifier;
use mdbn_replica::policy::PolicyPins;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, B64, Uuid};
use mdbn_wire::hash::h;
use mdbn_wire::policy::CpCert;
use mdbn_wire::schema::Wire;

/// Maximum complete canonical witness, checked before any decode/allocation.
pub const MAX_WITNESS_BYTES: usize = 4096;
/// Fixed TEN scalar/fixed-byte claims need at most 107 canonical bytes.
const MAX_CLAIMS_BYTES: usize = 107;
const MAX_TTL_MS: i64 = 900_000;
const DOMAIN: &str = "mdbase-next/migration-source/v1";

/// Public signed data, not caller-held native authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationSourceClaims {
    /// Exact target collection.
    pub target: Uuid,
    /// Exact control-enrolled hosted service device.
    pub hosted_device: Uuid,
    /// Encryption epoch from actual native admission, not an LS sequence.
    pub epoch: u64,
    /// Authenticated frozen legacy collection.
    pub legacy: Uuid,
    /// Drained legacy head, equal to CP's immutable s_final in launch mode.
    pub source_head: u64,
    /// Immutable Connect #652 account start claim in Unix milliseconds.
    pub started_at_ms: i64,
    /// Actual native wake instance, not a CP batch identifier.
    pub wake: u64,
    /// Signature issuance time in Unix milliseconds.
    pub issued_at_ms: i64,
    /// Exclusive expiry in Unix milliseconds, at most 15 minutes after issue.
    pub expires_at_ms: i64,
}

/// Parsed public envelope. No keys, source bodies, session, sealer or lease.
/// Decoding alone does not verify its signature or authorize any effect.
#[derive(Debug)]
pub struct MigrationSourceWitness {
    claims: MigrationSourceClaims,
    cert: CpCert,
    digest: B32,
    signature: B64,
}

/// Opaque refusal: input and cryptographic details are never logged here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationSourceRefused;
type Result<T> = std::result::Result<T, MigrationSourceRefused>;

impl MigrationSourceWitness {
    /// Parse the EXACT canonical shape without generic recursive decoding of an
    /// attacker-controlled container. Huge declared lengths/nesting refuse before
    /// allocation. Only the flat <=141-byte certificate uses the existing Wire
    /// decoder, after shape preflight; scalar decoding uses mdb-cbor/1 unchanged.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_WITNESS_BYTES {
            return Err(MigrationSourceRefused);
        }
        let mut input = Cursor::new(bytes);
        input.literal(0x84)?; // exact four-entry array
        input.literal(1)?;
        let raw_claims = input.bytes(MAX_CLAIMS_BYTES)?;
        let claims = parse_claims(raw_claims)?;
        let cert_start = input.pos;
        input.certificate_shape()?;
        let cert = CpCert::from_bytes(&bytes[cert_start..input.pos])
            .map_err(|_| MigrationSourceRefused)?;
        let signature = B64(input.fixed()?);
        input.end()?;
        Ok(Self {
            claims,
            cert,
            digest: h(DOMAIN, raw_claims),
            signature,
        })
    }

    /// Signed metadata only. A caller may copy it but cannot manufacture native
    /// admission, override a source transaction, or acquire an attachment region.
    pub fn claims(&self) -> &MigrationSourceClaims {
        &self.claims
    }

    /// Key ID to inspect through the expected-FULL-admission native revocation
    /// getter. Not being in that map is only one prerequisite, not authorization.
    pub fn signer_key_id(&self) -> B16 {
        self.cert.key_id()
    }

    /// Stateless cryptographic/tuple check against actual native proof. MUST use
    /// the same fresh proof for current revocation inspection and private Engine
    /// proof creation. This method alone cannot certify current permission.
    pub fn verify_signature(
        &self,
        pins: &PolicyPins,
        admission: &VerifiedHostedAdmission,
        now_ms: i64,
    ) -> Result<()> {
        if !self.matches_tuple(
            admission.collection(),
            admission.device(),
            admission.epoch(),
            admission.wake_instance(),
        ) {
            return Err(MigrationSourceRefused);
        }
        self.verify_for_root(pins, admission.root_id(), admission.root_pk(), now_ms)
    }

    /// Positive checked TTL, inclusive issue and exclusive expiry. Host clock is
    /// supplied by the Engine; there is no ambient clock or caller current flag.
    pub fn live_at(&self, now_ms: i64) -> bool {
        let c = &self.claims;
        c.expires_at_ms
            .checked_sub(c.issued_at_ms)
            .is_some_and(|ttl| (1..=MAX_TTL_MS).contains(&ttl))
            && c.issued_at_ms <= now_ms
            && now_ms < c.expires_at_ms
    }

    fn matches_tuple(&self, collection: Uuid, device: Uuid, epoch: u64, wake: u64) -> bool {
        self.claims.target == collection
            && self.claims.hosted_device == device
            && self.claims.epoch == epoch
            && self.claims.wake == wake
    }

    fn verify_for_root(
        &self,
        pins: &PolicyPins,
        root: B16,
        root_pk: B32,
        now_ms: i64,
    ) -> Result<()> {
        let cert = &self.cert;
        pins.validate().map_err(|_| MigrationSourceRefused)?;
        if !self.live_at(now_ms)
            || cert.root != root
            || !pins
                .roots
                .iter()
                .any(|p| p.root_id == root && p.root_pk == root_pk)
            || !pins.policy_keys.iter().any(|p| {
                p.key_id == cert.key_id() && p.policy_pk == cert.policy_pk && p.root_id == root
            })
            || cert.not_before > self.claims.issued_at_ms
            || cert.not_after < self.claims.expires_at_ms
        {
            return Err(MigrationSourceRefused);
        }
        let cert_digest = cert.signed_digest().map_err(|_| MigrationSourceRefused)?;
        if !Ed25519Verifier.verify(&root_pk.0, &cert_digest.0, &cert.sig.0)
            || !Ed25519Verifier.verify(&cert.policy_pk.0, &self.digest.0, &self.signature.0)
        {
            return Err(MigrationSourceRefused);
        }
        Ok(())
    }
}

fn parse_claims(bytes: &[u8]) -> Result<MigrationSourceClaims> {
    let mut input = Cursor::new(bytes);
    input.literal(0x8a)?; // TEN entries, including version
    input.literal(1)?;
    let claims = MigrationSourceClaims {
        target: B16(input.fixed()?),
        hosted_device: B16(input.fixed()?),
        epoch: input.unsigned()?,
        legacy: B16(input.fixed()?),
        source_head: input.unsigned()?,
        started_at_ms: input.signed()?,
        wake: input.unsigned()?,
        issued_at_ms: input.signed()?,
        expires_at_ms: input.signed()?,
    };
    input.end()?;
    Ok(claims)
}

// Shape-only, zero-allocation cursor, not a second general CBOR implementation.
// Scalar semantics/canonical heads use the existing strict decoder. All compound
// sizes and fixed keys are known in advance, preventing recursive allocation.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(size).ok_or(MigrationSourceRefused)?;
        let bytes = self
            .bytes
            .get(self.pos..end)
            .ok_or(MigrationSourceRefused)?;
        self.pos = end;
        Ok(bytes)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn literal(&mut self, expected: u8) -> Result<()> {
        if self.byte()? != expected {
            return Err(MigrationSourceRefused);
        }
        Ok(())
    }
    fn bytes(&mut self, max: usize) -> Result<&'a [u8]> {
        let head = self.byte()?;
        if head >> 5 != 2 {
            return Err(MigrationSourceRefused);
        }
        let len = match head & 31 {
            n @ 0..=23 => usize::from(n),
            24 => {
                let n = self.byte()?;
                if n < 24 {
                    return Err(MigrationSourceRefused);
                }
                usize::from(n)
            }
            _ => return Err(MigrationSourceRefused),
        };
        if len > max {
            return Err(MigrationSourceRefused);
        }
        self.take(len)
    }
    fn fixed<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.bytes(N)?
            .try_into()
            .map_err(|_| MigrationSourceRefused)
    }
    fn integer(&mut self, signed: bool) -> Result<Cbor> {
        let start = self.pos;
        let head = self.byte()?;
        if head >> 5 != 0 && !(signed && head >> 5 == 1) {
            return Err(MigrationSourceRefused);
        }
        let rest = match head & 31 {
            0..=23 => 0,
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => return Err(MigrationSourceRefused),
        };
        self.take(rest)?;
        cbor::decode(&self.bytes[start..self.pos]).map_err(|_| MigrationSourceRefused)
    }
    fn unsigned(&mut self) -> Result<u64> {
        let Cbor::Uint(n) = self.integer(false)? else {
            return Err(MigrationSourceRefused);
        };
        Ok(n)
    }
    fn signed(&mut self) -> Result<i64> {
        self.integer(true)?.as_i64().ok_or(MigrationSourceRefused)
    }
    fn certificate_shape(&mut self) -> Result<()> {
        self.literal(0xa5)?;
        self.literal(0)?;
        self.fixed::<32>()?;
        self.literal(1)?;
        self.signed()?;
        self.literal(2)?;
        self.signed()?;
        self.literal(3)?;
        self.fixed::<16>()?;
        self.literal(4)?;
        self.fixed::<64>()?;
        Ok(())
    }
    fn end(&self) -> Result<()> {
        if self.pos != self.bytes.len() {
            return Err(MigrationSourceRefused);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
