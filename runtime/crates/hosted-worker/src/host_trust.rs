//! Public-only hosted bootstrap verification, BEFORE custody/SQL/secret use.
//!
//! `pins_cbor` is the canonical normalized output of the ONE shared mdbn-trust
//! BUILD-time signed environment-asset verifier. It MUST be a bundled release
//! literal, never learned from a request, CP record, log, SQL or runtime override.
//! This module parses that bounded OUTPUT, not the signed environment asset.
//! Original genesis proves collection origin, NOT current cloud-copy permission.
//! Normal native policy evaluation owns certificate/signature/genesis semantics.

use mdbn_replica::crypto::sign::Ed25519Verifier;
use mdbn_replica::policy::{Env, PolicyKeyPin, PolicyPins, PolicyState, RootPin};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, item_chain_hash};
use mdbn_wire::hash::sha256;
use mdbn_wire::schema::Wire;

/// Maximum complete ORIGINAL signed genesis or normalized public pins.
pub const MAX_PUBLIC_BYTES: usize = 64 << 10;

/// Public origin evidence only. Private fields prevent a caller manufacturing a
/// successful result; retain no item body, secrets, authority or replay state.
#[derive(Debug)]
pub struct VerifiedHostedGenesis {
    collection: Uuid,
    item_sha256: B32,
    chain: B32,
    pins: PolicyPins,
}

impl VerifiedHostedGenesis {
    /// The independently bound collection.
    pub fn collection(&self) -> Uuid {
        self.collection
    }

    /// SHA-256 of the exact independently verified complete original item bytes.
    pub fn item_sha256(&self) -> B32 {
        self.item_sha256
    }

    /// Native `ReplicaConfig.expected_genesis`: the existing domain-separated
    /// H("mdbase/v1/chain", exact original bytes), NOT the record's plain SHA256.
    pub fn genesis_chain_hash(&self) -> B32 {
        self.chain
    }

    /// Bundled normalized pins, structurally/native validated, not CP authority.
    pub fn policy_pins(&self) -> &PolicyPins {
        &self.pins
    }

    pub(crate) fn matches_config(&self, cfg: &mdbn_replica::ReplicaConfig) -> bool {
        let mut actual = cfg.trusted_roots.clone();
        let mut expected = self.roots();
        actual.sort();
        expected.sort();
        cfg.collection == self.collection
            && cfg.expected_genesis == Some(self.chain)
            && cfg.policy_pins.as_ref() == Some(&self.pins)
            && actual == expected
    }

    /// Only roots from the bundled signed release, no additive runtime authority.
    pub fn roots(&self) -> Vec<[u8; 32]> {
        self.pins.roots.iter().map(|r| r.root_pk.0).collect()
    }
}

/// Deliberately opaque: a refused bootstrap never logs input or crypto details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedTrustRefused;

type Result<T> = std::result::Result<T, HostedTrustRefused>;

fn bounded(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_PUBLIC_BYTES {
        return Err(HostedTrustRefused);
    }
    Ok(())
}

fn array(c: &Cbor, size: usize) -> Result<&[Cbor]> {
    match c {
        Cbor::Array(a) if a.len() == size => Ok(a),
        _ => Err(HostedTrustRefused),
    }
}

fn pins(bytes: &[u8]) -> Result<PolicyPins> {
    bounded(bytes)?;
    let c = cbor::decode(bytes).map_err(|_| HostedTrustRefused)?;
    let a = array(&c, 2)?;
    let Cbor::Array(rs) = &a[0] else {
        return Err(HostedTrustRefused);
    };
    let Cbor::Array(ps) = &a[1] else {
        return Err(HostedTrustRefused);
    };
    if rs.is_empty() || rs.len() > 64 || ps.is_empty() || ps.len() > 1_024 {
        return Err(HostedTrustRefused);
    }
    let mut roots = Vec::with_capacity(rs.len());
    for r in rs {
        let r = array(r, 2)?;
        roots.push(RootPin {
            root_id: B16::from_cbor(&r[0]).map_err(|_| HostedTrustRefused)?,
            root_pk: B32::from_cbor(&r[1]).map_err(|_| HostedTrustRefused)?,
        });
    }
    let mut policy_keys = Vec::with_capacity(ps.len());
    for p in ps {
        let p = array(p, 3)?;
        policy_keys.push(PolicyKeyPin {
            key_id: B16::from_cbor(&p[0]).map_err(|_| HostedTrustRefused)?,
            policy_pk: B32::from_cbor(&p[1]).map_err(|_| HostedTrustRefused)?,
            root_id: B16::from_cbor(&p[2]).map_err(|_| HostedTrustRefused)?,
        });
    }
    let pins = PolicyPins { roots, policy_keys };
    pins.validate().map_err(|_| HostedTrustRefused)?;
    Ok(pins)
}

/// No SQL, network, keyring, secret, cached state or alternate signature verifier.
/// Accept only ORIGINAL seq1 against the bundled release pins. `expected_hash`
/// is checked but gains no authority by itself: signatures/CP cert/native policy
/// are always independently verified, even when the advertised hash matches.
pub fn verify_hosted_genesis(
    collection: Uuid,
    pins_cbor: &[u8],
    original: &[u8],
    expected_hash: B32,
) -> Result<VerifiedHostedGenesis> {
    bounded(original)?;
    let pins = pins(pins_cbor)?;
    let hash = sha256(original);
    if hash != expected_hash {
        return Err(HostedTrustRefused);
    }
    let item = Item::from_bytes(original).map_err(|_| HostedTrustRefused)?;
    if item.collection != collection
        || item.kind != ItemKind::Policy
        || item.seq != Some(1)
        || item.prev != Some(B32([0; 32]))
        || item.epoch.is_some()
        || item.salt.is_some()
        || item.idem.is_some()
        || item.refs.is_some()
        || item.stream.is_some()
    {
        return Err(HostedTrustRefused);
    }
    let roots: Vec<_> = pins.roots.iter().map(|r| r.root_pk.0).collect();
    let env = Env {
        verifier: &Ed25519Verifier,
        trusted_roots: &roots,
        policy_pins: Some(&pins),
    };
    // A fresh policy state requires valid ORIGINAL Genesis. Do NOT retain this
    // state's mode/devices/grants as current permission or a serving verdict.
    let mut policy = PolicyState::new();
    policy
        .apply_control(1, &item_chain_hash(original), &item, &env)
        .map_err(|_| HostedTrustRefused)?;
    Ok(VerifiedHostedGenesis {
        collection,
        item_sha256: hash,
        chain: item_chain_hash(original),
        pins,
    })
}

/// Host/WASM public request: `[collection16, normalizedPinsCBOR, originalItem,
/// originalSHA256]`. No caller may obtain pins from the bootstrap response.
pub fn verify_public_request(bytes: &[u8]) -> Result<VerifiedHostedGenesis> {
    if bytes.len() > 2 * MAX_PUBLIC_BYTES + 128 {
        return Err(HostedTrustRefused);
    }
    let c = cbor::decode(bytes).map_err(|_| HostedTrustRefused)?;
    let a = array(&c, 4)?;
    let Cbor::Bytes(pins) = &a[1] else {
        return Err(HostedTrustRefused);
    };
    let Cbor::Bytes(original) = &a[2] else {
        return Err(HostedTrustRefused);
    };
    verify_hosted_genesis(
        B16::from_cbor(&a[0]).map_err(|_| HostedTrustRefused)?,
        pins,
        original,
        B32::from_cbor(&a[3]).map_err(|_| HostedTrustRefused)?,
    )
}

#[cfg(test)]
mod tests;
