//! The driver's durable state: one small, metadata-only record, saved through
//! [`super::Spill::save`] after every confirmed outcome and before every log append.

use mdbn_wire::common::{B16, B32, Bytes};
use mdbn_wire::schema::Wire;
use mdbn_wire::wire_struct;

use crate::Error;

// Not `crate::Result`: the wire macros expand to the two-argument `Result`.
type CResult<T> = std::result::Result<T, Error>;

/// The durable step. Ordered: a later step implies every earlier one held.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Step {
    /// Nothing done yet.
    Start = 0,
    /// H0: the legacy backup hold and 90-day retention are in force.
    BackupHeld = 1,
    /// H1: the cloud-copy collection exists with verified service keying.
    Created = 2,
    /// H4: generation 0 is built; the `base` append is about to be sent or was sent.
    BaseIntent = 3,
    /// H4: `base` is in the log.
    BaseAppended = 4,
    /// H5: a fresh rebuild from the base matched the S0 read.
    Shadowed = 5,
    /// H6: legacy is fenced (`migrating`); draining accepted pending writes.
    Fenced = 6,
    /// H6: drained; `S_final` is fixed.
    Drained = 7,
    /// H7: the `S_final` read is resolved; its expected digest is recorded.
    Verified = 8,
    /// H8: old mirrors/apps are revoked; their IDs are recorded.
    Revoked = 9,
    /// H9: the cutover append is about to be sent or was sent. No rollback past here.
    CutoverIntent = 10,
    /// H9: the cutover is in the log; replaying the S0→S_final diff.
    Replaying = 11,
    /// H9: the replay is complete at barrier F.
    Replayed = 12,
    /// H10: a fresh rebuild matched `S_final`; routed. Terminal.
    Routed = 13,
    /// Rollback before cutover in progress.
    RollingBack = 20,
    /// Rolled back before cutover: legacy is active again. Terminal.
    RolledBack = 21,
    /// Stopped after the cutover intent, fail closed and read-only. Terminal.
    Failed = 22,
    /// The collection or its account was deleted: deletion is terminal.
    /// Nothing is rolled back or routed. Terminal.
    Gone = 23,
}

impl Step {
    pub(crate) fn from_u64(v: u64) -> Option<Step> {
        use Step::*;
        Some(match v {
            0 => Start,
            1 => BackupHeld,
            2 => Created,
            3 => BaseIntent,
            4 => BaseAppended,
            5 => Shadowed,
            6 => Fenced,
            7 => Drained,
            8 => Verified,
            9 => Revoked,
            10 => CutoverIntent,
            11 => Replaying,
            12 => Replayed,
            13 => Routed,
            20 => RollingBack,
            21 => RolledBack,
            22 => Failed,
            23 => Gone,
            _ => return None,
        })
    }

    /// Whether the migration has ended.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Step::Routed | Step::RolledBack | Step::Failed | Step::Gone
        )
    }

    /// Whether a rollback to legacy is still possible (decision 6A).
    pub fn can_roll_back(self) -> bool {
        self < Step::CutoverIntent
    }
}

wire_struct! {
    /// The encoded checkpoint.
    pub struct Encoded [fmt = 1] {
        1 req collection: String,
        2 req step: u64,
        3 opt backup_hold: String,
        4 opt s0: u64,
        5 opt manifest: B32,
        6 opt state_digest: B32,
        7 opt base_seq: u64,
        8 opt s0_digest: Bytes,
        9 req fenced: bool,
        10 opt s_final: u64,
        11 opt final_digest: Bytes,
        12 opt revoked: Vec<String>,
        13 opt cutover_seq: u64,
        14 req replay_pass: u64,
        15 opt replay_after: Bytes,
        16 opt intent_last: Bytes,
        17 opt intent_mutation: B16,
        18 opt barrier_f: u64,
        19 opt failure: String,
        20 req attempts: u64,
        21 opt fence_first: bool,
    }
}

/// The durable state of one collection's migration. Metadata only.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Checkpoint {
    /// The legacy collection ID (kept as the new collection ID).
    pub collection: String,
    /// Where the migration is.
    pub step: Step,
    /// H0: the backup hold that protects the legacy rows and R2 history.
    pub backup_hold: Option<String>,
    /// H2: the import read's legacy head.
    pub s0: Option<u64>,
    /// H4: the generation-0 manifest address and state digest.
    pub manifest: Option<B32>,
    /// H4: its state digest.
    pub state_digest: Option<B32>,
    /// H4: the base's log position.
    pub base_seq: Option<u64>,
    /// H2: the expected live digest of S0 (`LiveDigest::to_bytes`).
    pub s0_digest: Option<Vec<u8>>,
    /// H6: whether legacy may be fenced now (set before the fence is sent).
    pub fenced: bool,
    /// H6: the drained legacy head.
    pub s_final: Option<u64>,
    /// H7: the expected live digest of `S_final`.
    pub final_digest: Option<Vec<u8>>,
    /// H8: the revoked replica IDs, for un-revoke on rollback and for evidence.
    pub revoked: Vec<String>,
    /// H9: the cutover's log position.
    pub cutover_seq: Option<u64>,
    /// H9: replay pass (1: deletes and parking, 2: final states).
    pub replay_pass: u64,
    /// H9: the last key confirmed in the current pass (encoded `Key`).
    pub replay_after: Option<Vec<u8>>,
    /// H9: the batch in flight: its last key.
    pub intent_last: Option<Vec<u8>>,
    /// H9: the batch in flight: its mutation ID.
    pub intent_mutation: Option<B16>,
    /// H9: barrier F, the log head after the replay.
    pub barrier_f: Option<u64>,
    /// Why the migration stopped or rolled back, if it did. IDs and counts only.
    pub failure: Option<String>,
    /// Imports restarted from H2 so far (a bounded retry budget).
    pub attempts: u64,
    /// Fence-first mode: fence and drain before the import, so S0 = `S_final` and
    /// the H9 replay is empty (no delta capture needed). Fixed at start.
    pub fence_first: bool,
}

impl Checkpoint {
    /// A fresh checkpoint for `collection`.
    pub fn new(collection: &str) -> Checkpoint {
        Checkpoint {
            collection: collection.to_owned(),
            step: Step::Start,
            backup_hold: None,
            s0: None,
            manifest: None,
            state_digest: None,
            base_seq: None,
            s0_digest: None,
            fenced: false,
            s_final: None,
            final_digest: None,
            revoked: Vec::new(),
            cutover_seq: None,
            replay_pass: 0,
            replay_after: None,
            intent_last: None,
            intent_mutation: None,
            barrier_f: None,
            failure: None,
            attempts: 0,
            fence_first: false,
        }
    }

    /// Canonical bytes.
    pub fn to_bytes(&self) -> CResult<Vec<u8>> {
        Encoded {
            collection: self.collection.clone(),
            step: self.step as u64,
            backup_hold: self.backup_hold.clone(),
            s0: self.s0,
            manifest: self.manifest,
            state_digest: self.state_digest,
            base_seq: self.base_seq,
            s0_digest: self.s0_digest.clone().map(Bytes),
            fenced: self.fenced,
            s_final: self.s_final,
            final_digest: self.final_digest.clone().map(Bytes),
            revoked: (!self.revoked.is_empty()).then(|| self.revoked.clone()),
            cutover_seq: self.cutover_seq,
            replay_pass: self.replay_pass,
            replay_after: self.replay_after.clone().map(Bytes),
            intent_last: self.intent_last.clone().map(Bytes),
            intent_mutation: self.intent_mutation,
            barrier_f: self.barrier_f,
            failure: self.failure.clone(),
            attempts: self.attempts,
            fence_first: self.fence_first.then_some(true),
        }
        .to_bytes()
        .map_err(|e| Error::Invalid(format!("checkpoint encode: {e:?}")))
    }

    /// Decode [`Self::to_bytes`].
    pub fn from_bytes(b: &[u8]) -> CResult<Checkpoint> {
        let e = Encoded::from_bytes(b)
            .map_err(|e| Error::Invalid(format!("checkpoint decode: {e:?}")))?;
        Ok(Checkpoint {
            collection: e.collection,
            step: Step::from_u64(e.step)
                .ok_or_else(|| Error::Invalid(format!("checkpoint step {}", e.step)))?,
            backup_hold: e.backup_hold,
            s0: e.s0,
            manifest: e.manifest,
            state_digest: e.state_digest,
            base_seq: e.base_seq,
            s0_digest: e.s0_digest.map(|b| b.0),
            fenced: e.fenced,
            s_final: e.s_final,
            final_digest: e.final_digest.map(|b| b.0),
            revoked: e.revoked.unwrap_or_default(),
            cutover_seq: e.cutover_seq,
            replay_pass: e.replay_pass,
            replay_after: e.replay_after.map(|b| b.0),
            intent_last: e.intent_last.map(|b| b.0),
            intent_mutation: e.intent_mutation,
            barrier_f: e.barrier_f,
            failure: e.failure,
            attempts: e.attempts,
            fence_first: e.fence_first.unwrap_or(false),
        })
    }
}
