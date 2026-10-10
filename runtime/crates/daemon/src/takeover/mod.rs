//! The local takeover driver (local migration): this
//! daemon takes over the collections an old mdbase Connect connector on this device
//! served, through `mdbn_takeover::takeover::take_over` (T0–T6).
//!
//! **When.** Automatic runs (daemon start and after sign-in) ask Connect's
//! authenticated `/v1/next/rollout` for fresh permission: only an already-flipped
//! next account may proceed, not merely a released cohort. Unpaired, unreachable,
//! malformed and denied responses leave legacy state untouched. A manual install
//! is not a migration trigger. `mdbase migrate start` is a separate explicit,
//! authenticated operator path.
//!
//! **Steps of one run** ([`run`]):
//! 1. The record (`<state>/takeover.json`, [`record`]) is loaded; an unreadable one
//!    fails closed. `rolled_back` stops here.
//! 2. Once a takeover has started, the old service is stopped and disabled again at
//!    every run, and a held `daemon.lock` afterwards is reported as
//!    `old_connector_revived`.
//! 3. Discover (T0): local-authority collections from the old registry. Folders with a
//!    v1 mirror marker, a foreign claim or an invalid marker are postponed.
//! 4. Before the first T1 only:
//!    - **old mirrors**: T1 stops the whole old daemon, which also runs hosted
//!      mirrors. Until mirror join lands, a device with registered mirrors is
//!      postponed, so the old daemon keeps uploading their queued edits; with
//!      `stop_mirrors` it proceeds only once every mirror's queue is empty;
//!    - **journal drain**: wait (bounded) for the old daemon to finish in-flight
//!      requests (`claimed`/`prepared`/`applied` without a receipt), so fewer
//!      outcomes are unknown. Whatever is still in flight is settled by T4 (engine
//!      transactions roll forward through the guarded publish, or are held) and
//!      kept as evidence; it was never acknowledged (§1).
//! 5. `started` is saved before T1, then each collection is taken over, and the
//!    record is saved after each. `complete` once every collection is complete or
//!    held.
//!
//! Crash-safety comes from the library (every step idempotent, the v2 marker last)
//! plus this record: a run that dies anywhere is resumed by the next start.
//! Old files are never modified (T4's roll-forward completes the user's own
//! committed-but-unpublished write, keeping the replaced bytes); the old state
//! directory is left in place for rollback (§6.1).

pub mod adapter;
pub mod mirror_driver;
pub mod mirror_evidence;
pub mod mirror_hold;
pub mod record;
pub mod retirement;

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mdbn_legacy::connector::{ConnectorState, JournalState};
use mdbn_legacy::marker::{self, Marker};
use mdbn_takeover::OldService;
use mdbn_takeover::takeover::{self, Claim, Outcome as LibOutcome, Settled};

use adapter::Adapter;
use record::{Collection, CollectionState, Record, State};

/// The message an old connector shows for a claimed folder (takeover marker contract).
pub const NOTICE: &str = "This folder is now managed by the new mdbase app. \
     This version of mdbase Connect is retired: update to keep syncing.";

/// Options for one run.
#[derive(Clone, Debug)]
pub struct Options {
    /// Proceed past registered old mirrors once their queues are empty.
    pub stop_mirrors: bool,
    /// How long to wait for the old daemon's in-flight requests (before the first T1).
    pub drain: Duration,
    /// RFC 3339 time of this run (the record and the marker's `claimed_at`).
    pub now: String,
}

/// The default drain bound.
pub const DRAIN: Duration = Duration::from_secs(30);

/// A collection the server should register (serve as local-only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToRegister {
    /// The legacy collection ID (kept).
    pub collection: String,
    /// The folder.
    pub root: PathBuf,
    /// The old display name.
    pub name: String,
}

/// What a run did.
#[derive(Debug, Default)]
pub struct Ran {
    /// The record after the run (`None`: no old state and no record).
    pub record: Option<Record>,
    /// Collections taken over (now or earlier) and not yet registered.
    pub register: Vec<ToRegister>,
    /// The old daemon came back after the takeover started.
    pub revived: bool,
    /// Journal rows still in flight when the drain ended (first run only).
    pub undrained: usize,
}

/// Where this daemon's takeover state lives.
#[derive(Clone, Debug)]
pub struct Paths {
    /// `<state>/takeover.json`.
    pub record: PathBuf,
    /// `<state>/legacy`.
    pub legacy: PathBuf,
    /// `<state>/store-ids.json`.
    pub store_ids: PathBuf,
}

impl Paths {
    /// For a profile's state directory.
    pub fn new(state_dir: &Path, store_ids: PathBuf) -> Paths {
        Paths {
            record: state_dir.join("takeover.json"),
            legacy: state_dir.join("legacy"),
            store_ids,
        }
    }
}

fn legacy(e: mdbn_legacy::Error) -> io::Error {
    io::Error::other(e.to_string())
}

/// Requests the old daemon has not finished (never acknowledged).
fn in_flight(old_state_dir: &Path) -> io::Result<usize> {
    let s = ConnectorState::open(old_state_dir).map_err(legacy)?;
    Ok(s.journal()
        .map_err(legacy)?
        .iter()
        .filter(|r| match r.state {
            JournalState::Claimed | JournalState::Prepared => true,
            JournalState::Applied => r.response_receipt().is_none(),
            _ => false,
        })
        .count())
}

fn old_daemon_running(old_state_dir: &Path) -> io::Result<bool> {
    let lock = mdbn_legacy::lock::daemon_lock_path(old_state_dir);
    Ok(mdbn_legacy::lock::try_exclusive(&lock)
        .map_err(legacy)?
        .is_none())
}

/// Why old mirrors keep this device from taking over now, if they do.
fn mirrors_block(old_state_dir: &Path, stop_mirrors: bool) -> io::Result<Option<&'static str>> {
    use mdbn_legacy::mirror;
    let mirrors: Vec<_> = mirror::read_registry(old_state_dir)
        .map_err(legacy)?
        .into_iter()
        .filter(|m| m.lifecycle != "removing")
        .collect();
    if mirrors.is_empty() {
        return Ok(None);
    }
    if !stop_mirrors {
        return Ok(Some("mirrors_present"));
    }
    for m in &mirrors {
        let Some(state) = mirror::read_rust_state(old_state_dir, &m.replica_id).map_err(legacy)?
        else {
            return Ok(Some("mirror_state_unreadable"));
        };
        if !state.unreceipted.is_empty()
            || !mirror::queued_writes(&state, &m.path)
                .map_err(legacy)?
                .is_empty()
        {
            return Ok(Some("mirror_queue_not_empty"));
        }
    }
    Ok(None)
}

fn settle_overall(r: &mut Record) {
    r.state = if r.all_settled() {
        State::Complete
    } else if r.collections.values().all(|c| {
        matches!(
            c.state,
            CollectionState::Postponed | CollectionState::Pending
        )
    }) && r
        .collections
        .values()
        .any(|c| c.state == CollectionState::Postponed)
    {
        State::Postponed
    } else {
        State::Started
    };
}

/// Run (or resume) the takeover of the connector state in `old_state_dir`.
pub fn run(
    paths: &Paths,
    old_state_dir: &Path,
    old: &mut dyn OldService,
    opts: &Options,
) -> io::Result<Ran> {
    let mut ran = Ran::default();
    let prior = Record::load(&paths.record)?;
    if prior
        .as_ref()
        .is_some_and(|r| r.old_state_dir != old_state_dir)
    {
        return Err(io::Error::other(
            "the takeover record names another connector state directory",
        ));
    }
    if prior.as_ref().is_some_and(|r| r.state == State::RolledBack) {
        ran.record = prior;
        return Ok(ran);
    }
    let started = prior.as_ref().is_some_and(|r| r.state.fences_old_service());
    if started {
        // Fence a revived old service at every start.
        if let Err(e) = old.stop_and_disable() {
            tracing::warn!(error = %e, "could not stop the old connector again");
        }
        ran.revived = old_daemon_running(old_state_dir)?;
    }
    if !old_state_dir.join("connector.sqlite").is_file() {
        ran.record = prior;
        return Ok(ran);
    }

    // T0: discover.
    let state = ConnectorState::open(old_state_dir).map_err(legacy)?;
    let listed = state.collections().map_err(legacy)?;
    drop(state);
    let mut record = prior.unwrap_or_else(|| Record {
        schema_version: record::SCHEMA_VERSION,
        state: State::Started,
        updated_at: opts.now.clone(),
        old_state_dir: old_state_dir.to_path_buf(),
        collections: BTreeMap::new(),
    });
    let ids = crate::registry::StoreIds::load(&paths.store_ids)
        .map_err(|e| io::Error::other(e.to_string()))?;
    let mut candidates = Vec::new();
    let mut names = BTreeMap::new();
    for c in listed {
        if c.authority_state.as_deref() == Some("retired") {
            continue; // Authority moved to hosted: the hosted import owns it.
        }
        names.insert(c.id.clone(), c.display_name.clone());
        let entry = record
            .collections
            .entry(c.id.clone())
            .or_insert_with(|| Collection::new(CollectionState::Pending));
        if matches!(
            entry.state,
            CollectionState::Complete | CollectionState::Held | CollectionState::RolledBack
        ) {
            continue;
        }
        if !c.path.is_dir() {
            // Nothing on disk to take over; the old state stays retained (§6).
            entry.state = CollectionState::Held;
            entry.reason = Some("folder_missing".into());
            continue;
        }
        let blocked = match marker::read(&c.path) {
            Ok(Marker::Absent) => None,
            Ok(Marker::Claimed {
                collection,
                replica_id,
            }) if collection == c.id && ids.get(&c.id) == Some(replica_id.as_str()) => None,
            Ok(Marker::Mirror { .. }) => Some("mirror_folder"),
            Ok(Marker::Claimed { .. }) => Some("claimed_by_other_replica"),
            Ok(Marker::Invalid(_)) | Err(_) => Some("invalid_marker"),
        };
        match blocked {
            Some(why) => {
                entry.state = CollectionState::Postponed;
                entry.reason = Some(why.into());
            }
            None => candidates.push(c),
        }
    }

    if !started && !candidates.is_empty() {
        if let Some(why) = mirrors_block(old_state_dir, opts.stop_mirrors)? {
            for c in &candidates {
                let e = record.collections.get_mut(&c.id).expect("discovered");
                e.state = CollectionState::Postponed;
                e.reason = Some(why.into());
            }
            record.state = State::Postponed;
            record.updated_at = opts.now.clone();
            record.save(&paths.record)?;
            ran.record = Some(record);
            return Ok(ran);
        }
        // Only a running old daemon (it holds daemon.lock) can finish anything.
        let deadline = Instant::now() + opts.drain;
        loop {
            ran.undrained = in_flight(old_state_dir)?;
            if ran.undrained == 0
                || Instant::now() >= deadline
                || !old_daemon_running(old_state_dir)?
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    // Before T1: durably `started`.
    if !candidates.is_empty() {
        record.state = State::Started;
    } else {
        settle_overall(&mut record);
    }
    record.updated_at = opts.now.clone();
    record.save(&paths.record)?;

    let mut store_ids = BTreeMap::new();
    for c in &candidates {
        let id = crate::registry::StoreIds::get_or_issue(&paths.store_ids, &c.id)
            .map_err(|e| io::Error::other(e.to_string()))?;
        store_ids.insert(c.id.clone(), id);
    }
    let mut adapter = Adapter::new(paths.legacy.clone(), store_ids);
    for c in &candidates {
        adapter.begin(&c.id);
        let evidence = Adapter::collection_dir(&paths.legacy, &c.id).join("evidence");
        crate::fsutil::ensure_private_dir(&paths.legacy)?;
        crate::fsutil::ensure_private_dir(&Adapter::collection_dir(&paths.legacy, &c.id))?;
        let claim = Claim {
            claimed_at: &opts.now,
            notice: NOTICE,
        };
        let out = takeover::take_over(
            old_state_dir,
            &c.id,
            &evidence,
            claim,
            takeover::Options::PRODUCTION,
            old,
            &mut adapter,
        );
        let e = record.collections.get_mut(&c.id).expect("discovered");
        match out {
            Ok(LibOutcome::TakenOver(report)) => {
                let holds = report
                    .settled
                    .iter()
                    .filter(|s| matches!(s, Settled::Held { .. }))
                    .count() as u64;
                e.rolled_forward = report.settled.len() as u64 - holds;
                e.holds = holds;
                e.state = if holds > 0 {
                    CollectionState::Held
                } else {
                    CollectionState::Complete
                };
                e.reason = None;
                tracing::info!(
                    collection = %c.id,
                    rolled_forward = e.rolled_forward,
                    holds,
                    receipts = report.receipts,
                    "collection taken over from the old connector"
                );
            }
            Ok(LibOutcome::AlreadyTakenOver) => {
                // A run that crashed after T6 left the counts in its import only.
                if let Some(ev) = adapter::Evidence::load(&paths.legacy, &c.id)? {
                    e.holds = ev.holds.len() as u64;
                    e.rolled_forward = ev.rolled_forward.len() as u64;
                }
                e.state = if e.holds > 0 {
                    CollectionState::Held
                } else {
                    CollectionState::Complete
                };
                e.reason = None;
            }
            Ok(LibOutcome::Postponed(why)) => {
                tracing::warn!(collection = %c.id, reason = %why, "takeover postponed");
                e.state = CollectionState::Postponed;
                e.reason = Some(
                    if why.contains("daemon.lock") {
                        "old_daemon_running"
                    } else {
                        "folder_locked"
                    }
                    .into(),
                );
            }
            Err(err) => {
                tracing::error!(collection = %c.id, error = %err, "takeover failed; retried at next start");
                e.state = CollectionState::Pending;
                e.reason = Some("takeover_failed".into());
            }
        }
        record.updated_at = opts.now.clone();
        record.save(&paths.record)?;
    }
    if !candidates.is_empty() {
        // `complete` once all are settled; `postponed` only if no collection got past
        // T1 (the old daemon could not be stopped or the folders were locked).
        settle_overall(&mut record);
        record.save(&paths.record)?;
    }

    // Everything taken over and not yet registered (now, or by an earlier run).
    for (id, c) in &record.collections {
        if matches!(c.state, CollectionState::Complete | CollectionState::Held) && !c.registered {
            let root = adapter
                .registered
                .iter()
                .find(|(x, _)| x == id)
                .map(|(_, r)| r.clone())
                .or_else(|| {
                    adapter::Evidence::load(&paths.legacy, id)
                        .ok()
                        .flatten()
                        .map(|e| e.root)
                });
            if let Some(root) = root
                && root.is_dir()
            {
                ran.register.push(ToRegister {
                    collection: id.clone(),
                    name: names.get(id).cloned().unwrap_or_else(|| id.clone()),
                    root,
                });
            }
        }
    }
    // The marker guard (takeover marker contract): a taken-over folder must still carry this
    // daemon's v2 claim. A missing or altered marker is a sticky incident, reported
    // and never silently rewritten (an old agent may have been revived).
    let mut incident = false;
    for (id, c) in record.collections.iter_mut() {
        if !matches!(c.state, CollectionState::Complete | CollectionState::Held)
            || c.reason.as_deref() == Some("folder_missing")
        {
            continue;
        }
        let Some(root) = adapter::Evidence::load(&paths.legacy, id)?.map(|e| e.root) else {
            continue;
        };
        if !marker_is_ours(&root, id, &paths.store_ids)? && !c.marker_incident {
            tracing::error!(collection = %id, "marker_incident: the takeover's v2 marker is missing or altered");
            c.marker_incident = true;
            incident = true;
        }
    }
    if incident {
        record.updated_at = opts.now.clone();
        record.save(&paths.record)?;
    }
    ran.record = Some(record);
    Ok(ran)
}

/// Whether `root` still carries this daemon's v2 claim for `collection`.
pub fn marker_is_ours(root: &Path, collection: &str, store_ids: &Path) -> io::Result<bool> {
    let ids =
        crate::registry::StoreIds::load(store_ids).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(match marker::read(root) {
        Ok(Marker::Claimed {
            collection: c,
            replica_id,
        }) => c == collection && ids.get(collection) == Some(replica_id.as_str()),
        _ => false,
    })
}

/// Mark `collection` registered in the record.
pub fn mark_registered(paths: &Paths, collection: &str, now: &str) -> io::Result<()> {
    let Some(mut r) = Record::load(&paths.record)? else {
        return Ok(());
    };
    if let Some(c) = r.collections.get_mut(collection)
        && !c.registered
    {
        c.registered = true;
        r.updated_at = now.to_owned();
        r.save(&paths.record)?;
    }
    Ok(())
}

/// Note why registration is still pending (e.g. not signed in).
pub fn note_registration(
    paths: &Paths,
    collection: &str,
    reason: &str,
    now: &str,
) -> io::Result<()> {
    let Some(mut r) = Record::load(&paths.record)? else {
        return Ok(());
    };
    if let Some(c) = r.collections.get_mut(collection)
        && c.reason.as_deref() != Some(reason)
    {
        c.reason = Some(reason.to_owned());
        r.updated_at = now.to_owned();
        r.save(&paths.record)?;
    }
    Ok(())
}

/// The current UTC time, RFC 3339.
pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

/// The old connector's state directory for this profile, if it should be taken over.
///
/// The installed profile uses the connector's own default (or
/// `MDBASE_CONNECT_HOME`). An isolated profile (tests, LAB) only ever looks at an
/// explicit `MDBASE_CONNECT_HOME`, and never touches service managers (see
/// [`IsolatedOldService`]).
pub fn old_state_dir(profile: &crate::paths::Profile) -> Option<PathBuf> {
    let env = crate::service::legacy::Environment::from_process();
    match profile.target {
        crate::paths::Target::InstalledService => env.connector_state_dir(),
        crate::paths::Target::IsolatedProfile => {
            ISOLATED_OLD_STATE.get().cloned().or(env.connect_home)
        }
    }
}

static ISOLATED_OLD_STATE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Tests: the old connector state an *isolated* profile takes over, without
/// setting `MDBASE_CONNECT_HOME` in the test process. The installed profile never
/// reads it; no CLI flag, file or environment variable reaches it.
#[doc(hidden)]
pub fn set_isolated_old_state_dir_for_tests(dir: PathBuf) {
    let _ = ISOLATED_OLD_STATE.set(dir);
}

/// T1 for an isolated profile: no service manager is touched (it would reach the
/// user's real connector). The old daemon's `daemon.lock` alone decides: a running
/// old daemon postpones the takeover.
#[derive(Debug, Default)]
pub struct IsolatedOldService;

impl OldService for IsolatedOldService {
    fn stop_and_disable(&mut self) -> Result<(), String> {
        Ok(())
    }
}

/// The server's takeover state: one run at a time, and what the last one found.
#[derive(Debug, Default)]
pub struct Gate {
    /// Held for a run.
    pub run: tokio::sync::Mutex<()>,
    /// The old connector came back after the takeover started.
    pub revived: std::sync::atomic::AtomicBool,
    /// Automatic takeover is waiting for a flipped account's server permission.
    pub waiting_for_batch: std::sync::atomic::AtomicBool,
    /// Latest current retirement response or safe pending reason (not authorization).
    pub retirement: std::sync::Mutex<Option<serde_json::Value>>,
    /// The last run's error, for `doctor` (no content, no secrets).
    pub error: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
mod tests;
