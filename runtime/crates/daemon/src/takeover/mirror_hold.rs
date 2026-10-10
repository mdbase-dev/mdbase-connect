//! Complete hold-context DRAFT, not an authenticated proof or stored Hold.
//!
//! Keeps full base/lost/kept record source or canonical FileContent AND semantic
//! kind, plus original capture/unknown outcomes. Hash-only binary context is not
//! accepted. Consistency checks here authenticate neither checkpoint nor blob
//! bytes: the eventual serialized consumer must verify source custody, all current
//! bindings and atomically commit proof/pending/hold/observation. No Store, disk,
//! upload, mutation-ID minting, observation acknowledgement or release operation.

use super::mirror_evidence::{Checkpoint, Descriptor, Evidence};
use serde::{Deserialize, Serialize};
use std::io;

const MAX_BYTES: usize = 16 * 1024 * 1024;

/// Full content for a claimed checkpoint; absence never substitutes for unknown.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BaseContent {
    /// Complete old accepted record source or file descriptor, not only B's hash.
    Present {
        /// Original complete base content (and semantic kind).
        descriptor: Descriptor,
    },
    /// Only consistent with capture's explicitly certified namespace absence.
    CertifiedAbsent,
    /// Base provenance/content remains unavailable, never fabricated absence.
    Unavailable,
}
impl std::fmt::Debug for BaseContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Present { .. } => "Present(<complete content redacted>)",
            Self::CertifiedAbsent => "CertifiedAbsent",
            Self::Unavailable => "Unavailable",
        })
    }
}

/// A consistency-checked, complete context DRAFT. It grants no write permission.
/// Fields private; decoding repeats all checks rather than trusting a receipt.
#[derive(Clone, PartialEq, Eq)]
pub struct Context {
    capture: Evidence,
    base: BaseContent,
    kept: Option<Descriptor>,
}
impl std::fmt::Debug for Context {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MirrorHoldDraft")
            .field("base", &self.base)
            .field("lost_present", &self.capture.server.is_some())
            .field("kept_present", &self.kept.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    schema_version: u32,
    capture: Evidence,
    base: BaseContent,
    kept: SideContent,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SideContent {
    Present { descriptor: Descriptor },
    Absent,
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid complete mirror hold context",
    )
}

impl Context {
    /// Build without effects. File descriptors must come from retained complete
    /// content custody; a caller must NOT synthesize one from a captured hash.
    /// No base content available for a Present checkpoint means refusal, not
    /// silently converting it into certified absence or a hash-only hold.
    pub fn build(
        capture: &Evidence,
        base: BaseContent,
        kept: Option<Descriptor>,
    ) -> io::Result<Self> {
        // Reuse capture's structural/canonical/identity/path checks only. Its
        // classification (including future/unknown outcome) is NOT authorization.
        capture.decision()?;
        if capture.resource_id.is_none() {
            // This seam preserves an ID. Fresh candidate minting remains separate.
            return Err(invalid());
        }
        match (&capture.checkpoint, &base) {
            (Checkpoint::Present { hash, .. }, BaseContent::Present { descriptor })
                if descriptor.hash(capture.collection)? == *hash => {}
            (Checkpoint::CertifiedAbsent { .. }, BaseContent::CertifiedAbsent)
            | (Checkpoint::Unavailable, BaseContent::Unavailable) => {}
            _ => return Err(invalid()),
        }
        let kept_hash = kept
            .as_ref()
            .map(|d| d.hash(capture.collection))
            .transpose()?;
        if kept_hash != capture.observed {
            return Err(invalid());
        }
        Ok(Self {
            capture: capture.clone(),
            base,
            kept,
        })
    }

    /// Original complete capture, including ID/head/path/generation/unknown IDs.
    pub fn capture(&self) -> &Evidence {
        &self.capture
    }
    /// Complete claimed base or explicitly distinct absent/unavailable provenance.
    pub fn base(&self) -> &BaseContent {
        &self.base
    }
    /// Full verified-server claim kept as the lost side, including all blob fields.
    pub fn lost(&self) -> Option<&Descriptor> {
        self.capture.server.as_ref()
    }
    /// Full actual-local claim kept as the user's side. It is NOT disk-known(S).
    pub fn kept(&self) -> Option<&Descriptor> {
        self.kept.as_ref()
    }

    /// Encode evidence only; not a transaction or a durable consumed-proof receipt.
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let bytes = serde_json::to_vec(&Raw {
            schema_version: 1,
            capture: self.capture.clone(),
            base: self.base.clone(),
            kept: match &self.kept {
                Some(descriptor) => SideContent::Present {
                    descriptor: descriptor.clone(),
                },
                None => SideContent::Absent,
            },
        })
        .map_err(|_| invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }
    /// Unknown/torn/extra/duplicate/mismatching data is refused, never repaired.
    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        let raw: Raw = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if raw.schema_version != 1 {
            return Err(invalid());
        }
        Self::build(
            &raw.capture,
            raw.base,
            match raw.kept {
                SideContent::Present { descriptor } => Some(descriptor),
                SideContent::Absent => None,
            },
        )
    }
}

#[cfg(test)]
#[path = "mirror_hold_tests.rs"]
mod tests;
