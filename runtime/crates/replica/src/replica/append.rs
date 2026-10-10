//! The append loop (`log-entry.md` §3) and the handling of log replies and pushes.
//!
//! One loop per collection. Its state machine:
//!
//! ```text
//!  Idle ──plan batch at (H,h)──► InFlight{bytes} ──appended──► apply ──► Idle
//!                                   │  head_moved: read, apply, re-plan unchanged
//!                                   │  duplicate: read through seq, confirm only if
//!                                   │             the item there carries the mutation
//!                                   │  no response: retry the same bytes
//!                                   └  service error: per log-service-api.md §10
//! ```
//!
//! The writer plans only when it has applied everything up to the head it knows
//! (`caught_up`), never during a log move, and never while stalled.

use std::collections::BTreeSet;

use mdbn_core::plan::PlanOptions;
use mdbn_core::state::Overlay;
use mdbn_wire::attachment_runtime_v1::Op as RtOp;
use mdbn_wire::client::{Connection, IncidentKind, ReceiptState};
use mdbn_wire::common::Text;
use mdbn_wire::common::{B16, Bytes, Hash, Uuid};
use mdbn_wire::entry::EntryPayload;
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::Op;
use mdbn_wire::log_service::{AppendParams, AppendResult, ReadParams};

/// How long the escrow waits, after the last policy item (`issued_at`), for the
/// hosted replica to grant the key to a newly enrolled device before granting it
/// itself (fallback). Without an active hosted device it grants at once.
pub const ESCROW_GRANT_AFTER_MS: i64 = 120_000;
use mdbn_wire::schema::Wire;

use super::submit::rejection_problem;
use super::{LogMove, Replica};
use crate::api::{Push, SessionId};
use crate::convert;
use crate::log::{
    CallId, LogError, LogErrorCode, LogPort, LogPush, LogReply, LogRequest, LogResponse,
};
use crate::plan::StoreView;
use crate::store::{LocalReceipt, Store, StoreError, Tx};

/// Limits and timing of the append loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendTuning {
    /// Items per batch (≤ 64).
    pub max_items: u32,
    /// Envelope bytes per batch (≤ 4 MiB).
    pub max_bytes: u64,
    /// Consecutive `head_moved` results before backing off.
    pub backoff_after: u32,
    /// Maximum random backoff, ms.
    pub backoff_max_ms: u64,
    /// Wait before retrying after a transient error, ms.
    pub retry_ms: u64,
}

impl Default for AppendTuning {
    fn default() -> AppendTuning {
        AppendTuning {
            max_items: 64,
            max_bytes: 4 << 20,
            backoff_after: 3,
            backoff_max_ms: 50,
            retry_ms: 1_000,
        }
    }
}

/// An append whose outcome is not known yet.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Sent {
    pub(crate) params: AppendParams,
    pub(crate) mutations: Vec<Uuid>,
    /// The call currently carrying these bytes. Only its reply resolves the batch;
    /// replies to earlier calls with the same bytes are stale, preventing
    /// confirmation of a different batch after a reconnect.
    pub(crate) call: CallId,
}

/// The append loop's state.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AppendState {
    /// Nothing in flight.
    Idle,
    /// An append is in flight (or must be retried with the same bytes).
    InFlight(Sent),
    /// Retry the same bytes at this time.
    RetryAt(i64, Sent),
    /// Don't plan before this time (contention backoff, transient errors).
    WaitUntil(i64),
    /// Stopped until something changes (forbidden, gone, quota, invalid twice).
    Stopped,
}

impl AppendState {
    pub(crate) fn in_flight(&self) -> bool {
        matches!(self, AppendState::InFlight(_) | AppendState::RetryAt(..))
    }
}

/// What an outstanding call was for.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Inflight {
    Append,
    Read,
    Subscribe,
    VerifyHead,
    SnapPut,
    SnapRegister,
    Install,
    InstallNative,
    InstallText,
    Endorse,
    EndorseManifest,
    /// Hosted mode: a page of control items for the warm-wake key rebuild.
    KeyRebuild,
    /// AK1: a page of control items read ahead to verify an unlock at the head.
    AccountKeyAhead,
    /// Join-ahead: a page of control items read ahead while waiting for a key at
    /// this position.
    JoinAhead(u64),
    /// Hosted mode: read back the entry at `seq` to learn a mutation's owner.
    OwnerLookup(Uuid, u64, crate::store::Head),
    /// Lost-tail probe read: (repair generation, position).
    RepairProbe(u64, u64),
    /// Lost-tail re-append: (repair generation, items).
    RepairAppend(u64, u64),
    /// An attachment upload's object call (its mutation ID).
    Attachment(Uuid),
    /// Trusted source preparation uploads; not pending/emission authority.
    UnindexedUpload(Uuid),
    UnindexedReindexUpload(Uuid),
    /// An attachment fetch's object read (its File ID).
    AttachmentFetch(Uuid),
    /// Bounded T6b authenticated source read for an unconfirmed entry.
    UnindexedSource(crate::store::Head),
    UnindexedReverseText(crate::store::Head),
    /// Native Blob streaming placement, independent of whole-blob cache.
    UnindexedBlob(Uuid),
    /// A snapshot inventory read of an attachment manifest (its address).
    AttachmentInventory(mdbn_wire::common::Hash),
    Other,
}

impl<S: Store> Replica<S> {
    /// Drive the loop: read if behind, otherwise plan and send a batch.
    pub(crate) fn pump(&mut self) {
        if self.apply_fault || self.install.is_some() || self.hosted_blocked() {
            return;
        }
        self.unindexed_source_step();
        self.reverse_text_step();
        self.native_blob_step();
        if self.unindexed_sources.pending() || self.reverse_text_sources.pending() {
            return;
        }
        if let Some((kind, _)) = self.stalled {
            // Missing keys need bounded probes, not a read on every reply and
            // not permanent silence. A push never supplies key authority.
            if kind == IncidentKind::WaitingForKey
                && !self.local_only()
                && self.log_move == LogMove::None
            {
                self.join_ahead_step();
                self.request_read();
            }
            return;
        }
        if self.local_only() {
            self.local_commit();
            return;
        }
        // A lost-tail repair holds the loop: nothing is read past, planned or sealed.
        if self.repairing() {
            self.repair_step();
            return;
        }
        if self.head_known > self.head.seq {
            self.request_read();
            return;
        }
        if self.is_apply_recovering()
            || self.log_move != LogMove::None
            || !self.caught_up
            || self.reading
        {
            return;
        }
        // While a lost revocation is latched, nothing is planned or
        // sealed (no content for an epoch a latched device may hold).
        if !self.latch.is_empty() {
            return;
        }
        match self.append {
            AppendState::Idle => {}
            AppendState::WaitUntil(t) if self.now() >= t => self.append = AppendState::Idle,
            _ => return,
        }
        if let Err(e) = self.send_batch() {
            self.incident(
                IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!("store: {e}"))),
            );
        }
    }

    pub(crate) fn request_read(&mut self) {
        if self.apply_fault
            || self.reading
            || self.unindexed_sources.pending()
            || self.reverse_text_sources.pending()
            || (self.repairing() && !self.rolling_back())
        {
            return;
        }
        if let Some((IncidentKind::WaitingForKey, position)) = self.stalled {
            if self.local_only()
                || self.log_move != LogMove::None
                || !self.key_wait_read.due(position, self.now())
            {
                return;
            }
        } else {
            self.key_wait_read.clear();
        }
        self.reading = true;
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: self.head.seq,
            // Hosted: at most 500 entries applied per read (DO request budget).
            limit: if self.is_hosted() { 500 } else { 1000 },
            kinds: None,
            max_bytes: self.read_bytes(),
        }));
        self.inflight.insert(id, Inflight::Read);
    }

    pub(crate) fn queue_verify_head(&mut self) {
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: self.head.seq - 1,
            limit: 1,
            kinds: None,
            max_bytes: None,
        }));
        self.inflight.insert(id, Inflight::VerifyHead);
    }

    fn send_batch(&mut self) -> Result<(), StoreError> {
        if self.store.durability_deferred() {
            debug_assert!(false, "log append inside a deferred-durability window");
            return Err(StoreError::Io(
                "deferred-durability window open: no log append before its barrier".into(),
            ));
        }
        // Control work first (log-entry.md §3.1 step 2).
        if self.send_rekey_if_needed()
            || self.send_key_grant_if_needed()
            || self.send_private_key_grant_if_needed()
            || self.send_account_key_setup_if_needed()
            || self.send_account_key_grant_if_needed()
        {
            return Ok(());
        }
        let me = self.cfg.device_id;
        if self.cfg.key_grants_only
            || self.key_untrusted
            || self.policy.rekey_required
            || self.policy.frozen
            || !self.policy.device_can_write(&me)
        {
            return Ok(());
        }
        let Some(epoch) = self
            .sealer
            .current_epoch()
            .filter(|e| *e == self.policy.epoch)
        else {
            return Ok(());
        };
        let rows = self.store.pending(None, self.tuning.max_items.min(64))?;
        if rows.is_empty() {
            return Ok(());
        }
        let catalog = self.catalog.clone();
        let view = StoreView::new(&self.store, catalog);
        let mut overlay = Overlay::new(&view);
        let mut items: Vec<Bytes> = Vec::new();
        let mut mutations = Vec::new();
        let mut rejected: Vec<(Uuid, Option<Uuid>, mdbn_wire::client::Problem)> = Vec::new();
        let mut confirmed: Vec<(Uuid, u64)> = Vec::new();
        let mut hosted_known: Vec<(Uuid, Option<Uuid>, u64)> = Vec::new();
        let mut prev = self.head.chain;
        let mut bytes = 0u64;
        let mut sealed_err = None;
        let mut native_move_holds = Vec::new();
        for mut row in rows {
            if let Some(r) = self.store.receipt(&row.mutation.id)? {
                // Already in the log (an earlier append whose ack was lost).
                if self.is_hosted() {
                    // Hosted: confirm only for the owner the log names.
                    hosted_known.push((row.mutation.id, row.grant, r.seq));
                } else {
                    confirmed.push((row.mutation.id, r.seq));
                }
                continue;
            }
            // A resurrected on-behalf write whose grant is no longer effective is
            // lost after revocation: the only rejection of an
            // acknowledged write.
            if self.resurrected.contains_key(&row.mutation.id)
                && row.grant.is_some_and(|g| self.grant_now(&g).is_none())
            {
                let mut problem = crate::api::ErrorCode::Forbidden
                    .problem("the grant was revoked before this lost write could be restored");
                problem.reason = Some("revoked_after_loss".into());
                rejected.push((row.mutation.id, row.grant, problem));
                continue;
            }
            if super::attachment_upload::native(&row.mutation)
                && (self.is_hosted() || row.grant.is_some() || row.mutation.on_behalf.is_some())
            {
                rejected.push((
                    row.mutation.id,
                    row.grant,
                    crate::api::ErrorCode::Forbidden.problem_with_reason(
                        "unindexed_device_capture_required",
                        "native capture requires a keyed editor device",
                    ),
                ));
                continue;
            }
            match self.native_move_pending_check(&row)? {
                Some(super::unindexed_move::MoveAdmission::Ready(refs)) => row.refs = refs,
                Some(super::unindexed_move::MoveAdmission::Reject(problem)) => {
                    rejected.push((row.mutation.id, row.grant, problem));
                    continue;
                }
                Some(super::unindexed_move::MoveAdmission::Hold(problem)) => {
                    native_move_holds.push(problem);
                    continue;
                }
                None => {}
            }
            let Ok(cm) = convert::runtime_mutation(&row.mutation, &convert::inline_only) else {
                rejected.push((
                    row.mutation.id,
                    row.grant,
                    crate::api::ErrorCode::InvalidRequest.problem("unconvertible mutation"),
                ));
                continue;
            };
            let stage = self.plan_stage(&row.mutation.id);
            let planned = self.planner.plan(&cm, &overlay, &PlanOptions { stage });
            if let Some(e) = view.error() {
                return Err(e);
            }
            let planned = super::check_paths(planned);
            let planned = match planned {
                Ok(p) => p,
                Err(rej) => {
                    rejected.push((row.mutation.id, row.grant, rejection_problem(&rej)));
                    continue;
                }
            };
            let native_move = match self.native_move_planned_check(&row, &planned)? {
                Some(true) => true,
                Some(false) => {
                    if self.resurrected.contains_key(&row.mutation.id) {
                        native_move_holds.push(
                            crate::api::ErrorCode::Conflict.problem_with_reason(
                                "native_move_restore_overlay_changed",
                                "native recovery overlay changed the current holder",
                            ),
                        );
                        continue;
                    }
                    rejected.push((
                        row.mutation.id,
                        row.grant,
                        crate::api::ErrorCode::Conflict.problem_with_reason(
                            "native_move_changed",
                            "native move overlay changed the captured holder",
                        ),
                    ));
                    continue;
                }
                None => false,
            };
            let mut mutation = row.mutation.clone();
            for fill in &planned.base_text_fills {
                if let Some(RtOp::Legacy(Op::Update(u))) =
                    mutation.ops.get_mut(fill.op_index as usize)
                {
                    u.body_base_text = Some(Text::Inline(fill.text.clone()));
                }
            }
            // Informational; selects resurrection semantics for verifiers.
            let resurrect = self.resurrected.get(&row.mutation.id).copied();
            let encoded = if super::unindexed_reverse_entry::is_reverse(&row.mutation) {
                if self.is_hosted() || row.grant.is_some() || row.mutation.on_behalf.is_some() {
                    Err(crate::api::ErrorCode::Forbidden.err_with_reason(
                        "unindexed_device_capture_required",
                        "reverse capture requires the editor device",
                    ))
                } else {
                    super::unindexed_reverse_entry::entry_plain(
                        &row,
                        &planned,
                        resurrect,
                        &*self.sealer,
                    )
                }
            } else if super::attachment_upload::attaches(&row.mutation) {
                // An uploaded attachment: the runtime family, with its verified
                // object refs (`intent.md` §3.9, §3.11).
                super::attachment_upload::check_row_refs(&row).and_then(|()| {
                    super::attachment_upload::entry_plain(mutation, &planned, resurrect)
                })
            } else if native_move
                || super::attachment_upload::native(&row.mutation)
                || super::carries_attachment(&planned)
            {
                // A move or replace of an attachment file: the runtime family,
                // reusing the signed descriptor (no new objects, no refs).
                super::attachment_upload::entry_plain(mutation, &planned, resurrect)
            } else {
                legacy_entry_plain(mutation, &planned, resurrect)
            };
            let plain = match encoded {
                Ok(p) => p,
                Err(problem) => {
                    rejected.push((row.mutation.id, row.grant, problem.into_problem()));
                    continue;
                }
            };
            let seq = self.head.seq + 1 + items.len() as u64;
            let mut item = Item {
                kind: ItemKind::Entry,
                collection: self.cfg.collection,
                seq: Some(seq),
                prev: Some(prev),
                epoch: Some(epoch),
                signer: Some(self.cfg.device_id),
                salt: Some(B16([0; 16])),
                idem: self.sealer.idem_token(&row.mutation.id),
                // Bound by the AEAD's associated data and the signature.
                refs: (!row.refs.is_empty()).then(|| row.refs.clone()),
                stream: None,
                body: Bytes(Vec::new()),
                sig: None,
            };
            // No compression for private collections or app writes.
            let compress = !self.cfg.e2e
                && self.policy.cstate != Some(mdbn_wire::policy::CState::E2e)
                && self.policy.compress
                && row.mutation.on_behalf.is_none();
            if let Err(e) =
                self.sealer
                    .seal(&mut item, &plain, compress, self.host.entropy.as_mut())
            {
                sealed_err = Some(e);
                break;
            }
            let Ok(b) = item.to_bytes() else {
                break;
            };
            if bytes + b.len() as u64 > self.tuning.max_bytes && !items.is_empty() {
                break;
            }
            if b.len() > 1 << 20 {
                rejected.push((
                    row.mutation.id,
                    row.grant,
                    crate::api::ErrorCode::TooLarge.problem("the entry exceeds 1 MiB"),
                ));
                continue;
            }
            bytes += b.len() as u64;
            prev = mdbn_wire::hash::chain_hash(&b);
            overlay.apply(&planned);
            items.push(Bytes(b));
            mutations.push(row.mutation.id);
            if planned.ends_batch {
                break;
            }
        }
        drop(overlay);
        drop(view);
        for problem in native_move_holds {
            self.incident(
                IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!(
                    "native_move_restore_held: {}",
                    problem.reason.as_deref().unwrap_or("native_move_changed"),
                ))),
            );
        }
        if let Some(e) = sealed_err {
            self.incident(
                IncidentKind::WaitingForKey,
                Some(mdbn_wire::common::Value::Text(format!("{e:?}"))),
            );
        }
        if !rejected.is_empty() || !confirmed.is_empty() {
            self.resolve_rejected(rejected)?;
            for (id, seq) in confirmed {
                self.resolve_confirmed_without_entry(id, seq)?;
            }
        }
        for (id, grant, seq) in hosted_known {
            self.hosted_resolve_logged(id, grant, seq)?;
        }
        if items.is_empty() {
            return Ok(());
        }
        let params = AppendParams {
            collection: self.cfg.collection,
            expect_seq: self.head.seq + 1,
            expect_prev: self.head.chain,
            items,
        };
        self.send_append(Sent {
            params,
            mutations,
            call: CallId(0),
        });
        Ok(())
    }

    /// The `initial` rekey right after genesis, or the rekey a revocation requires
    /// (`sealed-envelope.md` §5.2). Appended alone; returns whether one was sent.
    fn send_rekey_if_needed(&mut self) -> bool {
        use crate::crypto::keys::Recipient;
        use mdbn_wire::envelope::RekeyReason;
        use mdbn_wire::policy::{CState, DeviceKind};
        if self.cfg.key_grants_only {
            return false;
        }
        let me = self.cfg.device_id;
        let pol = &self.policy;
        if pol.root.is_none() {
            return false;
        }
        let Some(d) = pol.devices.get(&me).filter(|d| d.active) else {
            return false;
        };
        let (reason, recipients): (RekeyReason, Vec<mdbn_wire::common::Uuid>) = if pol.epoch == 0 {
            // Initial (sealed-envelope.md §5.2, §7.1). An editor
            // device keys itself and, in cloud copy, the escrow and hosted; an Owner's
            // desktop (current signed role) also keys every active desktop. In cloud
            // copy hosted may be the first keyed replica: it keys itself, the escrow
            // and every active approved account device, whether or not one joined
            // before bootstrap. The first valid initial rekey wins.
            let user = matches!(
                d.kind,
                DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
            );
            let editor = user && pol.device_can_write_if_keyed(&me);
            let cloud = pol.cstate == Some(CState::CloudCopy);
            let hosted_first = d.kind == DeviceKind::Hosted && cloud;
            if !editor && !hosted_first {
                return false;
            }
            let owner_desktop = d.kind == DeviceKind::Desktop
                && pol.members.get(&d.account) == Some(&mdbn_wire::policy::Role::Owner);
            let mut r = vec![me];
            if cloud {
                r.extend(
                    pol.devices
                        .iter()
                        .filter(|(id, x)| {
                            let account_device = matches!(
                                x.kind,
                                DeviceKind::Desktop
                                    | DeviceKind::Mobile
                                    | DeviceKind::AppRuntime
                                    | DeviceKind::Cli
                            ) && pol.members.contains_key(&x.account);
                            **id != me
                                && x.active
                                && (matches!(x.kind, DeviceKind::Escrow | DeviceKind::Hosted)
                                    || (hosted_first && account_device)
                                    || (owner_desktop && x.kind == DeviceKind::Desktop))
                        })
                        .map(|(id, _)| *id),
                );
            }
            (RekeyReason::Initial, r)
        } else if pol.rekey_required && d.keyed && !self.key_untrusted {
            (
                RekeyReason::DeviceRevoked,
                pol.rekey_recipients().into_iter().collect(),
            )
        } else {
            return false;
        };
        let rs: Vec<Recipient> = recipients
            .iter()
            .filter_map(|id| {
                pol.devices.get(id).map(|d| Recipient {
                    device: *id,
                    kem_pk: d.kem_pk.0,
                })
            })
            .collect();
        let from = pol.epoch;
        let payload = match self
            .sealer
            .build_rekey(from, &rs, reason, self.host.entropy.as_mut())
        {
            Ok(p) => p,
            Err(e) => {
                self.incident(
                    IncidentKind::KeyInconsistent,
                    Some(mdbn_wire::common::Value::Text(format!("rekey: {e:?}"))),
                );
                return false;
            }
        };
        let Ok(body) = payload.to_bytes() else {
            return false;
        };
        self.append_control(ItemKind::Rekey, body)
    }

    /// Who may grant now: hosted in a cloud copy, or the escrow as
    /// a fallback when no hosted device is active or hosted has not acted for
    /// [`ESCROW_GRANT_AFTER_MS`] since the last policy item (its `issued_at`). Returns
    /// `None`, or `Some(at)` with the time the escrow fallback opens (a future time
    /// means "not yet", for the host's next wakeup).
    pub(crate) fn key_grant_turn(&self) -> Option<i64> {
        use mdbn_wire::policy::{CState, DeviceKind};
        let me = self.cfg.device_id;
        let pol = &self.policy;
        let kind = pol
            .devices
            .get(&me)
            .filter(|d| d.active && d.keyed)
            .map(|d| d.kind)?;
        if pol.cstate != Some(CState::CloudCopy)
            || pol.epoch == 0
            || pol.rekey_required
            || self.key_untrusted
            || self.sealer.current_epoch() != Some(pol.epoch)
            || self.grant_candidate().is_none()
        {
            return None;
        }
        match kind {
            DeviceKind::Hosted => Some(i64::MIN),
            DeviceKind::Escrow => {
                let hosted_active = pol
                    .devices
                    .values()
                    .any(|d| d.active && d.kind == DeviceKind::Hosted);
                if !hosted_active {
                    return Some(i64::MIN);
                }
                Some(
                    pol.last_issued_at
                        .unwrap_or(0)
                        .saturating_add(ESCROW_GRANT_AFTER_MS),
                )
            }
            _ => None,
        }
    }

    /// One active, unkeyed user device of a member account (enrolled by the control
    /// plane), with its KEM key.
    fn grant_candidate(&self) -> Option<(mdbn_wire::common::Uuid, [u8; 32])> {
        use mdbn_wire::policy::DeviceKind;
        let pol = &self.policy;
        pol.devices
            .iter()
            .find(|(_, x)| {
                x.active
                    && !x.keyed
                    && matches!(
                        x.kind,
                        DeviceKind::Desktop
                            | DeviceKind::Mobile
                            | DeviceKind::AppRuntime
                            | DeviceKind::Cli
                    )
                    && pol.members.contains_key(&x.account)
            })
            .map(|(id, x)| (*id, x.kem_pk.0))
    }

    /// Wrap the current epoch key to one active, unkeyed device of a member account
    /// when it is this device's turn ([`Self::key_grant_turn`]). Appended alone;
    /// returns whether one was sent.
    fn send_key_grant_if_needed(&mut self) -> bool {
        use crate::crypto::keys::Recipient;
        if self.key_grant_turn().is_none_or(|at| at > self.now()) {
            return false;
        }
        let Some((device, kem_pk)) = self.grant_candidate() else {
            return false;
        };
        let epoch = self.policy.epoch;
        let payload = match self.sealer.build_key_grant(
            epoch,
            &Recipient { device, kem_pk },
            self.host.entropy.as_mut(),
        ) {
            Ok(p) => p,
            Err(e) => {
                self.incident(
                    IncidentKind::KeyInconsistent,
                    Some(mdbn_wire::common::Value::Text(format!("key_grant: {e:?}"))),
                );
                return false;
            }
        };
        let Ok(body) = payload.to_bytes() else {
            return false;
        };
        self.append_control(ItemKind::KeyGrant, body)
    }

    /// Sign and append one control item (`rekey`, `key_grant`) alone at the head.
    pub(crate) fn append_control(&mut self, kind: ItemKind, body: Vec<u8>) -> bool {
        let me = self.cfg.device_id;
        let Some(mut item) = self.control_item(kind, body, me) else {
            return false;
        };
        if self.sealer.sign(&mut item).is_err() {
            return false;
        }
        self.append_item(item)
    }

    /// Append one control item signed by another identity this device holds only
    /// transiently (AK1: the account's recovery device signs a self-grant).
    pub(crate) fn append_signed_control(
        &mut self,
        kind: ItemKind,
        body: Vec<u8>,
        signer: Uuid,
        sign: &dyn Fn(&mut Item) -> bool,
    ) -> bool {
        let Some(mut item) = self.control_item(kind, body, signer) else {
            return false;
        };
        if !sign(&mut item) {
            return false;
        }
        self.append_item(item)
    }

    fn control_item(&self, kind: ItemKind, body: Vec<u8>, signer: Uuid) -> Option<Item> {
        Some(Item {
            kind,
            collection: self.cfg.collection,
            seq: Some(self.head.seq + 1),
            prev: Some(self.head.chain),
            epoch: None,
            signer: Some(signer),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(body),
            sig: None,
        })
    }

    fn append_item(&mut self, item: Item) -> bool {
        let Ok(b) = item.to_bytes() else {
            return false;
        };
        let params = AppendParams {
            collection: self.cfg.collection,
            expect_seq: self.head.seq + 1,
            expect_prev: self.head.chain,
            items: vec![Bytes(b)],
        };
        self.send_append(Sent {
            params,
            mutations: Vec::new(),
            call: CallId(0),
        });
        true
    }

    /// Send (or resend: same bytes, new call) a batch. At most one batch exists at a
    /// time (`log-entry.md` §3.1): it lives in `self.append` until resolved.
    fn send_append(&mut self, mut sent: Sent) {
        self.stats.appends += 1;
        let id = self.queue(LogRequest::Append(sent.params.clone()));
        self.inflight.insert(id, Inflight::Append);
        sent.call = id;
        self.append = AppendState::InFlight(sent);
    }

    /// A reply to an append call that no longer carries the current batch (it was
    /// resent after a reconnect). Its bytes were this batch's bytes, so an
    /// `appended` result is never applied from here: the items come back through a
    /// read, and the current call's own reply resolves the batch.
    fn on_stale_append_reply(&mut self, reply: &LogReply) {
        match reply {
            Ok(LogResponse::Append(AppendResult::Appended(a))) => {
                self.head_known = self.head_known.max(a.last);
            }
            Ok(LogResponse::Append(AppendResult::HeadMoved(h))) => {
                self.head_known = self.head_known.max(h.head);
            }
            // A duplicate's position is not trusted as a head.
            Ok(LogResponse::Append(AppendResult::Duplicate(_))) => {}
            _ => return,
        }
        if self.head_known > self.head.seq {
            self.caught_up = false;
            self.request_read();
        }
    }

    /// Rejected at head: resolve the receipt, drop from pending, rebuild the view.
    pub(crate) fn resolve_rejected(
        &mut self,
        rejected: Vec<(Uuid, Option<Uuid>, mdbn_wire::client::Problem)>,
    ) -> Result<(), StoreError> {
        if rejected.is_empty() {
            return Ok(());
        }
        let now = self.now();
        let mut tx = Tx::default();
        let mut resolved = Vec::new();
        let mut forget = Vec::new();
        for (id, grant, problem) in rejected {
            let relocated_from = self.resurrected.get(&id).copied();
            if relocated_from.is_some() {
                forget.push(id);
            }
            tx.pending_del.push(id);
            tx.local_receipts_put.push(LocalReceipt {
                mutation: id,
                state: ReceiptState::Rejected,
                seq: None,
                status: None,
                conflicts: Vec::new(),
                problem: Some(problem.clone()),
                resolved_at: now,
                grant,
            });
            let receipt = mdbn_wire::client::Receipt {
                relocated_from,
                mutation: id,
                state: ReceiptState::Rejected,
                seq: None,
                status: None,
                conflicts: None,
                records: None,
                problem: Some(problem),
                published: None,
            };
            resolved.push(receipt);
        }
        // Own acknowledged writes lost after revocation are reported in
        // `lost_entries`.
        let lost_own: Vec<(Uuid, u64)> = forget
            .iter()
            .filter_map(|id| self.resurrected.get(id).map(|seq| (*id, *seq)))
            .collect();
        let orphans = (!lost_own.is_empty()).then(|| self.with_lost_own(&lost_own));
        if let Some(o) = &orphans {
            tx.meta.push(super::orphans::meta(o));
        }
        if !forget.is_empty() {
            let mut rest = self.resurrected.clone();
            for id in &forget {
                rest.remove(id);
            }
            tx.meta.push((
                crate::store::meta_keys::RESURRECT.into(),
                (!rest.is_empty()).then(|| super::lost_tail::encode_resurrected(&rest)),
            ));
        }
        self.store.commit(tx)?;
        for id in forget {
            self.resurrected.remove(&id);
        }
        if let Some(o) = orphans {
            self.orphans = o;
            self.refresh_lost_entries();
        }
        for r in &resolved {
            self.push_durable_receipt(r.clone());
            self.hosted_resolve(r);
        }
        self.after_local_change()?;
        Ok(())
    }

    /// The writer's receipts show the mutation was appended earlier; its entry was
    /// applied, but the pending row survived (a crash between apply and the pending
    /// delete cannot happen with atomic commits, but a snapshot install can do this).
    pub(crate) fn resolve_confirmed_without_entry(
        &mut self,
        id: Uuid,
        seq: u64,
    ) -> Result<(), StoreError> {
        let now = self.now();
        let grant = self.store.pending_get(&id)?.and_then(|r| r.grant);
        self.store.commit(Tx {
            pending_del: vec![id],
            local_receipts_put: vec![LocalReceipt {
                mutation: id,
                state: ReceiptState::Confirmed,
                seq: Some(seq),
                status: None,
                conflicts: Vec::new(),
                problem: None,
                resolved_at: now,
                grant,
            }],
            ..Tx::default()
        })?;
        let receipt = mdbn_wire::client::Receipt {
            relocated_from: None,
            mutation: id,
            state: ReceiptState::Confirmed,
            seq: Some(seq),
            status: None,
            conflicts: None,
            records: None,
            problem: None,
            published: None,
        };
        self.push_durable_receipt(receipt.clone());
        self.hosted_resolve(&receipt);
        self.after_local_change()
    }

    /// The local view changed outside apply: rebuild it.
    pub(crate) fn after_local_change(&mut self) -> Result<(), StoreError> {
        let ids = self.rebuild_local_view(&BTreeSet::new())?;
        self.status_dirty = true;
        self.notify(&ids);
        self.materialize()
    }

    fn on_append_reply(&mut self, id: CallId, reply: LogReply) {
        let current = matches!(&self.append, AppendState::InFlight(s) if s.call == id);
        if !current {
            self.on_stale_append_reply(&reply);
            return;
        }
        let AppendState::InFlight(sent) = std::mem::replace(&mut self.append, AppendState::Idle)
        else {
            return;
        };
        match reply {
            Ok(LogResponse::Append(AppendResult::Appended(a)))
                if a.first != sent.params.expect_seq
                    || a.last.checked_sub(a.first).map(|d| d + 1)
                        != Some(sent.params.items.len() as u64) =>
            {
                // The service claims a range that is not this batch: never a
                // confirmation. Re-read and let apply decide.
                self.incident(
                    IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(format!(
                        "appended {}..{} does not match the batch at {} of {} items",
                        a.first,
                        a.last,
                        sent.params.expect_seq,
                        sent.params.items.len()
                    ))),
                );
                self.head_known = self.head_known.max(a.last);
                self.caught_up = false;
                self.request_read();
            }
            Ok(LogResponse::Append(AppendResult::Appended(a))) => {
                self.moved_streak = 0;
                self.head_known = self.head_known.max(a.last);
                let items: Vec<mdbn_wire::log_service::SeqItem> = sent
                    .params
                    .items
                    .iter()
                    .enumerate()
                    .map(|(i, b)| mdbn_wire::log_service::SeqItem {
                        seq: sent.params.expect_seq + i as u64,
                        item: b.clone(),
                    })
                    .collect();
                // Our own items: apply exactly as anyone's. If the service's chain
                // disagrees with ours, apply reports integrity.
                self.apply_items(items);
                if self.head.seq == a.last && self.head.chain != a.head_chain {
                    self.incident(
                        IncidentKind::Integrity,
                        Some(mdbn_wire::common::Value::Text(
                            "appended chain differs".into(),
                        )),
                    );
                }
            }
            Ok(LogResponse::Append(AppendResult::HeadMoved(h))) => {
                self.stats.head_moved += 1;
                self.moved_streak += 1;
                self.head_known = self.head_known.max(h.head);
                self.caught_up = false;
                if self.moved_streak >= self.tuning.backoff_after {
                    let mut b = [0u8; 8];
                    self.host.entropy.fill(&mut b);
                    let wait = u64::from_be_bytes(b) % (self.tuning.backoff_max_ms + 1);
                    self.append =
                        AppendState::WaitUntil(self.now() + i64::try_from(wait).unwrap_or(0));
                }
                if h.head < self.head.seq {
                    // The service lost items we applied (failover with a lost tail).
                    self.on_lost_tail(super::lost_tail::Signal::HeadBelow(h.head));
                    return;
                }
                self.request_read();
            }
            Ok(LogResponse::Append(AppendResult::Duplicate(d))) => {
                // Never trust it. Read through `seq`; apply confirms the
                // mutation only if the item there carries it.
                let idx = usize::try_from(d.index).unwrap_or(usize::MAX);
                if let Some(id) = sent.mutations.get(idx).copied() {
                    if d.seq <= self.head.seq {
                        match self.store.receipt(&id) {
                            Ok(Some(_)) => {}
                            _ => {
                                // A false duplicate (log-entry.md §4.1): report it,
                                // keep the mutation pending, and retry from a fresh
                                // read after a pause. A lying service slows this
                                // replica down; it never stops it.
                                self.incident(
                                    IncidentKind::Integrity,
                                    Some(mdbn_wire::common::Value::Text(format!(
                                        "service reported duplicate at {} but the applied log does not carry it",
                                        d.seq
                                    ))),
                                );
                                self.append = AppendState::WaitUntil(
                                    self.now() + i64::try_from(self.tuning.retry_ms).unwrap_or(0),
                                );
                            }
                        }
                    }
                    // The claimed position is not trusted as a head: a fresh read
                    // says where the log is, and apply confirms the mutation only if
                    // the item there carries it.
                    self.caught_up = false;
                    self.request_read();
                }
            }
            Ok(other) => {
                let _ = other;
                self.incident(
                    IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(
                        "unexpected append response".into(),
                    )),
                );
            }
            Err(LogError::NoResponse) => {
                // Outcome unknown: retry the same bytes (log-entry.md §3.1 step 5).
                let at = self.now() + i64::try_from(self.tuning.retry_ms).unwrap_or(0);
                self.append = AppendState::RetryAt(at, sent);
            }
            Err(LogError::Offline) => {
                self.connection = Connection::Offline;
                self.append = AppendState::RetryAt(i64::MAX, sent);
            }
            Err(LogError::Service {
                code,
                retry_after_ms,
                missing,
                ..
            }) => match code {
                LogErrorCode::Unavailable
                | LogErrorCode::RateLimited
                | LogErrorCode::Unauthenticated => {
                    let wait = retry_after_ms.unwrap_or(self.tuning.retry_ms);
                    let at = self.now() + i64::try_from(wait).unwrap_or(0);
                    self.append = AppendState::RetryAt(at, sent);
                }
                LogErrorCode::Frozen => {
                    // Rekey-required or frozen: wait for a push or a rekey.
                    self.append = AppendState::WaitUntil(
                        self.now() + i64::try_from(self.tuning.retry_ms).unwrap_or(0),
                    );
                    self.caught_up = false;
                    self.request_read();
                }
                LogErrorCode::Forbidden => {
                    self.incident(IncidentKind::AccessRevoked, None);
                    self.append = AppendState::Stopped;
                }
                LogErrorCode::QuotaExceeded => {
                    self.incident(IncidentKind::QuotaExceeded, None);
                    self.append = AppendState::Stopped;
                }
                LogErrorCode::Gone => {
                    self.incident(IncidentKind::Gone, None);
                    self.append = AppendState::Stopped;
                }
                LogErrorCode::UpgradeRequired => {
                    self.incident(IncidentKind::UpgradeRequired, None);
                    self.append = AppendState::Stopped;
                }
                LogErrorCode::TooLarge if sent.mutations.len() > 1 => {
                    self.tuning.max_items = 1;
                    self.append = AppendState::Idle;
                }
                LogErrorCode::RefsMissing => {
                    // An uploaded attachment whose objects the log no longer has
                    // fails terminally (typed); anything else (blob parts being
                    // re-uploaded) is re-planned after a pause.
                    match self.fail_attachment_refs_missing(&sent.mutations, &missing) {
                        Ok(true) => self.append = AppendState::Idle,
                        Ok(false) => {
                            self.append = AppendState::WaitUntil(
                                self.now() + i64::try_from(self.tuning.retry_ms).unwrap_or(0),
                            );
                        }
                        Err(e) => {
                            self.incident(
                                IncidentKind::Integrity,
                                Some(mdbn_wire::common::Value::Text(format!("store: {e}"))),
                            );
                            self.append = AppendState::Stopped;
                        }
                    }
                }
                _ => {
                    // invalid / not_found / too_large on one item: a bug or a stale
                    // replica. Re-read and stop until something changes.
                    self.incident(
                        IncidentKind::Integrity,
                        Some(mdbn_wire::common::Value::Text(format!(
                            "append refused: {}",
                            code.as_str()
                        ))),
                    );
                    self.append = AppendState::Stopped;
                    self.caught_up = false;
                    self.request_read();
                }
            },
        }
    }

    fn on_read_reply(
        &mut self,
        reply: LogReply,
        _provenance: Option<super::log_session::MatchedLogReply>,
    ) {
        self.reading = false;
        match reply {
            Ok(LogResponse::Read(r)) => {
                self.connection = Connection::Online;
                self.head_known = self.head_known.max(r.head);
                if r.behind {
                    // A replica at H can read H + 1 whenever the service retains it;
                    // `behind` with retained_from ≤ H + 1 contradicts the answer
                    // itself: never install on its word.
                    if self.head.seq > 0 && r.retained_from <= self.head.seq + 1 {
                        self.incident(
                            IncidentKind::Integrity,
                            Some(mdbn_wire::common::Value::Text(
                                "service claims this replica is behind retention but retains its next item".into(),
                            )),
                        );
                        return;
                    }
                    self.begin_install();
                    return;
                }
                if r.head < self.head.seq {
                    self.on_lost_tail(super::lost_tail::Signal::HeadBelow(r.head));
                    return;
                }
                self.apply_items(r.items);
                if self.apply_fault {
                    return;
                }
                if self.rolling_back() {
                    self.repair_step();
                }
                if !r.more && self.head.seq >= r.head {
                    // A complete read is the service's word on its head: drop any
                    // higher head heard of that it does not hold, so no unbacked
                    // claim keeps this replica reading instead of appending.
                    self.head_known = r.head.max(self.head.seq);
                }
                if r.more || self.head.seq < r.head {
                    self.request_read();
                } else if self.head.seq == r.head && self.stalled.is_none() {
                    if self.head.chain != r.head_chain {
                        self.on_lost_tail(super::lost_tail::Signal::Diverged(r.head));
                        return;
                    }
                    self.caught_up = true;
                }
            }
            Ok(_) => {}
            Err(LogError::Offline) => self.connection = Connection::Offline,
            Err(_) => {}
        }
    }

    fn on_verify_head(&mut self, reply: LogReply) {
        let Ok(LogResponse::Read(r)) = reply else {
            return;
        };
        let ok = r.head >= self.head.seq
            && r.items.first().is_some_and(|it| {
                it.seq == self.head.seq
                    && mdbn_wire::hash::chain_hash(&it.item.0) == self.head.chain
            });
        if ok {
            self.log_move = LogMove::None;
            self.head_known = self.head_known.max(r.head);
            self.clear_incident(IncidentKind::Integrity);
            self.pump();
        } else {
            self.incident(
                IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(
                    "new log endpoint does not continue this replica's chain".into(),
                )),
            );
        }
    }

    /// Run timers: retries and backoff.
    pub fn tick(&mut self) {
        self.prune_hosted_uploads();
        // An unlock's control read-ahead retries after transport trouble.
        self.account_key_ahead_step();
        if self.apply_fault {
            self.flush_status();
            return;
        }
        if self.is_apply_recovering() {
            self.retry_install();
            self.pump();
            self.flush_status();
            return;
        }
        self.hosted_key_rebuild_step();
        let now = self.now();
        match std::mem::replace(&mut self.append, AppendState::Idle) {
            AppendState::RetryAt(t, sent) if now >= t && !self.repairing() => {
                self.send_append(sent)
            }
            other => self.append = other,
        }
        self.retry_publishes();
        self.expire_publish_waits();
        self.expire_regressed();
        if let Err(e) = self.review_orphans() {
            self.incident(
                IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!("store: {e}"))),
            );
        }
        self.retry_install();
        self.pump();
        self.attachment_upload_step();
        self.attachment_fetch_step();
        self.unindexed_upload_step();
        self.unindexed_reverse_upload_step();
        self.maybe_build();
        self.flush_status();
    }

    /// When the replica next wants [`Replica::tick`] (host clock, ms), if ever.
    pub fn next_wakeup(&self) -> Option<i64> {
        let append = match &self.append {
            AppendState::RetryAt(t, _) if *t != i64::MAX => Some(*t),
            AppendState::WaitUntil(t) => Some(*t),
            _ => None,
        };
        // The escrow's fallback key grant opens at a known time: wake for it.
        let grant = self.key_grant_turn().filter(|t| *t > self.now());
        let key_probe = match self.stalled {
            Some((IncidentKind::WaitingForKey, position))
                if !self.reading
                    && !self.local_only()
                    && !self.apply_fault
                    && self.install.is_none()
                    && !self.hosted_blocked()
                    && self.log_move == LogMove::None
                    && self.now() != i64::MAX =>
            {
                self.key_wait_read.deadline(position)
            }
            _ => None,
        };
        let native_upload = self.unindexed_uploads.next_wakeup();
        let reverse_upload = self.unindexed_reverse_uploads.next_wakeup();
        let install_native = self.install_native_auth.next_wakeup();
        let install_text = self.install_text_sources.next_wakeup();
        let upload = self.attachment_uploads.next_wakeup();
        let fetch = self.attachment_fetches.next_wakeup();
        let ingest = self.attachment_ingest.next_wakeup();
        let source = self.unindexed_sources.next_wakeup();
        let reverse_text = self.reverse_text_sources.next_wakeup();
        let native_blob = self.unindexed_blob_fetches.next_wakeup();
        [
            append,
            grant,
            key_probe,
            upload,
            fetch,
            ingest,
            source,
            native_blob,
            native_upload,
            reverse_text,
            reverse_upload,
            install_native,
            install_text,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub(crate) fn flush_status(&mut self) {
        if !self.status_dirty {
            return;
        }
        self.status_dirty = false;
        let subs: Vec<SessionId> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.status_sub)
            .map(|(id, _)| *id)
            .collect();
        if subs.is_empty() {
            return;
        }
        let st = self.sync_status();
        for s in subs {
            self.pushes.push((s, Push::Status(st.clone())));
        }
    }

    /// Hash of the applied head, exposed for tests and digests.
    pub fn head_chain(&self) -> Hash {
        self.head.chain
    }
}

impl<S: Store> Replica<S> {
    pub(super) fn dispatch_log_reply(
        &mut self,
        id: CallId,
        reply: LogReply,
        provenance: Option<super::log_session::MatchedLogReply>,
    ) {
        self.forget_log_reply_scope(id);
        if self.apply_fault {
            return;
        }
        let Some(kind) = self.inflight.remove(&id) else {
            return; // stale (e.g. sent to an old endpoint)
        };
        // A failed call, or a head fetch answered with anything but `subscribed`.
        let failed = reply.is_err()
            || (kind == Inflight::Subscribe
                && !matches!(reply, Ok(LogResponse::Subscribed { .. })));
        if kind == Inflight::Subscribe
            && let Ok(LogResponse::Subscribed { head, head_chain }) = &reply
        {
            self.hosted_head_seen(id, *head, *head_chain);
        }
        if kind == Inflight::Subscribe && failed {
            self.hosted_forget_fetch(id);
        }
        match kind {
            Inflight::Append => self.on_append_reply(id, reply),
            Inflight::Read => self.on_read_reply(reply, provenance),
            Inflight::VerifyHead => self.on_verify_head(reply),
            Inflight::Subscribe => match reply {
                Ok(LogResponse::Subscribed { head, head_chain }) => {
                    self.subscribed = true;
                    self.connection = Connection::Online;
                    self.head_known = self.head_known.max(head);
                    if head == self.head.seq && head > 0 && head_chain != self.head.chain {
                        // Same length, different history: the service lost (and
                        // someone overwrote) part of what we applied.
                        self.on_lost_tail(super::lost_tail::Signal::Diverged(head));
                        self.status_dirty = true;
                        return;
                    }
                    if head <= self.head.seq {
                        // Confirm our chain at the head by reading it.
                        if head == self.head.seq && self.log_move == LogMove::None {
                            self.caught_up = true;
                        }
                        if head < self.head.seq {
                            self.on_lost_tail(super::lost_tail::Signal::HeadBelow(head));
                        }
                    }
                    self.status_dirty = true;
                }
                Err(LogError::Offline) => self.connection = Connection::Offline,
                _ => {}
            },
            Inflight::SnapPut => {
                self.on_snap_put(matches!(reply, Ok(LogResponse::PutObject { .. })))
            }
            Inflight::SnapRegister => {
                self.on_snap_registered(matches!(reply, Ok(LogResponse::PutSnapshot(true))))
            }
            Inflight::Install => self.on_install_reply(reply),
            Inflight::InstallNative => self.on_native_install_reply(id, reply),
            Inflight::InstallText => self.on_snapshot_text_reply(id, reply),
            Inflight::Endorse => self.on_endorse_pointers(reply),
            Inflight::EndorseManifest => self.on_endorse_manifest(reply),
            Inflight::KeyRebuild => self.on_key_rebuild(reply),
            Inflight::AccountKeyAhead => self.on_account_key_ahead(reply),
            Inflight::JoinAhead(position) => self.on_join_ahead(position, reply),
            Inflight::OwnerLookup(mutation, seq, head) => {
                self.on_owner_lookup(mutation, seq, head, reply)
            }
            Inflight::RepairProbe(generation, p) => {
                self.on_repair_probe(generation, p, reply, provenance)
            }
            Inflight::RepairAppend(generation, n) => self.on_repair_append(generation, n, reply),
            Inflight::Attachment(mutation) => self.on_attachment_reply(mutation, id, reply),
            Inflight::UnindexedUpload(upload) => self.on_unindexed_upload_reply(upload, id, reply),
            Inflight::UnindexedReindexUpload(upload) => {
                self.on_unindexed_reverse_upload_reply(upload, id, reply)
            }
            Inflight::AttachmentFetch(file) => self.on_attachment_fetch_reply(file, id, reply),
            Inflight::UnindexedSource(head) => self.on_unindexed_source_reply(head, id, reply),
            Inflight::UnindexedReverseText(head) => self.on_reverse_text_reply(head, id, reply),
            Inflight::UnindexedBlob(file) => self.on_native_blob_reply(file, id, reply),
            Inflight::AttachmentInventory(manifest) => {
                self.on_attachment_inventory_reply(manifest, id, reply)
            }
            Inflight::Other => {}
        }
        if failed {
            self.hosted_stale();
        }
        self.pump();
        self.attachment_upload_step();
        self.unindexed_upload_step();
        self.unindexed_reverse_upload_step();
        self.hosted_note_progress();
        self.flush_status();
    }
}

impl<S: Store> LogPort for Replica<S> {
    fn take_log_calls(&mut self) -> Vec<crate::log::LogCall> {
        self.prune_hosted_uploads();
        std::mem::take(&mut self.calls)
    }

    fn on_log_reply(&mut self, id: CallId, reply: LogReply) {
        // Compatibility delivery has no authenticated repair-read provenance.
        self.dispatch_log_reply(id, reply, None);
    }

    fn on_log_push(&mut self, push: LogPush) {
        // An unscoped lifecycle event cannot renew old authenticated provenance.
        if matches!(push, LogPush::Reconnected | LogPush::Disconnected) {
            self.retire_log_session_for_legacy_lifecycle();
        }
        self.dispatch_log_push(push);
    }
}

impl<S: Store> Replica<S> {
    pub(super) fn dispatch_log_push(&mut self, push: LogPush) {
        if self.apply_fault {
            return;
        }
        match push {
            LogPush::Items {
                collection,
                items,
                head,
                ..
            } if collection == self.cfg.collection => {
                self.head_known = self.head_known.max(head);
                if items.first().is_some_and(|i| i.seq == self.head.seq + 1)
                    && !self.reading
                    && !self.hosted_blocked()
                {
                    self.apply_items(items);
                }
                // If our own append is in flight, its reply resolves it; the items
                // may already be applied, which apply handles idempotently.
            }
            LogPush::Head {
                collection, head, ..
            } if collection == self.cfg.collection => {
                self.head_known = self.head_known.max(head);
            }
            LogPush::Closed { collection, reason } if collection == self.cfg.collection => {
                self.hosted_stale();
                self.subscribed = false;
                match reason.as_str() {
                    "gone" => self.incident(IncidentKind::Gone, None),
                    "forbidden" => self.incident(IncidentKind::AccessRevoked, None),
                    _ => {}
                }
            }
            LogPush::Reconnected => {
                self.hosted_stale();
                self.connection = Connection::Connecting;
                self.caught_up = false;
                self.queue_head_fetch();
                // An outstanding batch, whether waiting to retry or still in flight
                // across the outage, is resent with the same bytes (§4.2). It is
                // never dropped: planning a new batch while it may have landed is
                // what confirmed writes at positions that didn't exist.
                match std::mem::replace(&mut self.append, AppendState::Idle) {
                    AppendState::RetryAt(_, sent) | AppendState::InFlight(sent) => {
                        self.send_append(sent)
                    }
                    other => self.append = other,
                }
            }
            LogPush::Disconnected => {
                self.hosted_stale();
                self.connection = Connection::Offline;
                self.subscribed = false;
            }
            _ => {}
        }
        self.status_dirty = true;
        self.pump();
        self.hosted_note_progress();
        self.flush_status();
    }
}

/// Keep a reference to the unused import of `Inflight::Other` meaningful.
#[allow(dead_code)]
fn _other() -> Inflight {
    Inflight::Other
}

/// The canonical payload of a legacy row: exactly the legacy codec, whose
/// operations and effects are all legacy (anything else is a typed rejection).
fn legacy_entry_plain(
    mutation: mdbn_wire::attachment_runtime_v1::Mutation,
    planned: &mdbn_core::plan::Planned,
    resurrect: Option<u64>,
) -> crate::api::ApiResult<Vec<u8>> {
    let Ok(mutation) = super::attachment_runtime::legacy_mutation(mutation) else {
        return Err(crate::api::ErrorCode::InvalidRequest.err("unconvertible mutation"));
    };
    let effects = planned
        .effects
        .iter()
        .map(convert::weffect)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::api::ApiError::from(super::unencodable_result(&e)))?;
    let conflicts = if planned.conflicts.is_empty() {
        None
    } else {
        Some(
            planned
                .conflicts
                .iter()
                .map(convert::wconflict)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| crate::api::ApiError::from(super::unencodable_result(&e)))?,
        )
    };
    let payload = EntryPayload {
        resurrect,
        sem: mdbn_wire::common::Version {
            major: planned.sem.major,
            minor: planned.sem.minor,
        },
        mutation,
        status: convert::wstatus(planned.status),
        effects,
        conflicts,
        aliases: if planned.aliases.is_empty() {
            None
        } else {
            Some(planned.aliases.iter().map(convert::walias).collect())
        },
        texts: None,
    };
    payload
        .to_bytes()
        .map_err(|_| crate::api::ErrorCode::InvalidRequest.err("result does not encode"))
}
