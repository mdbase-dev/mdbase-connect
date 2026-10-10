//! The driver state machine. See the module docs of [`super`].

use mdbn_wire::common::{B16, B32};

use super::checkpoint::{Checkpoint, Step};
use super::read::{Need, ReadGen, spill_err};
use super::replay::{Batch, mutation_id, take_batch};
use super::{Generation, ImportStats, Key, Meta, SourceRow, Spill, Table, live_of};
use crate::budget::{MAX_HYDRATE_BYTES, MAX_HYDRATE_RECORDS};
use crate::live_digest::LiveDigest;
use crate::{Error, Result};

/// Imports restarted from H2 (crash before the base, or the uploads aged out)
/// before the driver gives up and rolls back.
pub const MAX_ATTEMPTS: u64 = 5;

/// Why the host should come back later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// The rollout is paused and this account has not fenced anything.
    Paused,
    /// Legacy is fenced and accepted pending writes are still draining.
    Draining,
    /// The cloud-copy collection exists but its service keying/admission is not
    /// verified yet (H1): postpone, routes stay closed.
    Keying,
}

/// What the host must do next. Each is one bounded request; the host reports the
/// result through [`Driver::complete`] (except `Wait`, `Continue` and `Done`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// H0: ensure the legacy backup hold and 90-day retention for this collection
    /// (rows and every referenced R2 object). → `Backup`.
    EnsureBackup,
    /// H1: service-create (or find) the cloud-copy collection with the legacy ID;
    /// report whether hosted keying, enrolment and policy admission are verified.
    /// → `Created`.
    CreateCollection,
    /// Open the consistent legacy read: at `S0` the collection must be `active`;
    /// for `Final` it must be `migrating` at `expect_head`. → `Opened`.
    OpenSource {
        /// Which read.
        generation: Generation,
        /// The head it must be at (`Final` only).
        expect_head: Option<u64>,
    },
    /// The next metadata page of a table in the open read, primary-key order,
    /// at most `max_rows` rows and `max_bytes` decoded bytes. → `Page`.
    ReadPage {
        /// Which read.
        generation: Generation,
        /// Which table.
        table: Table,
        /// The source's opaque cursor.
        cursor: Option<String>,
        /// Row bound.
        max_rows: usize,
        /// Byte bound.
        max_bytes: usize,
    },
    /// H3/H4: stream, verify, seal and stage generation 0 for the next window of S0
    /// placements after `after` (from `Spill::placements_in_bucket`), within the
    /// batch budgets. Resources first (`bucket = None`), then every numbered
    /// bucket. → `Gen0Progress` (`done` means this bucket, not the collection).
    ImportGen0 {
        /// Bucket bits, fixed by the completed S0 read.
        bits: u64,
        /// `None` for resources; otherwise the snapshot bucket number.
        bucket: Option<u64>,
        /// The last placement already staged in this bucket.
        after: Option<Key>,
    },
    /// H4: seal the generation-0 manifest (ref-index objects when the refs do not
    /// fit one request) and verify every uploaded ref. → `Gen0Built`.
    FinishGen0,
    /// H4: append `base {hosted-import, legacy_collection}`. → `Appended`,
    /// `Unknown` or `Stale`.
    AppendBase {
        /// The generation-0 manifest.
        manifest: B32,
        /// Its state digest.
        state_digest: B32,
    },
    /// Settle an unknown base append by log evidence. → `Found`.
    FindBase,
    /// A **fresh** DO cache rebuild (wipe, then authenticated snapshot/base + tail)
    /// to at least `at_least`. → `Rebuilt`.
    Rebuild {
        /// The log position the rebuild must reach.
        at_least: u64,
    },
    /// The next page of the rebuilt cache's live entities. → `NewPage`.
    ReadNew {
        /// The cache's opaque cursor.
        cursor: Option<String>,
    },
    /// The rollout's pause gate ([`super::may_fence`]). → `MayFence`.
    MayFence,
    /// H6: set the legacy collection `migrating` (fences every mutation/upload
    /// path; idempotent). → `Ok`.
    Fence,
    /// H6: how many accepted legacy writes are still pending, and the head. →
    /// `Drain`.
    DrainStatus,
    /// H8: list the non-revoked mirror/application replica IDs. → `Replicas`.
    ListReplicas,
    /// H8: revoke exactly these replica IDs (idempotent). → `Ok`.
    RevokeReplicas {
        /// The IDs.
        ids: Vec<String>,
    },
    /// H9: append `migration-cutover` (unfreeze). → `Appended`, `Unknown` or
    /// `Conflict`.
    AppendCutover {
        /// The drained legacy head.
        s_final: u64,
    },
    /// Settle an unknown cutover append by log evidence. → `Found`.
    FindCutover,
    /// H9: append one replay batch as one signed mutation with its stable ID. →
    /// `Appended`, `Unknown` or `Conflict`.
    Replay(Batch),
    /// Settle an unknown replay append by log evidence. → `Found`.
    FindMutation {
        /// The batch's mutation ID.
        mutation: B16,
    },
    /// Barrier F: the log head. → `Head`.
    LogHead,
    /// H10: route the collection to the new system and mark legacy `migrated`
    /// (read-only, retained 90 days), and record the cutover with the control
    /// plane (`POST …/collections/:id/cutover` with these facts; the account flip's
    /// evidence is [`super::flip_evidence`] over them). Idempotent. → `Ok`.
    Route {
        /// The drained legacy head.
        s_final: u64,
        /// The `migration-cutover` item's position (old mirrors' join sync point C).
        cutover_seq: u64,
        /// Barrier F.
        barrier_f: u64,
        /// The live digest at F (`LiveDigest::digest`).
        final_digest: B32,
    },
    /// Rollback: un-revoke these replica IDs. → `Ok`.
    Unrevoke {
        /// The IDs.
        ids: Vec<String>,
    },
    /// Rollback: set the legacy collection back to `active`. → `Ok`.
    Unfence,
    /// Nothing to do now; poll again later.
    Wait(Wait),
    /// Synchronous work was done; poll again (lets the host bound one request).
    Continue,
    /// Terminal.
    Done(Step),
}

/// The result of an [`Action`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Done, nothing to report.
    Ok,
    /// H0 hold in force.
    Backup {
        /// The hold ID.
        hold: String,
    },
    /// H1.
    Created {
        /// Service keying and admission are verified.
        verified: bool,
    },
    /// The read is open at this legacy head.
    Opened {
        /// The head.
        head: u64,
    },
    /// A metadata page.
    Page {
        /// Rows.
        rows: Vec<SourceRow>,
        /// The next cursor, or `None` at the end of the table.
        next: Option<String>,
    },
    /// Generation-0 staging progress.
    Gen0Progress {
        /// The last placement staged by this window.
        last: Option<Key>,
        /// No placements remain in the current resource/numbered bucket.
        done: bool,
    },
    /// The generation-0 manifest.
    Gen0Built {
        /// Its address.
        manifest: B32,
        /// Its state digest.
        state_digest: B32,
    },
    /// The append is in the log at `seq`.
    Appended {
        /// Its position.
        seq: u64,
    },
    /// The append's outcome is unknown (lost reply, eviction).
    Unknown,
    /// The log already holds a conflicting item (another cutover, a used ID).
    Conflict,
    /// The import's uploads are gone (object GC window): redo from H2.
    Stale,
    /// Log evidence for a find.
    Found {
        /// The position, or `None` if absent.
        seq: Option<u64>,
    },
    /// The cache was rebuilt fresh up to `head`.
    Rebuilt {
        /// Its head.
        head: u64,
    },
    /// A page of the rebuilt cache's live entities.
    NewPage {
        /// Entities (resources keyed by their current path).
        rows: Vec<(Key, Meta)>,
        /// The next cursor, or `None` at the end.
        next: Option<String>,
    },
    /// The pause gate's answer.
    MayFence(bool),
    /// Drain state.
    Drain {
        /// Accepted legacy writes not yet applied.
        pending: u64,
        /// The legacy head.
        head: u64,
    },
    /// Non-revoked replica IDs.
    Replicas {
        /// IDs.
        ids: Vec<String>,
    },
    /// The log head.
    Head {
        /// Its position.
        seq: u64,
    },
    /// The collection or its account was deleted (deletion is terminal).
    Gone,
    /// The action failed. Transient failures are retried as they are.
    Failed {
        /// Retry the same action.
        transient: bool,
        /// Why (IDs and counts only).
        reason: String,
    },
}

#[derive(Debug)]
enum Ram {
    Idle,
    Read(Box<ReadGen>),
    Gen0 {
        read: Box<(u64, LiveDigest, ImportStats)>,
        bucket: Option<u64>,
        after: Option<Key>,
        done: bool,
    },
    /// An append whose outcome must first be looked up (after a restart or an
    /// unknown reply), or sent.
    Append {
        find_first: bool,
    },
    Compare {
        against: Generation,
        rebuilt: bool,
        cursor: Option<String>,
        digest: Box<LiveDigest>,
    },
    /// Fence-first: the fence is acknowledged; drain next.
    Drain,
    /// Tell the host to come back later, once.
    Wait(Wait),
    /// Pre-cutover parking allocation check, after this diff key.
    ParkCheck(Option<Key>),
    /// Every parking path allocates: the cutover intent may be saved.
    ParkChecked,
    /// The final compare matched: route.
    Route,
    Replay {
        batch: Option<Batch>,
        find_first: bool,
    },
}

/// The driver for one collection. See [`super`].
#[derive(Debug)]
pub struct Driver {
    cp: Checkpoint,
    ram: Ram,
}

impl Driver {
    /// Resume from the spill's checkpoint, or start `collection` afresh. RAM state
    /// is rebuilt from the durable step: any in-flight append is first looked up.
    pub fn resume(spill: &mut dyn Spill, collection: &str) -> Result<Driver> {
        Self::resume_mode(spill, collection, false)
    }

    /// [`Self::resume`], starting a new migration in fence-first mode when
    /// `fence_first`: legacy is fenced and drained before the import, so S0 is
    /// `S_final` and the H9 replay is empty. The longer read-only window is the
    /// price; no delta capture is needed. An existing checkpoint keeps its mode.
    pub fn resume_mode(
        spill: &mut dyn Spill,
        collection: &str,
        fence_first: bool,
    ) -> Result<Driver> {
        let cp = match spill.load().map_err(spill_err)? {
            Some(b) => Checkpoint::from_bytes(&b)?,
            None => Checkpoint {
                fence_first,
                ..Checkpoint::new(collection)
            },
        };
        if cp.collection != collection {
            return Err(Error::Invalid(
                "checkpoint belongs to another collection".into(),
            ));
        }
        let ram = match cp.step {
            Step::BaseIntent | Step::CutoverIntent => Ram::Append { find_first: true },
            Step::Replaying => Ram::Replay {
                batch: None,
                find_first: cp.intent_mutation.is_some(),
            },
            _ => Ram::Idle,
        };
        Ok(Driver { cp, ram })
    }

    /// The durable state.
    pub fn checkpoint(&self) -> &Checkpoint {
        &self.cp
    }

    /// The completed S0 read's counts, while staging generation 0. Recomputed
    /// after eviction alongside the source read; never trusted from a host claim.
    pub fn import_stats(&self) -> Option<ImportStats> {
        match &self.ram {
            Ram::Gen0 { read, .. } => Some(read.2),
            _ => None,
        }
    }

    /// The step the account rollout should see: a fence-first collection that has
    /// fenced counts as fenced (mid-cutover) before its import finishes.
    pub fn status_step(&self) -> Step {
        if self.cp.fenced && self.cp.step < Step::Fenced {
            Step::Fenced
        } else {
            self.cp.step
        }
    }

    /// Request a rollback to legacy. Refused from the cutover intent on (6A).
    pub fn rollback(&mut self, spill: &mut dyn Spill, reason: &str) -> Result<()> {
        if self.cp.step.is_terminal() || self.cp.step == Step::RollingBack {
            return Ok(());
        }
        if !self.cp.step.can_roll_back() {
            return Err(Error::Invalid(
                "rollback after the cutover intent needs the manual procedure".into(),
            ));
        }
        self.cp.failure.get_or_insert_with(|| reason.to_owned());
        self.ram = Ram::Idle;
        self.save_step(spill, Step::RollingBack)
    }

    /// The next action.
    pub fn poll(&mut self, spill: &mut dyn Spill) -> Result<Action> {
        use Step::*;
        if let Ram::Wait(w) = self.ram {
            self.ram = Ram::Idle;
            return Ok(Action::Wait(w));
        }
        Ok(match self.cp.step {
            Start => Action::EnsureBackup,
            BackupHeld => Action::CreateCollection,
            Created if self.cp.fence_first && self.cp.s_final.is_none() => {
                // Fence-first: fence and drain before reading S0.
                if !self.cp.fenced {
                    Action::MayFence
                } else if matches!(self.ram, Ram::Drain) {
                    Action::DrainStatus
                } else {
                    Action::Fence
                }
            }
            Created => return self.poll_import(spill),
            BaseIntent => match self.ram {
                Ram::Append { find_first: true } => Action::FindBase,
                _ => Action::AppendBase {
                    manifest: self.cp.manifest.ok_or_else(missing)?,
                    state_digest: self.cp.state_digest.ok_or_else(missing)?,
                },
            },
            BaseAppended => self.poll_compare(Generation::S0)?,
            Shadowed if self.cp.fenced => Action::Fence,
            Shadowed => Action::MayFence,
            Fenced => Action::DrainStatus,
            Drained => return self.poll_read(spill, Generation::Final),
            Verified => {
                if self.cp.revoked.is_empty() {
                    Action::ListReplicas
                } else {
                    Action::RevokeReplicas {
                        ids: self.cp.revoked.clone(),
                    }
                }
            }
            Revoked if !matches!(self.ram, Ram::ParkChecked) => {
                // Before the irreversible cutover intent: every parking path the
                // replay will use must allocate deterministically. One bounded page per poll.
                return self.poll_park_check(spill);
            }
            Revoked => {
                self.ram = Ram::Append { find_first: false };
                self.save_step(spill, CutoverIntent)?;
                Action::AppendCutover {
                    s_final: self.cp.s_final.ok_or_else(missing)?,
                }
            }
            CutoverIntent => match self.ram {
                Ram::Append { find_first: true } => Action::FindCutover,
                _ => Action::AppendCutover {
                    s_final: self.cp.s_final.ok_or_else(missing)?,
                },
            },
            Replaying => return self.poll_replay(spill),
            Replayed if matches!(self.ram, Ram::Route) => Action::Route {
                s_final: self.cp.s_final.ok_or_else(missing)?,
                cutover_seq: self.cp.cutover_seq.ok_or_else(missing)?,
                barrier_f: self.cp.barrier_f.ok_or_else(missing)?,
                final_digest: LiveDigest::from_bytes(
                    self.cp.final_digest.as_deref().ok_or_else(missing)?,
                )?
                .digest(),
            },
            Replayed => self.poll_compare(Generation::Final)?,
            RollingBack => {
                if !self.cp.revoked.is_empty() {
                    Action::Unrevoke {
                        ids: self.cp.revoked.clone(),
                    }
                } else if self.cp.fenced {
                    Action::Unfence
                } else {
                    self.save_step(spill, RolledBack)?;
                    Action::Done(RolledBack)
                }
            }
            Routed | RolledBack | Failed | Gone => Action::Done(self.cp.step),
        })
    }

    /// Report the outcome of the action [`Self::poll`] returned.
    pub fn complete(&mut self, spill: &mut dyn Spill, outcome: Outcome) -> Result<()> {
        use Step::*;
        if outcome == Outcome::Gone {
            // Deleted: terminal from any step; no rollback, no route.
            self.ram = Ram::Idle;
            self.cp.failure = Some("collection or account deleted".into());
            return self.save_step(spill, Gone);
        }
        if let Outcome::Failed { transient, reason } = &outcome {
            if *transient {
                return Ok(());
            }
            return self.stop(spill, reason);
        }
        match (self.cp.step, outcome) {
            (Start, Outcome::Backup { hold }) => {
                self.cp.backup_hold = Some(hold);
                self.save_step(spill, BackupHeld)
            }
            (BackupHeld, Outcome::Created { verified: true }) => self.save_step(spill, Created),
            (BackupHeld, Outcome::Created { verified: false }) => {
                self.ram = Ram::Wait(Wait::Keying);
                Ok(())
            }
            (Created, Outcome::MayFence(false)) if self.cp.fence_first => {
                self.ram = Ram::Wait(Wait::Paused);
                Ok(())
            }
            (Created, Outcome::MayFence(true)) if self.cp.fence_first => {
                // Durable before the fence is sent: a rollback then always un-fences.
                self.cp.fenced = true;
                self.save(spill)
            }
            (Created, Outcome::Ok) if self.cp.fence_first && self.cp.s_final.is_none() => {
                self.ram = Ram::Drain;
                Ok(())
            }
            (Created, Outcome::Drain { pending, head })
                if self.cp.fence_first && self.cp.s_final.is_none() =>
            {
                if pending == 0 {
                    self.cp.s_final = Some(head);
                    self.ram = Ram::Idle;
                    self.save(spill)
                } else {
                    self.ram = Ram::Wait(Wait::Draining);
                    Ok(())
                }
            }
            (Created, o) => self.complete_import(spill, o),
            (BaseIntent, Outcome::Appended { seq })
            | (BaseIntent, Outcome::Found { seq: Some(seq) }) => {
                self.cp.base_seq = Some(seq);
                self.ram = Ram::Idle;
                self.save_step(spill, BaseAppended)
            }
            (BaseIntent, Outcome::Unknown) => {
                self.ram = Ram::Append { find_first: true };
                Ok(())
            }
            (BaseIntent, Outcome::Found { seq: None }) => {
                self.ram = Ram::Append { find_first: false };
                Ok(())
            }
            (BaseIntent, Outcome::Stale) => {
                self.restart_import(spill, "generation-0 uploads aged out")
            }
            (BaseAppended, o) => self.complete_compare(spill, Generation::S0, o),
            (Shadowed, Outcome::MayFence(false)) => {
                self.ram = Ram::Wait(Wait::Paused);
                Ok(())
            }
            (Shadowed, Outcome::MayFence(true)) => {
                // Durable before the fence is sent: a rollback then always un-fences.
                self.cp.fenced = true;
                self.save(spill)?;
                Ok(())
            }
            (Shadowed, Outcome::Ok) if self.cp.fenced => self.save_step(spill, Fenced),
            (Fenced, Outcome::Drain { pending, head }) => {
                if pending == 0 && self.cp.fence_first && self.cp.s_final != Some(head) {
                    return self.stop(spill, "fence-first: legacy moved while fenced");
                }
                if pending == 0 {
                    self.cp.s_final = Some(head);
                    self.ram = Ram::Idle;
                    self.save_step(spill, Drained)
                } else {
                    self.ram = Ram::Wait(Wait::Draining);
                    Ok(())
                }
            }
            (Drained, o) => self.complete_read(spill, Generation::Final, o),
            (Verified, Outcome::Replicas { ids }) => {
                if ids.is_empty() {
                    return self.save_step(spill, Revoked);
                }
                // Durable before the revoke is sent: a rollback un-revokes exactly these.
                self.cp.revoked = ids;
                self.save(spill)
            }
            (Verified, Outcome::Ok) if !self.cp.revoked.is_empty() => {
                self.save_step(spill, Revoked)
            }
            (CutoverIntent, Outcome::Appended { seq })
            | (CutoverIntent, Outcome::Found { seq: Some(seq) }) => {
                self.cp.cutover_seq = Some(seq);
                self.cp.replay_pass = 1;
                self.cp.replay_after = None;
                self.ram = Ram::Replay {
                    batch: None,
                    find_first: false,
                };
                self.save_step(spill, Replaying)
            }
            (CutoverIntent, Outcome::Unknown | Outcome::Conflict) => {
                self.ram = Ram::Append { find_first: true };
                Ok(())
            }
            (CutoverIntent, Outcome::Found { seq: None }) => {
                self.ram = Ram::Append { find_first: false };
                Ok(())
            }
            (Replaying, o) => self.complete_replay(spill, o),
            (Replayed, Outcome::Ok) if matches!(self.ram, Ram::Route) => {
                self.ram = Ram::Idle;
                self.save_step(spill, Routed)
            }
            (Replayed, o) => self.complete_compare(spill, Generation::Final, o),
            (RollingBack, Outcome::Ok) => {
                if !self.cp.revoked.is_empty() {
                    self.cp.revoked.clear();
                } else {
                    self.cp.fenced = false;
                }
                self.save(spill)
            }
            (step, o) => Err(Error::Invalid(format!(
                "outcome {} does not fit step {step:?}",
                outcome_name(&o)
            ))),
        }
    }

    // ----- H2–H4: the import read and generation 0 (RAM; restartable) -----

    fn poll_import(&mut self, spill: &mut dyn Spill) -> Result<Action> {
        match &mut self.ram {
            Ram::Gen0 {
                read,
                bucket,
                after,
                done,
            } => {
                if *done {
                    Ok(Action::FinishGen0)
                } else {
                    Ok(Action::ImportGen0 {
                        bits: read.2.bucket_bits(),
                        bucket: *bucket,
                        after: after.clone(),
                    })
                }
            }
            _ => self.poll_read(spill, Generation::S0),
        }
    }

    fn complete_import(&mut self, spill: &mut dyn Spill, o: Outcome) -> Result<()> {
        match (&mut self.ram, o) {
            (
                Ram::Gen0 {
                    read,
                    bucket,
                    after,
                    done,
                },
                Outcome::Gen0Progress { last, done: d },
            ) => {
                if *done || (last.is_none() && !d) {
                    return Err(Error::Invalid(
                        "generation-0 staging made no progress".into(),
                    ));
                }
                if let Some(l) = last {
                    if after.as_ref().is_some_and(|a| *a >= l) {
                        return Err(Error::Invalid("generation-0 staging went backwards".into()));
                    }
                    let resource = l.kind == crate::preflight::EntityKind::Resource;
                    let valid = match bucket {
                        None => resource,
                        Some(b) if !resource => {
                            let (lo, hi) = super::bucket_range(read.2.bucket_bits(), *b)?;
                            (lo..=hi).contains(&super::bucket16(&l)?)
                        }
                        Some(_) => false,
                    };
                    if !valid {
                        return Err(Error::Invalid(
                            "generation-0 staging crossed a bucket".into(),
                        ));
                    }
                    *after = Some(l);
                }
                if d {
                    let next = bucket.map_or(0, |b| b + 1);
                    *done = next == (1u64 << read.2.bucket_bits());
                    *bucket = Some(next);
                    *after = None;
                }
                Ok(())
            }
            (
                Ram::Gen0 {
                    read, done: true, ..
                },
                Outcome::Gen0Built {
                    manifest,
                    state_digest,
                },
            ) => {
                let (head, digest, _) = read.as_ref();
                self.cp.s0 = Some(*head);
                self.cp.s0_digest = Some(digest.to_bytes());
                self.cp.manifest = Some(manifest);
                self.cp.state_digest = Some(state_digest);
                self.ram = Ram::Append { find_first: false };
                self.save_step(spill, Step::BaseIntent)
            }
            (_, o) => self.complete_read(spill, Generation::S0, o),
        }
    }

    fn poll_read(&mut self, spill: &mut dyn Spill, generation: Generation) -> Result<Action> {
        if !matches!(&self.ram, Ram::Read(r) if r.generation == generation) {
            spill.clear(generation).map_err(spill_err)?;
            if generation == Generation::S0 {
                self.cp.attempts += 1;
                if self.cp.attempts > MAX_ATTEMPTS {
                    return self
                        .stop(spill, "import restarted too often")
                        .map(|()| Action::Continue);
                }
                self.save(spill)?;
            }
            self.ram = Ram::Read(Box::new(ReadGen::new(generation)));
        }
        let Ram::Read(r) = &mut self.ram else {
            unreachable!("set above")
        };
        Ok(match r.need() {
            Need::Open => Action::OpenSource {
                generation,
                // Present: the collection must be fenced (`migrating`) at exactly this head.
                expect_head: (generation == Generation::Final || self.cp.fence_first)
                    .then_some(self.cp.s_final)
                    .flatten(),
            },
            Need::Page(table, cursor) => Action::ReadPage {
                generation,
                table,
                cursor,
                max_rows: MAX_HYDRATE_RECORDS,
                max_bytes: MAX_HYDRATE_BYTES,
            },
            Need::Work => {
                if let Err(e) = r.work(spill) {
                    self.stop(spill, &e.to_string())?;
                }
                Action::Continue
            }
            Need::Done => {
                let Ram::Read(r) = std::mem::replace(&mut self.ram, Ram::Idle) else {
                    unreachable!("matched above")
                };
                match r.finish() {
                    Err(e) => self.stop(spill, &e.to_string())?,
                    Ok((head, digest, _summary, stats)) => match generation {
                        Generation::S0 => {
                            if let Err(e) = stats.hosted_fmt1_preflight() {
                                self.stop(spill, &e.to_string())?;
                                return Ok(Action::Continue);
                            }
                            self.ram = Ram::Gen0 {
                                read: Box::new((head, digest, stats)),
                                bucket: None,
                                after: None,
                                done: false,
                            };
                        }
                        Generation::Final => {
                            let bytes = digest.to_bytes();
                            if self.cp.fence_first
                                && self.cp.s0_digest.as_deref() != Some(bytes.as_slice())
                            {
                                // S0 is S_final: any difference is a fault, caught before cutover.
                                self.stop(spill, "fence-first: the S_final read differs from S0")?;
                            } else {
                                self.cp.final_digest = Some(bytes);
                                self.save_step(spill, Step::Verified)?;
                            }
                        }
                    },
                }
                Action::Continue
            }
        })
    }

    fn complete_read(
        &mut self,
        spill: &mut dyn Spill,
        generation: Generation,
        o: Outcome,
    ) -> Result<()> {
        let Ram::Read(r) = &mut self.ram else {
            return Err(Error::Invalid(format!(
                "outcome {} without a read in progress",
                outcome_name(&o)
            )));
        };
        match o {
            Outcome::Opened { head } => {
                if generation == Generation::S0
                    && self.cp.fence_first
                    && Some(head) != self.cp.s_final
                {
                    return self.stop(spill, "fence-first: legacy moved while fenced");
                }
                if generation == Generation::Final && Some(head) != self.cp.s_final {
                    // Legacy moved after the drain: drain again.
                    self.ram = Ram::Idle;
                    return self.save_step(spill, Step::Fenced);
                }
                r.opened(head)
            }
            Outcome::Page { rows, next } => {
                if let Err(e) = r.page(spill, rows, next) {
                    return self.stop(spill, &e.to_string());
                }
                Ok(())
            }
            o => Err(Error::Invalid(format!(
                "outcome {} does not fit a read",
                outcome_name(&o)
            ))),
        }
    }

    fn restart_import(&mut self, spill: &mut dyn Spill, _why: &str) -> Result<()> {
        self.cp.s0 = None;
        self.cp.s0_digest = None;
        self.cp.manifest = None;
        self.cp.state_digest = None;
        self.ram = Ram::Idle;
        self.save_step(spill, Step::Created)
    }

    // ----- H5 / H10: fresh rebuild and compare -----

    fn poll_compare(&mut self, against: Generation) -> Result<Action> {
        if !matches!(&self.ram, Ram::Compare { against: a, .. } if *a == against) {
            self.ram = Ram::Compare {
                against,
                rebuilt: false,
                cursor: None,
                digest: Box::default(),
            };
        }
        let Ram::Compare {
            rebuilt, cursor, ..
        } = &self.ram
        else {
            unreachable!("set above")
        };
        let at_least = match against {
            Generation::S0 => self.cp.base_seq,
            Generation::Final => self.cp.barrier_f,
        }
        .ok_or_else(missing)?;
        Ok(if *rebuilt {
            Action::ReadNew {
                cursor: cursor.clone(),
            }
        } else {
            Action::Rebuild { at_least }
        })
    }

    fn complete_compare(
        &mut self,
        spill: &mut dyn Spill,
        against: Generation,
        o: Outcome,
    ) -> Result<()> {
        let at_least = match against {
            Generation::S0 => self.cp.base_seq,
            Generation::Final => self.cp.barrier_f,
        }
        .ok_or_else(missing)?;
        let Ram::Compare {
            rebuilt,
            cursor,
            digest,
            ..
        } = &mut self.ram
        else {
            return Err(Error::Invalid("compare outcome without a compare".into()));
        };
        match o {
            Outcome::Rebuilt { head } => {
                if head < at_least {
                    return Err(Error::Invalid(format!(
                        "rebuild reached {head}, needs {at_least}"
                    )));
                }
                *rebuilt = true;
                *cursor = None;
                **digest = LiveDigest::new();
                Ok(())
            }
            Outcome::NewPage { rows, next } => {
                if !*rebuilt {
                    return Err(Error::Invalid("cache page before the rebuild".into()));
                }
                if rows.len() > MAX_HYDRATE_RECORDS {
                    return Err(Error::Invalid("cache page over budget".into()));
                }
                for (k, m) in &rows {
                    digest.add(&live_of(k, m)?);
                }
                if next.is_some() {
                    *cursor = next;
                    return Ok(());
                }
                let expected = match against {
                    Generation::S0 => self.cp.s0_digest.as_deref(),
                    Generation::Final => self.cp.final_digest.as_deref(),
                }
                .ok_or_else(missing)?;
                let expected = LiveDigest::from_bytes(expected)?;
                let got = std::mem::take(&mut **digest);
                self.ram = Ram::Idle;
                if got.digest() != expected.digest() {
                    let windows = got.differing_windows(&expected).len();
                    return self.stop(
                        spill,
                        &format!(
                            "{against:?} compare: rebuilt cache differs in {windows} windows ({} vs {} entities)",
                            got.total(),
                            expected.total()
                        ),
                    );
                }
                match against {
                    Generation::S0 => self.save_step(spill, Step::Shadowed),
                    // Verified at F: route next (the Route outcome lands above).
                    Generation::Final => {
                        self.ram = Ram::Route;
                        Ok(())
                    }
                }
            }
            o => Err(Error::Invalid(format!(
                "outcome {} does not fit a compare",
                outcome_name(&o)
            ))),
        }
    }

    // ----- H9: replay -----

    /// Allocate every parking path the replay will need, one diff page per poll,
    /// before the cutover intent. A failure stops while rollback is still possible.
    fn poll_park_check(&mut self, spill: &mut dyn Spill) -> Result<Action> {
        let after = match &self.ram {
            Ram::ParkCheck(a) => a.clone(),
            _ => None,
        };
        let rows = spill
            .diff_page(after.as_ref(), MAX_HYDRATE_RECORDS)
            .map_err(spill_err)?;
        let Some((last, _, _)) = rows.last() else {
            self.ram = Ram::ParkChecked;
            return Ok(Action::Continue);
        };
        let last = last.clone();
        for (key, s0, fin) in &rows {
            if super::replay::parks(s0.as_ref(), fin.as_ref())
                && let Some(a) = s0
                && let Err(e) = super::replay::allocate_park(spill, key, &a.path)
            {
                self.stop(spill, &format!("before cutover: {e}"))?;
                return Ok(Action::Continue);
            }
        }
        self.ram = Ram::ParkCheck(Some(last));
        Ok(Action::Continue)
    }

    fn plan_batch(&mut self, spill: &mut dyn Spill) -> Result<Option<Batch>> {
        loop {
            let after = self
                .cp
                .replay_after
                .as_deref()
                .map(|b| Key::from_bytes(b).ok_or_else(missing))
                .transpose()?;
            let rows = spill
                .diff_page(after.as_ref(), MAX_HYDRATE_RECORDS)
                .map_err(spill_err)?;
            let mut park = |k: &Key, p: &str| super::replay::allocate_park(spill, k, p);
            let batch = take_batch(self.cp.replay_pass, &rows, &mut park)?;
            match batch {
                None => {
                    if self.cp.replay_pass >= 2 {
                        return Ok(None);
                    }
                    self.cp.replay_pass += 1;
                    self.cp.replay_after = None;
                    self.save(spill)?;
                }
                Some((effects, last)) => {
                    if effects.is_empty() {
                        self.cp.replay_after = Some(last.to_bytes());
                        self.save(spill)?;
                        continue;
                    }
                    let s_final = self.cp.s_final.ok_or_else(missing)?;
                    return Ok(Some(Batch {
                        mutation: mutation_id(
                            &self.cp.collection,
                            s_final,
                            self.cp.replay_pass,
                            &last,
                        ),
                        pass: self.cp.replay_pass,
                        s_final,
                        effects,
                        last,
                    }));
                }
            }
        }
    }

    fn poll_replay(&mut self, spill: &mut dyn Spill) -> Result<Action> {
        if !matches!(self.ram, Ram::Replay { .. }) {
            self.ram = Ram::Replay {
                batch: None,
                find_first: self.cp.intent_mutation.is_some(),
            };
        }
        let Ram::Replay { batch, find_first } = &self.ram else {
            unreachable!("set above")
        };
        if let Some(b) = batch {
            return Ok(if *find_first {
                Action::FindMutation {
                    mutation: b.mutation,
                }
            } else {
                Action::Replay(b.clone())
            });
        }
        let find_first = *find_first;
        let Some(b) = self.plan_batch(spill)? else {
            return Ok(Action::LogHead);
        };
        match (&self.cp.intent_mutation, &self.cp.intent_last) {
            (Some(m), Some(l)) => {
                // Resumed with a batch in flight: planning is deterministic.
                if *m != b.mutation || *l != b.last.to_bytes() {
                    return Err(Error::Invalid(
                        "replay intent does not match the plan".into(),
                    ));
                }
            }
            _ => {
                self.cp.intent_mutation = Some(b.mutation);
                self.cp.intent_last = Some(b.last.to_bytes());
                self.save(spill)?;
            }
        }
        let action = if find_first {
            Action::FindMutation {
                mutation: b.mutation,
            }
        } else {
            Action::Replay(b.clone())
        };
        self.ram = Ram::Replay {
            batch: Some(b),
            find_first,
        };
        Ok(action)
    }

    fn complete_replay(&mut self, spill: &mut dyn Spill, o: Outcome) -> Result<()> {
        let Ram::Replay { batch, find_first } = &mut self.ram else {
            return Err(Error::Invalid("replay outcome without a replay".into()));
        };
        match o {
            Outcome::Appended { .. } | Outcome::Found { seq: Some(_) } => {
                let b = batch.take().ok_or_else(missing)?;
                *find_first = false;
                self.cp.replay_after = Some(b.last.to_bytes());
                self.cp.intent_mutation = None;
                self.cp.intent_last = None;
                self.save(spill)
            }
            Outcome::Found { seq: None } => {
                *find_first = false;
                Ok(())
            }
            Outcome::Unknown | Outcome::Conflict => {
                *find_first = true;
                Ok(())
            }
            Outcome::Head { seq } => {
                if batch.is_some() || self.cp.intent_mutation.is_some() {
                    return Err(Error::Invalid("barrier F with a batch in flight".into()));
                }
                self.cp.barrier_f = Some(seq);
                self.ram = Ram::Idle;
                self.save_step(spill, Step::Replayed)
            }
            o => Err(Error::Invalid(format!(
                "outcome {} does not fit the replay",
                outcome_name(&o)
            ))),
        }
    }

    // ----- shared -----

    /// A non-transient failure: roll back before the cutover intent, otherwise stop
    /// fail closed.
    fn stop(&mut self, spill: &mut dyn Spill, reason: &str) -> Result<()> {
        self.cp.failure = Some(reason.to_owned());
        self.ram = Ram::Idle;
        if self.cp.step.can_roll_back() {
            self.save_step(spill, Step::RollingBack)
        } else {
            self.save_step(spill, Step::Failed)
        }
    }

    fn save_step(&mut self, spill: &mut dyn Spill, step: Step) -> Result<()> {
        self.cp.step = step;
        self.save(spill)
    }

    fn save(&mut self, spill: &mut dyn Spill) -> Result<()> {
        spill.save(&self.cp.to_bytes()?).map_err(spill_err)
    }
}

fn missing() -> Error {
    Error::Invalid("checkpoint is missing a field its step requires".into())
}

fn outcome_name(o: &Outcome) -> &'static str {
    match o {
        Outcome::Ok => "Ok",
        Outcome::Backup { .. } => "Backup",
        Outcome::Created { .. } => "Created",
        Outcome::Opened { .. } => "Opened",
        Outcome::Page { .. } => "Page",
        Outcome::Gen0Progress { .. } => "Gen0Progress",
        Outcome::Gen0Built { .. } => "Gen0Built",
        Outcome::Appended { .. } => "Appended",
        Outcome::Unknown => "Unknown",
        Outcome::Conflict => "Conflict",
        Outcome::Stale => "Stale",
        Outcome::Found { .. } => "Found",
        Outcome::Rebuilt { .. } => "Rebuilt",
        Outcome::NewPage { .. } => "NewPage",
        Outcome::MayFence(_) => "MayFence",
        Outcome::Drain { .. } => "Drain",
        Outcome::Replicas { .. } => "Replicas",
        Outcome::Head { .. } => "Head",
        Outcome::Failed { .. } => "Failed",
        Outcome::Gone => "Gone",
    }
}
