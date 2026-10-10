use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::UpdateError;

/// Desktop release stream. Changing streams never resets anti-rollback state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    /// Releases without a prerelease suffix.
    Stable,
    /// Public prereleases.
    Beta,
    /// Programme rollout stream.
    Next,
}

/// Locally selected stream. `early` is never read from signed server fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalChannel {
    /// General-cohort stable releases.
    Stable,
    /// General-cohort public prereleases.
    Beta,
    /// General-cohort programme rollout.
    Next,
    /// Local canary opt-in; follows beta without percentage/soak for future versions.
    Early,
}

impl LocalChannel {
    /// `early` uses the beta pointer, not a server-selectable canary pointer.
    pub fn remote(self) -> Channel {
        match self {
            Self::Stable => Channel::Stable,
            Self::Beta | Self::Early => Channel::Beta,
            Self::Next => Channel::Next,
        }
    }
}

/// All fields other than signing/expiry times are immutable for one version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Schema 1 only.
    pub schema_version: u32,
    /// Must be `mdbase-next-desktop`.
    pub product: String,
    /// Must match the selected remote stream.
    pub channel: Channel,
    /// Canonical SemVer, without build metadata aliases.
    pub version: String,
    /// Immutable release publication time, RFC 3339.
    pub published_at: String,
    /// Time this exact document was signed, RFC 3339.
    pub signed_at: String,
    /// Freshness deadline, at most 30 days after signing.
    pub expires_at: String,
    /// General-cohort bucket gate.
    pub rollout: Rollout,
    /// Releases that must not be applied.
    pub blocked_versions: Vec<String>,
    /// Oldest installed version eligible for this upgrade.
    pub minimum_version: Option<String>,
    /// May raise, never lower, the compiled 72-hour soak.
    #[serde(default = "default_soak")]
    pub min_soak_hours: u64,
    /// Exactly the four supported release artifacts.
    pub targets: BTreeMap<String, TargetArtifact>,
}

fn default_soak() -> u64 {
    72
}

/// Deterministic selection against a random, per-install ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rollout {
    /// Inclusive range 0–100.
    pub percentage: u8,
    /// Independent rollout salt; not a device or account identity.
    pub seed: String,
}

/// Integrity of an archive fetched from an immutable GitHub Release asset URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetArtifact {
    /// Exact GitHub Release URL for this version and target.
    pub url: String,
    /// Archive SHA-256, 64 lowercase hexadecimal digits.
    pub sha256: String,
    /// Exact archive byte length, bounded to 512 MiB.
    pub size: u64,
}

/// A recovery-signed cumulative key statement. Revocations are permanent; additions
/// repeat in later statements, so an offline device can safely skip sequences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keyset {
    /// Strictly monotonic statement number, starting at 1.
    pub sequence: u64,
    /// Cumulative permanently revoked CI key IDs.
    pub revoked: Vec<String>,
    /// Cumulative added CI public keys, with immutable IDs.
    pub added: Vec<AddedKey>,
    /// Stops all applies; a later statement may lift it.
    pub halt: Option<Halt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// A distinct CI key authorized only by the recovery signer.
pub struct AddedKey {
    /// Unique ID, never reused after revocation.
    pub id: String,
    /// Raw 32-byte public key, lowercase hex.
    pub public_key: String,
    /// Only CI additions are accepted; recovery rotation is not remote.
    pub role: KeyRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// The only remotely addable signing role.
pub enum KeyRole {
    /// Release manifest signer.
    Ci,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Recovery-signed emergency stop, applying to every cohort.
pub struct Halt {
    /// Human-readable reason, never an executable instruction.
    pub reason: String,
}

pub(super) fn version(text: &str) -> Result<semver::Version, UpdateError> {
    let v = semver::Version::parse(text).map_err(|_| UpdateError("invalid SemVer"))?;
    // Build metadata has no precedence; forbid aliases of an already observed version.
    if !v.build.is_empty() {
        return Err(UpdateError("release version has build metadata"));
    }
    Ok(v)
}

pub(super) fn timestamp(text: &str) -> Result<i64, UpdateError> {
    let timestamp =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
            .map_err(|_| UpdateError("invalid RFC 3339 timestamp"))?;
    if timestamp.nanosecond() != 0 {
        return Err(UpdateError("release timestamps require whole seconds"));
    }
    Ok(timestamp.unix_timestamp())
}

impl Manifest {
    pub(super) fn validate(&self, channel: Channel, now: i64) -> Result<(), UpdateError> {
        if self.schema_version != 1
            || self.product != "mdbase-next-desktop"
            || self.channel != channel
        {
            return Err(UpdateError("manifest schema, product or channel mismatch"));
        }
        version(&self.version)?;
        for v in &self.blocked_versions {
            version(v)?;
        }
        if let Some(v) = &self.minimum_version {
            version(v)?;
        }
        let published = timestamp(&self.published_at)?;
        let signed = timestamp(&self.signed_at)?;
        let expires = timestamp(&self.expires_at)?;
        if published > signed
            || signed > now
            || expires <= now
            || expires <= signed
            || expires.saturating_sub(signed) > 30 * 24 * 60 * 60
            || expires.saturating_sub(now) > 30 * 24 * 60 * 60
        {
            return Err(UpdateError("manifest expired or invalid validity interval"));
        }
        if self.rollout.percentage > 100
            || self.rollout.seed.is_empty()
            || self.rollout.seed.len() > 256
            || self.min_soak_hours < 72
            || self.min_soak_hours > 24 * 365
        {
            return Err(UpdateError("invalid rollout or soak"));
        }
        let targets = [
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
            "universal-apple-darwin",
            "x86_64-pc-windows-msvc",
        ];
        if self.targets.len() != targets.len()
            || targets.iter().any(|t| !self.targets.contains_key(*t))
        {
            return Err(UpdateError(
                "manifest must name exactly the four desktop targets",
            ));
        }
        for (target, artifact) in &self.targets {
            super::signature::hex::<32>(&artifact.sha256)?;
            if artifact.size == 0 || artifact.size > 512 * 1024 * 1024 {
                return Err(UpdateError("invalid archive size"));
            }
            let unsigned = if target == "x86_64-pc-windows-msvc" {
                "-UNSIGNED"
            } else {
                ""
            };
            let suffix = if target == "x86_64-pc-windows-msvc" {
                "zip"
            } else {
                "tar.gz"
            };
            let base = format!(
                "https://github.com/mdbase-dev/mdbase-connect/releases/download/v{}/mdbase-next-{}-{target}",
                self.version, self.version
            );
            let signed_url = format!("{base}{unsigned}.{suffix}");
            let mac_preview = format!("{base}-UNSIGNED.{suffix}");
            if artifact.url != signed_url
                && !(target == "universal-apple-darwin" && artifact.url == mac_preview)
            {
                return Err(UpdateError("unexpected artifact origin or name"));
            }
        }
        Ok(())
    }

    pub(super) fn immutable_bytes(&self) -> Result<Vec<u8>, UpdateError> {
        let mut stable = self.clone();
        stable.signed_at.clear();
        stable.expires_at.clear();
        serde_json::to_vec(&stable).map_err(|_| UpdateError("cannot encode manifest identity"))
    }
}
