//! Resident generation-0 manifest checks reused by the ordinary installer.
//!
//! Partial DATA validation only: not closed authority, source closure or a swap
//! permit. The caller still validates/opens the actual object and its payload,
//! and supplies the policy already established by the ordinary control chain.

use crate::policy::{PolicyState, SigVerifier};
use mdbn_wire::{
    attachment_runtime_v1::ManifestPayload,
    common::{B32, Hash},
    envelope::Item,
};
use std::marker::PhantomData;

/// Partial check bound to immutable input lifetime. No public constructor,
/// serialization, clone, installation effect or continuing native authority.
pub(crate) struct CheckedGen0<'a> {
    _inputs: PhantomData<&'a ()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    NotGen0,
    StateDigest,
    Epoch,
    MissingSigner,
    InactiveSigner,
    RawDigest,
    MissingSignature,
    BadSignature,
}
impl Error {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::NotGen0 => "base manifest is not a generation 0",
            Self::StateDigest => "base manifest state digest differs from the base",
            Self::Epoch => "base manifest is sealed under another epoch than the base",
            Self::MissingSigner => "manifest has no signer",
            Self::InactiveSigner => "base manifest signer is not an active, keyed device",
            Self::RawDigest => "manifest digest",
            Self::MissingSignature => "manifest is not signed",
            Self::BadSignature => "manifest signature does not verify",
        }
    }
}

/// Same checks/order/errors as the original ordinary base-manifest checker.
/// Uses exact received-byte digest, not typed known-field re-encoding.
/// No second raw body, new codec, Store access or native effects. A future closed
/// consumer must reserve retained inputs and precharge both digest passes/work
/// in ONE shared ledger before invoking this partial check.
pub(crate) fn check_gen0_manifest<'a>(
    raw: &'a [u8],
    item: &'a Item,
    manifest: &'a ManifestPayload,
    epoch: u64,
    state_digest: Hash,
    policy: &'a PolicyState,
    verifier: &'a dyn SigVerifier,
) -> Result<CheckedGen0<'a>, Error> {
    if manifest.seq != 0 || manifest.chain != B32([0; 32]) || manifest.control_chain != B32([0; 32])
    {
        return Err(Error::NotGen0);
    }
    if manifest.state_digest != state_digest {
        return Err(Error::StateDigest);
    }
    if item.epoch != Some(epoch) {
        return Err(Error::Epoch);
    }
    let signer = item.signer.ok_or(Error::MissingSigner)?;
    let device = policy
        .devices
        .get(&signer)
        .filter(|device| device.active && device.keyed)
        .ok_or(Error::InactiveSigner)?;
    let digest =
        crate::crypto::raw::signed_digest_from_bytes_borrowed(raw).map_err(|_| Error::RawDigest)?;
    let sig = item.sig.ok_or(Error::MissingSignature)?;
    if !verifier.verify(&device.sign_pk.0, &digest, &sig.0) {
        return Err(Error::BadSignature);
    }
    Ok(CheckedGen0 {
        _inputs: PhantomData,
    })
}

#[cfg(test)]
#[path = "mirror_install_tests.rs"]
mod tests;
