use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::model::{timestamp, version};
use super::signature::PinIdentity;
use super::{Keyset, LocalChannel, PinnedKeys, UpdateError, VerifiedKeyset, VerifiedManifest};

const SOAK_SECONDS: i64 = 72 * 60 * 60;
const STATE_SCHEMA: u32 = 2;

/// Canary must be selected locally before a version is first observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cohort {
    /// Normal rollout and mandatory soak.
    General,
    /// Locally opted-in tester, qualified per version before first observation.
    Canary,
}

/// Why the currently verified release can or cannot be applied. No override exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyDecision {
    /// All trust/rollout policy gates passed, not installation authorization.
    Eligible,
    /// Recovery statement carries an emergency halt.
    Halted,
    /// The release is listed as harmful.
    Blocked,
    /// No forward upgrade is available.
    AlreadyInstalled,
    /// The installed binary is older than the minimum upgrade source.
    MinimumVersion,
    /// This general-cohort install is outside the rollout percentage.
    OutsideRollout,
    /// The mandatory local delay has not finished.
    Soaking {
        /// Whole seconds until the compiled/signed floor is reached.
        remaining_seconds: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    first_seen: i64,
    canary: bool,
    identity: Vec<u8>,
    key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredState {
    schema_version: u32,
    pins: PinIdentity,
    install_id: [u8; 32],
    cohort: Cohort,
    channel: LocalChannel,
    highest_verified_version: String,
    last_clock: i64,
    #[serde(deserialize_with = "required_option")]
    keyset: Option<Keyset>,
    #[serde(deserialize_with = "required_option")]
    keyset_digest: Option<[u8; 32]>,
    observations: BTreeMap<String, Observation>,
}

/// Serializable state under `<state>/updates/`. Missing/malformed persisted state
/// on an existing install must fail closed, not reset rollback/soak history.
/// A caller must hold an exclusive updater lock and durably commit every mutation.
/// Reopen only with `restore`, which requires the independently provisioned pins;
/// there is deliberately no public unchecked `Deserialize` implementation.
///
/// ```compile_fail
/// use mdbn_daemon::update::PolicyState;
/// let _ = serde_json::from_slice::<PolicyState>(b"{}");
/// ```
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct PolicyState(StoredState);

impl PolicyState {
    /// Only for a brand-new install, never recovery from a missing state file.
    /// Bind the intended family BEFORE accepting the first recovery statement.
    pub fn new(pins: &PinnedKeys, installed_version: &str, now: i64) -> Result<Self, UpdateError> {
        let mut install_id = [0; 32];
        getrandom::fill(&mut install_id)
            .map_err(|_| UpdateError("install ID entropy unavailable"))?;
        Self::with_install_id(pins, installed_version, now, install_id)
    }

    fn with_install_id(
        pins: &PinnedKeys,
        installed: &str,
        now: i64,
        install_id: [u8; 32],
    ) -> Result<Self, UpdateError> {
        version(installed)?;
        Ok(Self(StoredState {
            schema_version: STATE_SCHEMA,
            pins: pins.identity(),
            install_id,
            cohort: Cohort::General,
            channel: LocalChannel::Stable,
            highest_verified_version: installed.to_owned(),
            last_clock: now,
            keyset: None,
            keyset_digest: None,
            observations: BTreeMap::new(),
        }))
    }

    /// Reopen trusted, private persisted state under the original provisioned pins.
    /// Legacy/missing family metadata is rejected, never migrated or reset silently.
    /// An authorized pin-family transition needs a separately reviewed mechanism.
    pub fn restore(pins: &PinnedKeys, bytes: &[u8]) -> Result<Self, UpdateError> {
        let state = Self(
            serde_json::from_slice(bytes)
                .map_err(|_| UpdateError("invalid persisted policy state"))?,
        );
        state.check_family(&pins.identity())?;
        version(&state.0.highest_verified_version)?;
        if state.0.keyset.is_some() != state.0.keyset_digest.is_some()
            || (state.0.keyset.is_none() && !state.0.observations.is_empty())
        {
            return Err(UpdateError("incomplete persisted recovery state"));
        }
        Ok(state)
    }

    /// Persist this change before checking a release. It affects only future versions.
    pub fn set_cohort(&mut self, cohort: Cohort) {
        self.0.cohort = cohort;
    }

    /// Set a local stream/cohort. `early` changes only future observations, never
    /// retroactively waiving the soak on a version already seen by this install.
    pub fn set_channel(&mut self, channel: LocalChannel) {
        self.0.channel = channel;
        self.0.cohort = if channel == LocalChannel::Early {
            Cohort::Canary
        } else {
            Cohort::General
        };
    }

    /// The configured stream; `early` fetches the beta channel pointer.
    pub fn channel(&self) -> LocalChannel {
        self.0.channel
    }

    /// Verify a recovery statement is not a replay or equivocation. Statements are
    /// cumulative: neither a revocation nor a prior added key can disappear/change.
    pub fn accept_keyset(&mut self, verified: &VerifiedKeyset) -> Result<(), UpdateError> {
        self.check_family(&verified.pins)?;
        let next = &verified.document;
        if let Some(old) = &self.0.keyset {
            if next.sequence < old.sequence {
                return Err(UpdateError("keyset sequence rollback"));
            }
            if next.sequence == old.sequence {
                return if self.0.keyset_digest == Some(verified.digest) {
                    Ok(())
                } else {
                    Err(UpdateError("keyset sequence equivocation"))
                };
            }
            if old.revoked.iter().any(|id| !next.revoked.contains(id))
                || old.added.iter().any(|key| !next.added.contains(key))
            {
                return Err(UpdateError("keyset omitted or changed cumulative entries"));
            }
        }
        self.0.keyset = Some(next.clone());
        self.0.keyset_digest = Some(verified.digest);
        Ok(())
    }

    /// Record a *currently* verified manifest. Re-signs preserve first-seen time and
    /// canary qualification. Successful mutations must be saved before any apply.
    pub fn observe(&mut self, manifest: &VerifiedManifest, now: i64) -> Result<(), UpdateError> {
        self.check_proof(manifest, now)?;
        let doc = &manifest.document;
        let candidate = version(&doc.version)?;
        if candidate < version(&self.0.highest_verified_version)? {
            return Err(UpdateError("manifest version rollback across channels"));
        }
        let identity = doc.immutable_bytes()?;
        if let Some(old) = self.0.observations.get(&doc.version) {
            if old.identity != identity {
                return Err(UpdateError(
                    "same-version manifest changed immutable fields",
                ));
            }
        } else {
            self.0.observations.insert(
                doc.version.clone(),
                Observation {
                    first_seen: now,
                    canary: self.0.cohort == Cohort::Canary,
                    identity,
                    key_id: manifest.key_id.clone(),
                },
            );
        }
        // Persist the verifying key even when the release is validly re-signed with
        // another key. Key rotation must not reset its soak.
        self.0
            .observations
            .get_mut(&doc.version)
            .expect("observed above")
            .key_id
            .clone_from(&manifest.key_id);
        self.0.highest_verified_version.clone_from(&doc.version);
        self.0.last_clock = now;
        Ok(())
    }

    /// The caller must freshly fetch and verify recovery bytes for this attempt,
    /// accept and persist them, then freshly verify the *current channel pointer*
    /// under them. Cached objects are not an adequate network freshness check.
    /// This pure function is not an installation capability or apply approval.
    pub fn decision(
        &self,
        manifest: &VerifiedManifest,
        fresh_keys: &VerifiedKeyset,
        installed: &str,
        now: i64,
    ) -> Result<ApplyDecision, UpdateError> {
        self.check_family(&fresh_keys.pins)?;
        self.check_proof(manifest, now)?;
        if self.0.keyset_digest != Some(fresh_keys.digest) {
            return Err(UpdateError("apply needs current recovery statement"));
        }
        let doc = &manifest.document;
        let seen = self
            .0
            .observations
            .get(&doc.version)
            .ok_or(UpdateError("manifest has not been durably observed"))?;
        if seen.identity != doc.immutable_bytes()? || doc.version != self.0.highest_verified_version
        {
            return Err(UpdateError(
                "apply is not the highest observed immutable manifest",
            ));
        }
        if fresh_keys.document.halt.is_some() {
            return Ok(ApplyDecision::Halted);
        }
        if doc.blocked_versions.contains(&doc.version) {
            return Ok(ApplyDecision::Blocked);
        }
        let installed = version(installed)?;
        if version(&doc.version)? <= installed {
            return Ok(ApplyDecision::AlreadyInstalled);
        }
        if let Some(minimum) = &doc.minimum_version
            && installed < version(minimum)?
        {
            return Ok(ApplyDecision::MinimumVersion);
        }
        if !seen.canary && bucket(&doc.rollout.seed, &self.0.install_id) >= doc.rollout.percentage {
            return Ok(ApplyDecision::OutsideRollout);
        }
        if !seen.canary {
            let required = SOAK_SECONDS.max(
                i64::try_from(doc.min_soak_hours * 3600)
                    .map_err(|_| UpdateError("soak overflow"))?,
            );
            let elapsed = now
                .checked_sub(seen.first_seen)
                .ok_or(UpdateError("clock overflow"))?;
            if elapsed < required {
                return Ok(ApplyDecision::Soaking {
                    remaining_seconds: required - elapsed,
                });
            }
        }
        Ok(ApplyDecision::Eligible)
    }

    fn check_family(&self, pins: &PinIdentity) -> Result<(), UpdateError> {
        if self.0.schema_version != STATE_SCHEMA || &self.0.pins != pins {
            return Err(UpdateError(
                "proof belongs to different original pin family",
            ));
        }
        Ok(())
    }

    fn check_proof(&self, manifest: &VerifiedManifest, now: i64) -> Result<(), UpdateError> {
        self.check_family(&manifest.pins)?;
        if now < self.0.last_clock {
            return Err(UpdateError("invalid policy state or local clock rollback"));
        }
        if manifest.document.channel != self.0.channel.remote() {
            return Err(UpdateError(
                "manifest does not match locally selected channel",
            ));
        }
        if manifest.verified_at != now || timestamp(&manifest.document.expires_at)? <= now {
            return Err(UpdateError(
                "manifest must be freshly verified for this check",
            ));
        }
        if self.0.keyset_digest != Some(manifest.keyset_digest) {
            return Err(UpdateError(
                "manifest not verified against current recovery statement",
            ));
        }
        Ok(())
    }
}

// Explicit null is valid for a never-observed state; a missing field is not.
fn required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

fn bucket(seed: &str, install_id: &[u8; 32]) -> u8 {
    let mut hash = Sha256::new();
    hash.update(seed.as_bytes());
    hash.update([0]);
    hash.update(install_id);
    // Interpret the entire digest as a big-endian integer, not a platform usize.
    hash.finalize()
        .iter()
        .fold(0u16, |n, byte| (n * 256 + u16::from(*byte)) % 100) as u8
}
