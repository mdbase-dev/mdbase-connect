//! Bounded last terminal sync failure with local path diagnostics. Diagnostic only: never
//! permission, currentness, replay, recovery or migration authority.

use std::io::{self, Read};
use std::path::Path;
use std::sync::{Arc, Mutex};

use mdbn_wire::client::{IncidentKind, SyncStatus};
use mdbn_wire::common::Value;
use serde::{Deserialize, Serialize};

const FILE: &str = "last-sync-failure.json";
const MAX_BYTES: u64 = 4096;
const RESOURCE_DEFERRED: &str = "Resource ingestion deferred: incomplete, unstable, invalid, over-budget or previously refused registry; original observations retained.";

/// Terminal incident classes understood by the native readiness gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A local integrity check rejected an observation or retained state.
    Integrity,
    /// Verification of the installed state disagreed with the signed state.
    VerificationMismatch,
    /// Required key material is inconsistent with the confirmed policy.
    KeyInconsistent,
    /// The device no longer has effective access.
    AccessRevoked,
    /// The remote collection is gone.
    Gone,
    /// The confirmed protocol requires a newer implementation.
    UpgradeRequired,
    /// Generation-zero folder adoption reached a terminal failure.
    AdoptionFailed,
}

/// Known local stage, not an interpretation of remote free-form text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Terminal observation at the synced readiness gate; finer stage unknown.
    SyncedReadiness,
    /// The exact static resource-ingestion refusal was observed.
    ResourceIngestion,
    /// The generation-zero adoption state explicitly reported failure.
    GenerationZeroAdoption,
}

/// Only explicitly recognized static causes may leave the actor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// The resource set could not be safely ingested; original observations stay.
    ResourceIngestDeferred,
}

/// Retained failure shown by control status even after the actor stops/reopens.
/// Includes only locally observed relative paths, never document content or remote details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    /// Typed terminal class, never the actor's free-form error message.
    pub kind: Kind,
    /// Most specific stage proven by the typed state/static cause.
    pub stage: Stage,
    /// Last confirmed position at observation, NOT an inferred failed frame.
    pub seq: u64,
    /// Generation zero when this actor is adopting; otherwise unknown.
    pub generation: Option<u64>,
    /// Exact allowlisted cause, absent when no finer cause is known.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cause: Option<Cause>,
    /// Outcome of this writer's file + directory fsync: true on success, false
    /// on error. Null on recovered records: presence does not prove that the
    /// original directory fsync completed. Never a physical/currentness proof.
    pub persisted: Option<bool>,
    /// Local paths awaiting ingestion at a resource refusal; not a claim that each caused it.
    #[serde(skip)]
    pub paths: Vec<String>,
    /// Additional paths that did not fit the bounded local diagnostic.
    #[serde(skip)]
    pub paths_omitted: Option<u64>,
}

pub(crate) type Shared = Arc<Mutex<Option<Failure>>>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    schema_version: u32,
    failure: Failure,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paths_omitted: Option<u64>,
}

impl Failure {
    /// Project only typed fatal kinds and one exact static cause. All other
    /// incident details (including maps, paths and malformed text) are discarded.
    pub(crate) fn project(
        s: &SyncStatus,
        adopt: &Option<mdbn_replica::AdoptStatus>,
    ) -> Option<Self> {
        // Done is sticky on the actor and does NOT prove the currently applied
        // generation (a later base may have arrived). Never infer it from Done.
        let generation = match adopt {
            Some(mdbn_replica::AdoptStatus::Pending | mdbn_replica::AdoptStatus::Failed(_)) => {
                Some(0)
            }
            _ => None,
        };
        let (kind, stage, cause) = if matches!(adopt, Some(mdbn_replica::AdoptStatus::Failed(_))) {
            (Kind::AdoptionFailed, Stage::GenerationZeroAdoption, None)
        } else {
            let incident = s.incidents.iter().find(|i| {
                matches!(
                    i.kind,
                    IncidentKind::Integrity
                        | IncidentKind::VerificationMismatch
                        | IncidentKind::KeyInconsistent
                        | IncidentKind::AccessRevoked
                        | IncidentKind::Gone
                        | IncidentKind::UpgradeRequired
                )
            })?;
            let kind = match incident.kind {
                IncidentKind::Integrity => Kind::Integrity,
                IncidentKind::VerificationMismatch => Kind::VerificationMismatch,
                IncidentKind::KeyInconsistent => Kind::KeyInconsistent,
                IncidentKind::AccessRevoked => Kind::AccessRevoked,
                IncidentKind::Gone => Kind::Gone,
                IncidentKind::UpgradeRequired => Kind::UpgradeRequired,
                _ => return None,
            };
            let cause = match &incident.details {
                Some(Value::Text(text)) if kind == Kind::Integrity && text == RESOURCE_DEFERRED => {
                    Some(Cause::ResourceIngestDeferred)
                }
                _ => None,
            };
            let stage = if cause.is_some() {
                Stage::ResourceIngestion
            } else {
                Stage::SyncedReadiness
            };
            (kind, stage, cause)
        };
        Some(Self {
            kind,
            stage,
            seq: s.confirmed_through,
            generation,
            cause,
            persisted: Some(false),
            paths: Vec::new(),
            paths_omitted: None,
        })
    }

    pub(crate) fn set_paths(&mut self, paths: Vec<String>) {
        let total = paths.len();
        self.paths = paths.into_iter().take(32).collect();
        loop {
            let omitted = (total - self.paths.len()) as u64;
            self.paths_omitted = (omitted > 0).then_some(omitted);
            let size = serde_json::to_vec(&Stored {
                schema_version: 2,
                failure: self.clone(),
                paths: self.paths.clone(),
                paths_omitted: self.paths_omitted,
            })
            .expect("failure diagnostic is serializable")
            .len() as u64;
            if size <= MAX_BYTES || self.paths.is_empty() {
                break;
            }
            self.paths.pop();
        }
    }

    fn persist_using(
        &self,
        dir: &Path,
        write: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
    ) -> io::Result<()> {
        crate::fsutil::verify_owner_only(dir)?;
        let mut durable = self.clone();
        // A rename may succeed before directory fsync fails. Neither this
        // file nor a recovered receipt can assert the writer's later result.
        durable.persisted = None;
        let bytes = serde_json::to_vec(&Stored {
            schema_version: if durable.paths.is_empty() && durable.paths_omitted.is_none() {
                1
            } else {
                2
            },
            paths: std::mem::take(&mut durable.paths),
            paths_omitted: durable.paths_omitted.take(),
            failure: durable,
        })
        .map_err(io::Error::other)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(io::Error::other("failure diagnostic exceeds bound"));
        }
        write(&dir.join(FILE), &bytes)
    }

    /// Bounded owner-only read; never opens a symlink or copies other state.
    pub(crate) fn load(dir: &Path) -> io::Result<Option<Self>> {
        let path = dir.join(FILE);
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
            Ok(_) => crate::fsutil::verify_owner_only(&path)?,
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path)?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(io::Error::other("failure diagnostic exceeds bound"));
        }
        let stored: Stored = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if !matches!(stored.schema_version, 1 | 2)
            || stored.failure.persisted.is_some()
            || stored.failure.generation.is_some_and(|g| g != 0)
        {
            return Err(io::Error::other("unsupported failure diagnostic"));
        }
        let mut failure = stored.failure;
        failure.paths = stored.paths;
        failure.paths_omitted = stored.paths_omitted;
        Ok(Some(failure))
    }
}

/// Publish a local in-memory failure, close the serving gate, persist,
/// THEN poll stop. Persistence failure never permits serving or prevents stop:
/// status retains persisted=Some(false), while any recovered receipt is null.
pub(crate) async fn retain_and_stop(
    shared: &Shared,
    dir: &Path,
    failure: Failure,
    fail_closed: impl FnOnce(),
    stop: impl std::future::Future<Output = ()>,
) {
    retain_and_stop_using(
        shared,
        dir,
        failure,
        fail_closed,
        stop,
        crate::fsutil::write_atomic,
    )
    .await;
}

// Fault-injection seam exercises the exact same close/persist/stop ordering.
async fn retain_and_stop_using(
    shared: &Shared,
    dir: &Path,
    mut failure: Failure,
    fail_closed: impl FnOnce(),
    stop: impl std::future::Future<Output = ()>,
    write: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) {
    failure.persisted = Some(false);
    *shared.lock().unwrap_or_else(|e| e.into_inner()) = Some(failure.clone());
    fail_closed();
    failure.persisted = Some(failure.persist_using(dir, write).is_ok());
    *shared.lock().unwrap_or_else(|e| e.into_inner()) = Some(failure);
    stop.await;
}

#[cfg(test)]
#[path = "sync_failure_tests.rs"]
mod tests;
