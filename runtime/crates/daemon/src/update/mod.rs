//! Desktop update trust and device-enforced rollout policy.
//!
//! This module does not download, extract, install, or run an artifact. Production
//! key provisioning, durable owner-only state, fresh HTTPS recovery checks, archive
//! validation and crash-safe installation must land before a caller can apply an
//! update. No updater timer or CLI is wired yet.
//!
//! Signatures cover `SHA256(u8(tag.len()) || tag || exact_bytes)`, using distinct
//! domains for manifests and recovery statements. Recovery can change CI keys but
//! cannot sign a manifest. Callers must durably persist policy state before treating
//! an observation as accepted; a failed save must never authorize installation.

mod model;
mod policy;
mod signature;

pub use model::{
    AddedKey, Channel, Halt, KeyRole, Keyset, LocalChannel, Manifest, Rollout, TargetArtifact,
};
pub use policy::{ApplyDecision, Cohort, PolicyState};
pub use signature::{PinnedKeys, VerifiedKeyset, VerifiedManifest};

/// Recovery public key (fingerprint
/// `919763fc03a25103`). Role: key-set statements only, never manifests.
/// Custody acceptance and the initial statement remain release blockers; no apply
/// path uses this pin yet. No private key is read or held by this module.
pub const RECOVERY_PUBLIC_KEY: [u8; 32] = [
    0x73, 0x6d, 0x64, 0xc3, 0x8d, 0xef, 0xf7, 0xc8, 0x4f, 0x14, 0xa6, 0x3f, 0x0a, 0x32, 0xa7, 0xdd,
    0xdc, 0xed, 0x3a, 0xa1, 0x48, 0x5d, 0x30, 0xfd, 0x4b, 0xff, 0xcf, 0x5d, 0x39, 0xe7, 0x52, 0x0d,
];

/// Public-key fingerprint supplied with the recovery pin.
pub const RECOVERY_KEY_ID: &str = "919763fc03a25103";

/// A trust or rollout validation failure. Remote bytes are never put in messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError(pub &'static str);

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for UpdateError {}

#[cfg(test)]
mod tests;
