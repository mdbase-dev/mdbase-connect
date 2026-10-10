//! Lost-tail self-repair runtime, step 2 (`2026-10-04-replica-repair-lost-tail.md`
//! §3–§4): detection, the bounded prefix probe, and exact re-append of retained
//! bytes when the service is a strict prefix of what this replica applied.
//!
//! Under the accepted trust assumption the service never forks or withholds,
//! so a head below ours is a **lost tail**, never a fork. This module:
//! - never rolls back, re-seals, re-plans or re-applies anything: the replica's
//!   applied head, state and receipts are unchanged throughout;
//! - re-appends only the exact retained bytes, after exactly their predecessor
//!   (`expect_seq`, `expect_prev`), so other principals' items stay valid;
//! - plans and seals nothing of its own while active (`pump` returns early);
//! - answers every overwritten case (`L < S`, or `L` below the retained window)
//!   with the fallback, which is step 3 and not built here: the replica then
//!   stays re-syncing (reads for the host only) instead of appending.
//!
//! Every reply is bound to the current repair generation; stale replies are
//! ignored. Nothing here is reachable from a `behind` answer.

use mdbn_wire::client::{Connection, IncidentKind};
use mdbn_wire::common::{Bytes, Hash, Value};
use mdbn_wire::envelope::Item;
use mdbn_wire::hash::chain_hash;
use mdbn_wire::log_service::{AppendParams, AppendResult, ReadParams};
use mdbn_wire::schema::Wire;

use super::Replica;
use super::append::Inflight;
use super::log_session::MatchedLogReply;
use super::log_session::prefix::{self, Anchor, PrefixRefusal};
use crate::log::{CallId, LogError, LogReply, LogRequest, LogResponse};
use crate::store::{Head, Store, StoreError};

/// How long a `log_regressed` signal stays up (§5.4).
const REGRESSED_TTL_MS: i64 = 24 * 60 * 60 * 1000;

fn regressed_details(from: u64, to: u64, outcome: u64) -> Value {
    let int = |v: u64| Value::Int(i64::try_from(v).unwrap_or(i64::MAX));
    Value::Map(vec![
        ("from".into(), int(from)),
        ("to".into(), int(to)),
        ("outcome".into(), int(outcome)),
    ])
}

/// How long a repair waits for missing blob parts before taking the fallback
/// (§4.1 `REPAIR_REFS_WAIT`): it never leaves a device stuck.
pub(crate) const REPAIR_REFS_WAIT_MS: i64 = 2 * 60 * 1000;

/// Items per repair append (`log-service-api.md` batch bound).
const MAX_ITEMS: usize = 64;
/// Envelope bytes per repair append.
const MAX_BYTES: usize = 4 << 20;

/// Where a lost tail was seen (`§3`, the detection table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    /// `subscribe`, `append → head_moved` or `read` reported head `S < H`.
    HeadBelow(u64),
    /// The service reports head `S ≥ H` with a different chain at or below `H`
    /// (`read` with `S = H, chain ≠ h`, or item `H + 1` whose `prev ≠ h`).
    Diverged(u64),
}

/// The probe's and repair's progress, visible to tests and status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairPhase {
    /// Searching for `L`, the highest position whose chain the service shares.
    Probing,
    /// Re-appending retained bytes after the service's head.
    Repairing,
    /// The gap was overwritten (or `L` is below the retained window) and the
    /// fallback can't run here yet (no verified rollback source, lost control
    /// items awaiting restoration, or a shipped build). Nothing is appended.
    FallbackRequired,
    /// Confirmed state was rolled back to genesis and the service's history is
    /// being replayed; own acknowledged mutations wait, re-queued, to be
    /// resurrected. Reads only; nothing is planned or sealed.
    RollingBack,
    /// Rolled back, but revocations from the lost window are not back in the
    /// log yet: they stay latched, and nothing is planned or sealed.
    AwaitingControl,
}

/// A snapshot of an active repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepairStatus {
    /// Phase.
    pub phase: RepairPhase,
    /// The applied head when the lost tail was detected.
    pub from: u64,
    /// The service head the repair currently works from.
    pub service_head: u64,
    /// `L` once known.
    pub common: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// `lo` is the highest position known to match (`None`: none tested yet, the
    /// lowest candidate is `floor`); `hi` the lowest known not to match.
    Probing {
        floor: u64,
        lo: Option<u64>,
        hi: u64,
        call: Option<(CallId, u64)>,
    },
    /// Re-append `(at.seq, through]` after `at`, the service's matching head.
    Repairing {
        at: Head,
        call: Option<(CallId, u64)>,
        retry_at: Option<i64>,
        /// Since when the service has refused this batch for missing blob parts.
        refs_since: Option<i64>,
    },
    FallbackRequired {
        common: Option<u64>,
    },
    /// Replaying the service's history to `target` after the rollback.
    RollingBack {
        common: u64,
        target: u64,
    },
}

/// The active repair (`None` when the service holds everything we applied).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repair {
    generation: u64,
    from: Head,
    service_head: u64,
    /// The service head at the first detection (the `log_regressed` `to`).
    detected_head: u64,
    /// The service's lowest retained position, from the latest probe read.
    retained_from: Option<u64>,
    phase: Phase,
}

/// Repair counters for ops and tests (persisted signals arrive with codecs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RepairStats {
    /// Lost tails detected (every detection, including re-probes).
    pub detected: u64,
    /// Repairs that restored the service to this replica's head.
    pub repaired: u64,
    /// Items re-appended.
    pub reappended: u64,
    /// Detections that need the fallback.
    pub fallback: u64,
    /// Rollbacks completed (state replayed to the service's head).
    pub rolled_back: u64,
    /// Own acknowledged mutations re-queued for resurrection.
    pub resurrected: u64,
    /// Probe replies that were not prefix evidence: delivered without an
    /// authenticated session (parked), or not describing the requested interval.
    pub refused: u64,
}

impl<S: Store> Replica<S> {
    /// The active repair, if any.
    pub fn repair_status(&self) -> Option<RepairStatus> {
        let Some(r) = self.repair.as_ref() else {
            return (!self.latch.is_empty()).then_some(RepairStatus {
                phase: RepairPhase::AwaitingControl,
                from: self.head.seq,
                service_head: self.head_known,
                common: None,
            });
        };
        Some(RepairStatus {
            phase: match r.phase {
                Phase::Probing { .. } => RepairPhase::Probing,
                Phase::Repairing { .. } => RepairPhase::Repairing,
                Phase::FallbackRequired { .. } => RepairPhase::FallbackRequired,
                Phase::RollingBack { .. } => RepairPhase::RollingBack,
            },
            from: r.from.seq,
            service_head: r.service_head,
            common: match r.phase {
                Phase::Repairing { at, .. } => Some(at.seq),
                Phase::FallbackRequired { common } => common,
                Phase::RollingBack { common, .. } => Some(common),
                Phase::Probing { .. } => None,
            },
        })
    }

    /// Status key 10: present only while a repair is active or a latch holds.
    pub(crate) fn resyncing(&self) -> Option<mdbn_wire::client::Resyncing> {
        use mdbn_wire::client::{ResyncPhase, Resyncing};
        let s = self.repair_status()?;
        let (phase, positions) = match s.phase {
            RepairPhase::Probing => (ResyncPhase::Probing, s.from.saturating_sub(s.service_head)),
            RepairPhase::Repairing => (
                ResyncPhase::Repairing,
                s.from.saturating_sub(s.common.unwrap_or(s.service_head)),
            ),
            RepairPhase::RollingBack => (
                ResyncPhase::RollingBack,
                s.service_head.saturating_sub(self.head.seq),
            ),
            // A held fallback awaits the rollback source or control restoration.
            RepairPhase::FallbackRequired | RepairPhase::AwaitingControl => {
                (ResyncPhase::AwaitingControl, 0)
            }
        };
        Some(Resyncing { phase, positions })
    }

    /// The non-blocking ops signal (`log_regressed: 12`): raised on every
    /// detection, updated with the outcome, persisted, cleared after 24 hours.
    /// Details: `{from, to, outcome}` (repaired 0, fallback 1, pending 2).
    pub(crate) fn note_regressed(&mut self, from: u64, to: u64, outcome: u64) {
        let at = self.now();
        let mut b = Vec::with_capacity(32);
        for v in [from, to, outcome] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        b.extend_from_slice(&at.to_be_bytes());
        // Best effort: the signal must never block the repair itself.
        let _ = self.store.commit(crate::store::Tx {
            meta: vec![(crate::store::meta_keys::LOG_REGRESSED.into(), Some(b))],
            ..crate::store::Tx::default()
        });
        self.regressed_at = Some(at);
        self.incident(
            IncidentKind::LogRegressed,
            Some(regressed_details(from, to, outcome)),
        );
    }

    /// Restore a persisted `log_regressed` at open; expire it after 24 hours.
    pub(crate) fn load_regressed(&mut self) -> Result<(), StoreError> {
        let Some(b) = self.store.meta(crate::store::meta_keys::LOG_REGRESSED)? else {
            return Ok(());
        };
        if b.len() != 32 {
            return Err(StoreError::Corrupt("log_regressed record".into()));
        }
        let word = |i: usize| {
            let mut w = [0u8; 8];
            w.copy_from_slice(&b[i * 8..i * 8 + 8]);
            w
        };
        let (from, to, outcome) = (
            u64::from_be_bytes(word(0)),
            u64::from_be_bytes(word(1)),
            u64::from_be_bytes(word(2)),
        );
        self.regressed_at = Some(i64::from_be_bytes(word(3)));
        self.incident(
            IncidentKind::LogRegressed,
            Some(regressed_details(from, to, outcome)),
        );
        self.expire_regressed();
        Ok(())
    }

    /// Clear `log_regressed` 24 hours after it was last raised.
    pub(crate) fn expire_regressed(&mut self) {
        if self
            .regressed_at
            .is_some_and(|at| self.now() >= at.saturating_add(REGRESSED_TTL_MS))
        {
            self.regressed_at = None;
            self.clear_incident(IncidentKind::LogRegressed);
            let _ = self.store.commit(crate::store::Tx {
                meta: vec![(crate::store::meta_keys::LOG_REGRESSED.into(), None)],
                ..crate::store::Tx::default()
            });
        }
    }

    /// The held fallback whose divergence can't be proven: `(from, service head)`.
    pub(crate) fn held_unprovable(&self) -> Option<(u64, u64)> {
        match self.repair.as_ref()? {
            Repair {
                phase: Phase::FallbackRequired { common: None },
                from,
                service_head,
                ..
            } => Some((from.seq, *service_head)),
            _ => None,
        }
    }

    /// Repair counters since open.
    pub fn repair_stats(&self) -> RepairStats {
        self.repair_stats
    }

    /// Whether a repair holds the append loop (nothing is planned or sealed).
    pub(crate) fn repairing(&self) -> bool {
        self.repair.is_some()
    }

    /// Whether the repair is replaying the service's history (reads allowed).
    pub(crate) fn rolling_back(&self) -> bool {
        matches!(
            self.repair,
            Some(Repair {
                phase: Phase::RollingBack { .. },
                ..
            })
        )
    }

    /// A detection site saw a lost tail. Starts (or restarts) the probe under a new
    /// generation, so replies to an earlier probe or repair are ignored.
    pub(crate) fn on_lost_tail(&mut self, signal: Signal) {
        if self.apply_fault || self.install.is_some() || self.local_only() {
            return;
        }
        // During the replay this replica is behind the service by design; a real
        // divergence there is an ordinary apply integrity failure.
        if self.rolling_back() {
            return;
        }
        // Our own repair progress reported back (a push or read while we append
        // retained bytes): exactly where we are, or exactly where our in-flight
        // batch lands. Anything else (another writer took a position) re-probes.
        if let (Signal::HeadBelow(s), Some(r)) = (signal, &self.repair)
            && let Phase::Repairing { at, call, .. } = r.phase
            && (s == at.seq || call.is_some_and(|(_, n)| s == at.seq + n))
        {
            return;
        }
        self.restart_probe(signal);
    }

    /// Test hook: start a lost-tail probe as if the service reported `service_head`.
    #[cfg(test)]
    pub(crate) fn testing_start_repair(&mut self, service_head: u64) {
        self.restart_probe(Signal::HeadBelow(service_head));
    }

    /// Start (or restart) the probe under a new generation, whatever is in flight:
    /// replies to the earlier probe or repair batch are then stale and ignored.
    fn restart_probe(&mut self, signal: Signal) {
        if self.apply_fault || self.install.is_some() || self.local_only() {
            return;
        }
        let service_head = match signal {
            Signal::HeadBelow(s) | Signal::Diverged(s) => s,
        };
        self.repair_stats.detected += 1;
        self.repair_generation += 1;
        // Our own in-flight batch targeted the lost head: drop it. Its rows stay
        // pending and are re-planned after the repair; a late reply is stale.
        if self.append.in_flight() {
            self.append = super::append::AppendState::Idle;
        }
        let top = service_head.min(self.head.seq);
        let floor = match self.tail_stats.count {
            0 => self.head.seq,
            _ => self.tail_stats.first.saturating_sub(1),
        };
        self.repair = Some(Repair {
            generation: self.repair_generation,
            from: self.head,
            service_head,
            detected_head: self
                .repair
                .as_ref()
                .filter(|r| r.from == self.head)
                .map_or(service_head, |r| r.detected_head.min(service_head)),
            retained_from: None,
            phase: Phase::Probing {
                floor,
                lo: None,
                hi: top.saturating_add(1),
                call: None,
            },
        });
        self.caught_up = false;
        self.status_dirty = true;
        self.note_regressed(self.head.seq, service_head, 2);
        // Test `top` first: the common strict-prefix case decides in one read.
        self.probe_at(top);
    }

    /// Drive the repair: (re)send what is due. Called from `pump`.
    pub(crate) fn repair_step(&mut self) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        match r.phase {
            Phase::Probing {
                floor,
                lo,
                hi,
                call,
                ..
            } => {
                if call.is_none() {
                    match next_probe(floor, lo, hi) {
                        Some(p) => self.probe_at(p),
                        None => self.probe_done(lo),
                    }
                }
            }
            Phase::Repairing {
                at,
                call: None,
                retry_at,
                refs_since,
            } => {
                if refs_since.is_some_and(|t| self.now() >= t.saturating_add(REPAIR_REFS_WAIT_MS)) {
                    // Nobody re-uploaded the parts: take the fallback (§4.1).
                    self.probe_done(Some(at.seq));
                    return;
                }
                if retry_at.is_none_or(|t| self.now() >= t) {
                    self.send_repair(at);
                }
            }
            Phase::RollingBack { target, .. } => self.rollback_progress(target),
            Phase::Repairing { .. } | Phase::FallbackRequired { .. } => {}
        }
    }

    /// This replica's chain at `p` (`p ≤ H`), from the head or the retained tail.
    pub(super) fn own_chain_at(&self, p: u64) -> Result<Option<Hash>, StoreError> {
        if p == self.head.seq {
            return Ok(Some(self.head.chain));
        }
        if p == 0 {
            return Ok(Some(Head::GENESIS.chain));
        }
        let rows = self.store.tail(p - 1, 1)?;
        Ok(rows
            .first()
            .filter(|r| r.seq == p)
            .map(|r| chain_hash(&r.item)))
    }

    fn set_phase(&mut self, phase: Phase) {
        let was_held = self.held_unprovable().is_some();
        if let Some(r) = self.repair.as_mut() {
            r.phase = phase;
        }
        self.status_dirty = true;
        if was_held != self.held_unprovable().is_some() {
            self.refresh_lost_entries();
        }
    }

    /// Probe the service's chain at `p`: one unfiltered item after `p - 1`
    /// (after 0 for `p == 0`, which only a matched reply proves). The reply is
    /// evidence only through the authenticated session (`log_session::prefix`).
    fn probe_at(&mut self, p: u64) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        let Phase::Probing { floor, lo, hi, .. } = r.phase else {
            return;
        };
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: p.saturating_sub(1),
            limit: 1,
            kinds: None,
            max_bytes: None,
        }));
        self.inflight
            .insert(id, Inflight::RepairProbe(r.generation, p));
        self.set_phase(Phase::Probing {
            floor,
            lo,
            hi,
            call: Some((id, p)),
        });
    }

    /// A probe read came back. `provenance` is the matched authenticated reply
    /// context, or `None` under legacy `LogPort` delivery, which can never prove
    /// a prefix: the probe then parks until an authenticated session re-detects.
    pub(super) fn on_repair_probe(
        &mut self,
        generation: u64,
        p: u64,
        reply: LogReply,
        provenance: Option<MatchedLogReply>,
    ) {
        let Some(r) = self.repair.as_ref() else {
            return;
        };
        if r.generation != generation {
            return; // stale
        }
        let service_head = r.service_head;
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            Err(LogError::Offline) => {
                self.connection = Connection::Offline;
                self.clear_probe_call();
                return;
            }
            _ => {
                // Unknown answer: retry the same probe on the next pump.
                self.clear_probe_call();
                return;
            }
        };
        self.connection = Connection::Online;
        if let Some(rep) = self.repair.as_mut() {
            rep.retained_from = Some(r.retained_from);
        }
        if r.head != service_head {
            // The service's view changed under the probe: whatever matched so far
            // is void. Start over from its current head under a new generation.
            let signal = if r.head < self.head.seq {
                Signal::HeadBelow(r.head)
            } else {
                Signal::Diverged(r.head)
            };
            self.restart_probe(signal);
            return;
        }
        // The trust anchor is this replica's retained chain at the requested
        // `after` (genesis at 0); the compared position is the one item above it.
        let after = p.saturating_sub(1);
        let anchor = if after == 0 {
            Ok(Anchor::GENESIS)
        } else {
            self.own_chain_at(after)
                .map(|chain| Anchor { seq: after, chain })
        };
        let (anchor, local) = match (anchor, self.own_chain_at(after + 1)) {
            (Ok(anchor), Ok(above)) => (
                anchor,
                above
                    .map(|c| (after + 1, c))
                    .into_iter()
                    .collect::<Vec<_>>(),
            ),
            (Err(e), _) | (_, Err(e)) => {
                self.incident(
                    IncidentKind::Integrity,
                    Some(Value::Text(format!("store: {e}"))),
                );
                return;
            }
        };
        match prefix::observe(
            provenance.as_ref(),
            self.current_log_session(),
            &r,
            anchor,
            self.store_generation,
        ) {
            Ok(observation) => {
                if !observation.still_valid(
                    self.current_log_session(),
                    self.head,
                    self.store_generation,
                ) {
                    self.clear_probe_call();
                    return;
                }
                // A well-shaped item that links from our anchor is still only the
                // service's word until a known signer's signature checks out:
                // without that, a lying service could prove any anchor it likes.
                let env = crate::policy::Env {
                    verifier: self.sealer.verifier(),
                    trusted_roots: &self.cfg.trusted_roots,
                    policy_pins: self.cfg.policy_pins.as_ref(),
                };
                let signed = r.items.iter().all(|it| {
                    Item::from_bytes(&it.item.0)
                        .is_ok_and(|item| self.policy.observed_signature_valid(&item, &env))
                });
                if !signed {
                    self.repair_stats.refused += 1;
                    self.probe_unknown(p);
                    return;
                }
                let common = observation.common_position(&local);
                self.probe_result(p, common);
            }
            Err(PrefixRefusal::NoProvenance) => {
                // Parked: the call slot stays taken, so nothing is re-sent until a
                // detection under an authenticated session restarts the probe.
                self.repair_stats.refused += 1;
            }
            Err(PrefixRefusal::StaleSession) => {
                // Answered after its session ended: ask again under the current one.
                self.clear_probe_call();
            }
            Err(PrefixRefusal::Compacted) => {
                // The service compacted `p`: it can't be compared. Treat it as an
                // upper bound (`L` may come out lower than the truth, which only
                // resurrects or orphans more, safely: exactly-once by mutation ID).
                self.probe_unknown(p);
            }
            Err(_) => {
                // Not a description of the requested interval: never evidence,
                // positive or negative. Bound the search rather than spin on it.
                self.repair_stats.refused += 1;
                self.probe_unknown(p);
            }
        }
    }

    /// `p` could not be compared: it bounds the search from above.
    fn probe_unknown(&mut self, p: u64) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        let Phase::Probing { floor, lo, hi, .. } = r.phase else {
            return;
        };
        let hi = hi.min(p);
        self.set_phase(Phase::Probing {
            floor,
            lo,
            hi,
            call: None,
        });
        match next_probe(floor, lo, hi) {
            Some(next) => self.probe_at(next),
            None => self.probe_done(lo),
        }
    }

    fn clear_probe_call(&mut self) {
        if let Some(Repair {
            phase: Phase::Probing { floor, lo, hi, .. },
            ..
        }) = self.repair.clone()
        {
            self.set_phase(Phase::Probing {
                floor,
                lo,
                hi,
                call: None,
            });
        }
    }

    /// A matched observation answered the probe at `p`: `common` is the highest
    /// position in `[p - 1, p]` (or `[0, 1]` for `p == 0`) where the service's
    /// chain and ours agree, `None` when neither does.
    fn probe_result(&mut self, p: u64, common: Option<u64>) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        let Phase::Probing { floor, lo, hi, .. } = r.phase else {
            return;
        };
        let top = r.service_head.min(r.from.seq);
        let matches = common.is_some_and(|c| c >= p);
        if matches && p == top {
            // The service holds a prefix of our chain through `top`.
            if r.service_head <= r.from.seq {
                self.begin_reappend(p);
            } else {
                // Same chain through our head and the service is ahead: nothing
                // was lost. Back to the ordinary read path.
                self.repair = None;
                self.refresh_lost_entries();
                self.head_known = self.head_known.max(r.service_head);
                self.request_read();
            }
            return;
        }
        // A matched predecessor is a positive answer too, even when `p` itself
        // is not: the search narrows from both sides.
        let lo = match common {
            Some(c) => Some(lo.map_or(c, |l| l.max(c))),
            None => lo,
        };
        let hi = if matches { hi } else { p.min(hi) };
        match next_probe(floor, lo, hi) {
            Some(next) => {
                self.set_phase(Phase::Probing {
                    floor,
                    lo,
                    hi,
                    call: None,
                });
                self.probe_at(next);
            }
            None => self.probe_done(lo),
        }
    }

    /// The search ended below `top`: the gap was overwritten (`L < S`), or `L` is
    /// below the retained window. Both need the fallback (step 3).
    fn probe_done(&mut self, lo: Option<u64>) {
        // Only a matched observation proves `L`; genesis included (a local
        // constant is not evidence about the service). An unmatched floor (below
        // our retained window, or compacted by the service) leaves `L` unproven.
        // Then what this replica applied in the unknown window (a member removal,
        // say) can't be enumerated, so it can't be latched: hold, failing closed
        // rather than roll back and forget it. Apps stay
        // closed.
        let proven = lo;
        self.repair_stats.fallback += 1;
        let from = self.repair.as_ref().map_or(0, |r| r.from.seq);
        self.set_phase(Phase::FallbackRequired { common: proven });
        self.close_revoked_sessions();
        self.note_regressed(from, proven.unwrap_or(0), 1);
        let Some(l) = proven else {
            // Held: surfaced as `lost_entries` with reason `needs_attention`.
            self.refresh_lost_entries();
            return;
        };
        if let Err(e) = self.try_rollback(l) {
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: {e}"))),
            );
        }
    }

    fn begin_reappend(&mut self, l: u64) {
        let chain = match self.own_chain_at(l) {
            Ok(Some(c)) => c,
            _ => {
                self.probe_done(None);
                return;
            }
        };
        self.set_phase(Phase::Repairing {
            at: Head { seq: l, chain },
            call: None,
            retry_at: None,
            refs_since: None,
        });
        self.send_repair(Head { seq: l, chain });
    }

    /// One bounded batch of retained bytes after `at`, through our head.
    fn send_repair(&mut self, at: Head) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        if at.seq >= r.from.seq {
            self.repair_finished();
            return;
        }
        let mut items = Vec::new();
        let mut bytes = 0usize;
        let mut cursor = at.seq;
        let mut prev = at.chain;
        while cursor < r.from.seq && items.len() < MAX_ITEMS {
            let rows = match self.store.tail(cursor, 1) {
                Ok(rows) => rows,
                Err(e) => {
                    self.incident(
                        IncidentKind::Integrity,
                        Some(Value::Text(format!("store: {e}"))),
                    );
                    return;
                }
            };
            let Some(row) = rows.into_iter().next().filter(|row| row.seq == cursor + 1) else {
                // A hole in the retained window: this replica can't repair the
                // rest. Another holder may; otherwise the fallback.
                self.probe_done(Some(at.seq));
                return;
            };
            if !items.is_empty() && bytes + row.item.len() > MAX_BYTES {
                break;
            }
            // Exact continuity of our own retained bytes, before anything is sent.
            match Item::from_bytes(&row.item) {
                Ok(it) if it.seq == Some(row.seq) && it.prev == Some(prev) => {}
                _ => {
                    self.probe_done(Some(at.seq));
                    return;
                }
            }
            bytes += row.item.len();
            prev = chain_hash(&row.item);
            cursor = row.seq;
            items.push(Bytes(row.item));
        }
        let n = items.len() as u64;
        let id = self.queue(LogRequest::Append(AppendParams {
            collection: self.cfg.collection,
            expect_seq: at.seq + 1,
            expect_prev: at.chain,
            items,
        }));
        self.inflight
            .insert(id, Inflight::RepairAppend(r.generation, n));
        // The same batch keeps its missing-parts timer; progress resets it.
        let refs_since = match r.phase {
            Phase::Repairing {
                at: same,
                refs_since,
                ..
            } if same == at => refs_since,
            _ => None,
        };
        self.set_phase(Phase::Repairing {
            at,
            call: Some((id, n)),
            retry_at: None,
            refs_since,
        });
    }

    /// A repair append came back.
    pub(crate) fn on_repair_append(&mut self, generation: u64, n: u64, reply: LogReply) {
        let Some(r) = self.repair.clone() else {
            return;
        };
        if r.generation != generation {
            return;
        }
        let Phase::Repairing { at, refs_since, .. } = r.phase else {
            return;
        };
        match reply {
            Err(LogError::Service {
                code: crate::log::LogErrorCode::RefsMissing,
                ..
            }) => {
                // Blob parts these items reference are gone from the service.
                // Re-uploading from the local blob cache needs the attachment
                // part sealer; until then wait for another
                // holder (usually the author) to upload them, bounded (§4.1).
                let now = self.now();
                let retry = now + i64::try_from(self.tuning.retry_ms).unwrap_or(0);
                self.set_phase(Phase::Repairing {
                    at,
                    call: None,
                    retry_at: Some(retry),
                    refs_since: Some(refs_since.unwrap_or(now)),
                });
            }
            Ok(LogResponse::Append(AppendResult::Appended(a))) => {
                let last = at.seq + n;
                let ours = self.own_chain_at(last).ok().flatten();
                if a.first != at.seq + 1 || a.last != last || ours != Some(a.head_chain) {
                    // Not exactly our bytes after `at`: re-probe from its head.
                    self.restart_probe(Signal::HeadBelow(a.last.min(self.head.seq)));
                    return;
                }
                self.repair_stats.reappended += n;
                let at = Head {
                    seq: last,
                    chain: a.head_chain,
                };
                if let Some(rep) = self.repair.as_mut() {
                    rep.service_head = last;
                }
                self.set_phase(Phase::Repairing {
                    at,
                    call: None,
                    retry_at: None,
                    refs_since: None,
                });
                self.send_repair(at);
            }
            Ok(LogResponse::Append(AppendResult::HeadMoved(h))) => {
                // Another holder repaired part of the gap, or a writer took it.
                let signal = if h.head < self.head.seq {
                    Signal::HeadBelow(h.head)
                } else {
                    Signal::Diverged(h.head)
                };
                // Never filtered as our own progress: this batch did not land.
                self.restart_probe(signal);
            }
            Ok(LogResponse::Append(AppendResult::Duplicate(_))) => {
                // Exact bytes can't be duplicates of anything else: re-probe.
                self.restart_probe(Signal::HeadBelow(at.seq));
            }
            Err(LogError::Offline) => {
                self.connection = Connection::Offline;
                self.set_phase(Phase::Repairing {
                    at,
                    call: None,
                    retry_at: None,
                    refs_since: None,
                });
            }
            _ => {
                // Transient or refused: the same bytes again after a pause.
                let retry = self.now() + i64::try_from(self.tuning.retry_ms).unwrap_or(0);
                self.set_phase(Phase::Repairing {
                    at,
                    call: None,
                    retry_at: Some(retry),
                    refs_since: None,
                });
            }
        }
    }

    /// The fallback (§5): roll confirmed state back to genesis and bring it to the
    /// service's history (by replay, or by the verified snapshot install when the
    /// service has compacted), with this replica's own
    /// acknowledged mutations from `(L, H]` put back as pending rows for
    /// resurrection. One atomic commit; reachable only from the probe and only where
    /// install is enabled. Returns `false` (hold at
    /// `FallbackRequired`) when it can't run safely here:
    /// - shipped builds (`ROLLBACK_ENABLED`);
    /// - the lost window holds control items: restoring them requires the revocation
    ///   latch to precede any policy reset. Until then the replica fails closed.
    fn try_rollback(&mut self, l: u64) -> Result<bool, StoreError> {
        let Some(r) = self.repair.clone() else {
            return Ok(false);
        };
        if !super::snapshot::ROLLBACK_ENABLED {
            return Ok(false);
        }
        // A compacted service needs no special case: from genesis, the ordinary
        // read path answers `behind` and the fully verified install path
        // (manifest signature, ctl and chunks) brings the replica to the
        // service's snapshot, then the tail (§5 step 2, "primary").
        // Lost control items: control-plane policy items are latched
        // (their revocations stay enforced locally until the control plane's
        // outbox restores them); device-authored ones are restored by the
        // protocol (`latch_from_window`). One retained row at a time.
        let mut window = Vec::new();
        let mut after = l;
        while after < r.from.seq {
            let rows = self.store.tail(after, 1)?;
            let Some(row) = rows.into_iter().next() else {
                break;
            };
            after = row.seq;
            if Item::from_bytes(&row.item).is_ok_and(|item| item.kind.is_control()) {
                window.push(row.item);
            }
        }
        let Some(lost) = super::latch::latch_from_window(&window) else {
            return Ok(false);
        };
        let mut latch = self.latch.clone();
        latch.devices.extend(lost.devices);
        latch.members.extend(lost.members);
        latch.grants.extend(lost.grants);
        latch.cp_keys.extend(lost.cp_keys);
        latch.frozen |= lost.frozen;
        // Own acknowledged mutations in (L, H], in their original capture order.
        let mut own = Vec::new();
        let mut cursor = l;
        loop {
            let page = self.store.own_retained(cursor, 64)?;
            let Some(last) = page.last().map(|(seq, _)| *seq) else {
                break;
            };
            own.extend(page);
            cursor = last;
        }
        // Other authors' entries in the window: orphans their authors must
        // resurrect (§5 step 7), tracked until they reappear.
        let mut orphans = self.orphans.clone();
        for o in self.window_orphans(l, r.from.seq)? {
            if o.mutation == mdbn_wire::common::B16([0; 16])
                || !orphans.iter().any(|x| x.mutation == o.mutation)
            {
                orphans.push(o);
            }
        }
        let mut resurrected = self.resurrected.clone();
        for (seq, row) in &own {
            resurrected.insert(row.mutation.id, *seq);
        }
        let policy = crate::policy::PolicyState::new();
        let tx = crate::store::Tx {
            clear_confirmed: true,
            head: Some(Head::GENESIS),
            tail_drop_above: Some(l),
            own_retained_drop_above: Some(l),
            pending_put: own.iter().map(|(_, row)| row.clone()).collect(),
            // The latch is persisted in the same commit as the policy reset, so the
            // weaker replayed policy is never durable without it.
            meta: vec![
                latch.meta(),
                super::orphans::meta(&orphans),
                (
                    crate::store::meta_keys::POLICY.into(),
                    policy.to_bytes().ok(),
                ),
                (
                    crate::store::meta_keys::RESURRECT.into(),
                    Some(encode_resurrected(&resurrected)),
                ),
            ],
            ..crate::store::Tx::default()
        };
        self.store.commit(tx)?;
        self.store_generation += 1;
        self.repair_stats.resurrected += own.len() as u64;
        self.resurrected = resurrected;
        self.latch = latch;
        // Every app session closes now: until control is restored only the
        // hosting app is served, and nothing more is pushed to them.
        self.close_revoked_sessions();
        self.orphans = orphans;
        self.head = Head::GENESIS;
        self.policy = policy;
        self.install_points.clear();
        self.apply_blocked = None;
        self.tail_stats_dirty = true;
        self.refresh_retained_stats()?;
        self.catalog = std::sync::Arc::new(crate::plan::load_catalog(&self.store)?);
        let changed: std::collections::BTreeSet<String> = self
            .all_pending()?
            .into_iter()
            .flat_map(|row| row.touches)
            .collect();
        let ids = self.rebuild_local_view(&changed)?;
        self.notify(&ids);
        self.head_known = r.service_head;
        self.caught_up = false;
        self.set_phase(Phase::RollingBack {
            common: l,
            target: r.service_head,
        });
        self.rollback_progress(r.service_head);
        Ok(true)
    }

    /// Replay toward the service's head; done once the applied head reaches it.
    pub(crate) fn rollback_progress(&mut self, target: u64) {
        if self.head.seq >= target {
            self.repair = None;
            self.refresh_lost_entries();
            self.repair_stats.rolled_back += 1;
            self.head_known = self.head_known.max(self.head.seq);
            self.status_dirty = true;
            if let Err(e) = self.clear_latch().and_then(|()| self.review_orphans()) {
                self.incident(
                    IncidentKind::Integrity,
                    Some(Value::Text(format!("store: {e}"))),
                );
            }
            self.close_revoked_sessions();
            // Resurrected rows plan (in resurrection mode) from the next pump.
            return;
        }
        self.request_read();
    }

    /// The stage a pending row plans in: resurrection mode only for this
    /// replica's own re-queued acknowledged mutations (core-B's condition).
    pub(crate) fn plan_stage(&self, mutation: &mdbn_wire::common::Uuid) -> mdbn_core::plan::Stage {
        if self.resurrected.contains_key(mutation) {
            mdbn_core::plan::Stage::Resurrect
        } else {
            mdbn_core::plan::Stage::Head
        }
    }

    /// For a resurrected mutation being resolved (confirmed at its new position,
    /// or lost after revocation): its earlier position, and the meta row without
    /// it, for the resolving transaction. Forget it only after that commits.
    pub(crate) fn resurrected_resolution(
        &self,
        mutation: &mdbn_wire::common::Uuid,
    ) -> Option<(u64, crate::store::MetaPut)> {
        let old = *self.resurrected.get(mutation)?;
        let mut rest = self.resurrected.clone();
        rest.remove(mutation);
        Some((
            old,
            (
                crate::store::meta_keys::RESURRECT.into(),
                (!rest.is_empty()).then(|| encode_resurrected(&rest)),
            ),
        ))
    }

    /// The service holds our head again, with our chain. Nothing local changes.
    fn repair_finished(&mut self) {
        let to = self.repair.as_ref().map_or(0, |r| r.detected_head);
        self.note_regressed(self.head.seq, to, 0);
        self.repair = None;
        self.refresh_lost_entries();
        self.repair_stats.repaired += 1;
        self.head_known = self.head_known.max(self.head.seq);
        self.caught_up = true;
        self.status_dirty = true;
    }
}

pub(crate) fn encode_resurrected(
    set: &std::collections::BTreeMap<mdbn_wire::common::Uuid, u64>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(set.len() * 24);
    for (id, seq) in set {
        out.extend_from_slice(&id.0);
        out.extend_from_slice(&seq.to_be_bytes());
    }
    out
}

/// The persisted resurrection set (absent: empty).
pub(crate) fn decode_resurrected(
    bytes: Option<&[u8]>,
) -> Result<std::collections::BTreeMap<mdbn_wire::common::Uuid, u64>, &'static str> {
    let mut set = std::collections::BTreeMap::new();
    let Some(bytes) = bytes else {
        return Ok(set);
    };
    if bytes.len() % 24 != 0 {
        return Err("length");
    }
    for rec in bytes.chunks_exact(24) {
        let mut id = [0u8; 16];
        id.copy_from_slice(&rec[..16]);
        let mut seq = [0u8; 8];
        seq.copy_from_slice(&rec[16..]);
        set.insert(mdbn_wire::common::B16(id), u64::from_be_bytes(seq));
    }
    Ok(set)
}

/// The next position to test, or `None` when the search is decided.
/// `lo = None` means nothing above `floor` matched yet; `floor` itself is unknown
/// (below the retained window) unless it is 0: genesis is a candidate that must
/// still be observed, never assumed.
fn next_probe(floor: u64, lo: Option<u64>, hi: u64) -> Option<u64> {
    match lo {
        Some(l) => (hi > l.saturating_add(1)).then(|| l + (hi - l) / 2),
        None if floor == 0 => (hi > 0).then_some(hi / 2),
        None => (hi > floor.saturating_add(1)).then(|| floor + (hi - floor) / 2),
    }
}

#[cfg(test)]
mod tests {
    use super::next_probe;

    #[test]
    fn probe_search_is_bounded_and_decides() {
        // 10k-position window: at most 14 reads after the first (the top test).
        let mut lo = None;
        let mut hi = 10_001;
        let mut n = 0;
        let l = 6_789;
        while let Some(p) = next_probe(0, lo, hi) {
            n += 1;
            if p <= l {
                lo = Some(p);
            } else {
                hi = p;
            }
        }
        assert_eq!(lo, Some(l));
        assert!(n <= 14, "{n}");
        // Nothing retained below `hi`: decided at once.
        assert_eq!(next_probe(5, None, 6), None);
        assert_eq!(next_probe(5, Some(5), 6), None);
        // Genesis is probed, not assumed: 0 is the last candidate.
        assert_eq!(next_probe(0, None, 1), Some(0));
        assert_eq!(next_probe(0, None, 2), Some(1));
        assert_eq!(next_probe(0, None, 0), None);
        assert_eq!(next_probe(0, Some(0), 1), None);
    }
}
