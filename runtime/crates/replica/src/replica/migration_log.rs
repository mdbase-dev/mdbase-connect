//! Hosted migration on the log path: the `hosted-import` base this hosted replica
//! signs and appends, and the log evidence a native migration ledger settles
//! from (`docs/ship/interfaces/2026-10-12-native-migration-log-path.md`).
//!
//! Every call takes the expected full native hosted admission and refuses on any
//! drift. Nothing here is a verdict of its own: a base counts only once this
//! replica applied and INSTALLED it (every `base` rule, the manifest and the
//! state digest checked), which commits [`InstalledBase`] with the install; a
//! cutover counts only once policy applied it (`policy.cutover`), read back from
//! the retained item at that position. A void, foreign or pruned item is never
//! evidence.
//!
//! The append keeps the exact sealed bytes: a lost reply resends them, a
//! rejected or dropped batch is reported, never re-sealed here.

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Hash, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::policy::{PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::BaseSource;

use super::append::{AppendState, Sent};
use super::{HostedAdmission, Replica, VerifiedHostedAdmission};
use crate::log::{LogError, LogErrorCode, LogReply, LogResponse};
use crate::store::{Head, Store, meta_keys};
use mdbn_wire::log_service::AppendResult;

/// Most refs a migration base carries (the hosted custody's 1024 plus the
/// manifest and finish sections).
const MAX_REFS: usize = 1029;
/// Most positions [`Replica::hosted_migration_control_only_since`] inspects.
pub const MAX_SINCE: u64 = 64;

/// A valid `base` this replica installed, as committed with the install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledBase {
    /// Its log position.
    pub seq: u64,
    /// SHA-256 of the exact item bytes.
    pub item: B32,
    /// The device that signed it.
    pub signer: Uuid,
    /// Where its state came from.
    pub source: BaseSource,
    /// The Connect collection it imports, if any.
    pub legacy_collection: Option<Uuid>,
    /// The generation-0 manifest it names.
    pub manifest: B32,
    /// The manifest's state digest.
    pub state_digest: Hash,
}

fn bytes<const N: usize>(v: &Cbor) -> Option<[u8; N]> {
    match v {
        Cbor::Bytes(b) => b.as_slice().try_into().ok(),
        _ => None,
    }
}

impl InstalledBase {
    pub(crate) fn encode(&self) -> Vec<u8> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(self.seq),
            Cbor::Bytes(self.item.0.to_vec()),
            Cbor::Bytes(self.signer.0.to_vec()),
            Cbor::Uint(self.source as u64),
            self.legacy_collection
                .map_or(Cbor::Null, |c| Cbor::Bytes(c.0.to_vec())),
            Cbor::Bytes(self.manifest.0.to_vec()),
            Cbor::Bytes(self.state_digest.0.to_vec()),
        ]))
        .unwrap_or_default()
    }

    fn decode(raw: &[u8]) -> Option<InstalledBase> {
        let Ok(Cbor::Array(f)) = cbor::decode(raw) else {
            return None;
        };
        let [
            Cbor::Uint(seq),
            item,
            signer,
            Cbor::Uint(source),
            legacy,
            manifest,
            digest,
        ] = f.as_slice()
        else {
            return None;
        };
        let source = match source {
            0 => BaseSource::Folder,
            1 => BaseSource::HostedImport,
            _ => return None,
        };
        let legacy_collection = match legacy {
            Cbor::Null => None,
            v => Some(B16(bytes(v)?)),
        };
        Some(InstalledBase {
            seq: *seq,
            item: B32(bytes(item)?),
            signer: B16(bytes(signer)?),
            source,
            legacy_collection,
            manifest: B32(bytes(manifest)?),
            state_digest: B32(bytes(digest)?),
        })
    }
}

/// A sealed, signed `hosted-import` base for one exact position. Opaque: only
/// [`Replica::hosted_migration_base_send`] sends it, always these bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedMigrationBase {
    bytes: Vec<u8>,
    item: B32,
    seq: u64,
    prev: Hash,
}

impl SealedMigrationBase {
    /// SHA-256 of the exact item bytes.
    pub fn item(&self) -> B32 {
        self.item
    }
    /// The position it was sealed for.
    pub fn seq(&self) -> u64 {
        self.seq
    }
    /// The exact item bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// What became of the last migration base batch this replica sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// Sent; no final reply yet (or a lost reply is being retried).
    InFlight,
    /// The service said appended; apply decides whether it is valid.
    Appended,
    /// The service refused it: objects its refs name are missing.
    RefsMissing,
    /// Not appended (head moved, a duplicate claim, or another refusal); the
    /// batch is gone and nothing will resend it.
    Dropped,
}

/// The tracked migration base batch: its item hash and outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppendTrack {
    item: B32,
    outcome: AppendOutcome,
}

/// The migration cutover policy applied, read back from its retained item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedCutover {
    /// Its log position.
    pub seq: u64,
    /// The Connect collection it replaces.
    pub legacy_collection: Uuid,
    /// The legacy replica credentials it names as revoked.
    pub revoked: Vec<Uuid>,
    /// A `freeze` operation in the same item, if any.
    pub freeze: Option<bool>,
}

/// Why a migration log call refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationLogError {
    /// Admission drifted or was denied.
    Denied,
    /// Not caught up and serving (or an append or install is running).
    NotReady,
    /// A rule refuses it (content already seen, frozen, a malformed input).
    Refused,
    /// Evidence that must be retained is gone (pruned) or unreadable.
    Unavailable,
}

type Result<T> = std::result::Result<T, MigrationLogError>;

impl<S: Store> Replica<S> {
    fn migration_admitted(&self, expected: &VerifiedHostedAdmission) -> Result<()> {
        match self.verified_hosted_admission() {
            HostedAdmission::Verified(current) if current.as_ref() == expected => Ok(()),
            _ => Err(MigrationLogError::Denied),
        }
    }

    /// The applied head, only while this hosted replica is serving, caught up to
    /// every head it was told of, with no append, read or install running.
    pub fn hosted_migration_head(&self, expected: &VerifiedHostedAdmission) -> Result<Head> {
        self.migration_admitted(expected)?;
        if self.hosted.is_none()
            || !self.hosted_serving()
            || !self.caught_up
            || self.reading
            || self.append.in_flight()
            || self.install.is_some()
            || self.install_base.is_some()
            || self.head.seq < self.head_known
        {
            return Err(MigrationLogError::NotReady);
        }
        Ok(self.head)
    }

    /// Seal and sign a `hosted-import` base for the next position: `manifest`
    /// and `state_digest` from the generation-0 finish, `refs` its exact base
    /// refs (sorted, the manifest among them), `legacy` the imported collection.
    /// Nothing is sent.
    pub fn hosted_migration_base_seal(
        &mut self,
        expected: &VerifiedHostedAdmission,
        manifest: B32,
        state_digest: Hash,
        legacy: Uuid,
        refs: Vec<B32>,
    ) -> Result<SealedMigrationBase> {
        let head = self.hosted_migration_head(expected)?;
        if self.policy.content_seen
            || self.policy.frozen
            || self.policy.rekey_required
            || self.policy.cstate != Some(mdbn_wire::policy::CState::CloudCopy)
            || legacy.0 == [0; 16]
            || refs.is_empty()
            || refs.len() > MAX_REFS
            || !refs.windows(2).all(|w| w[0].0 < w[1].0)
            || refs.binary_search(&manifest).is_err()
        {
            return Err(MigrationLogError::Refused);
        }
        let me = self.cfg.device_id;
        let spec = super::base::Gen0Base::new(manifest, state_digest, BaseSource::HostedImport)
            .legacy_collection(legacy);
        let (payload, needed) =
            super::base::build_base(me, &spec, &|b| self.sealer.blob_part_addresses(b))
                .map_err(|_| MigrationLogError::Refused)?;
        if needed.iter().any(|r| refs.binary_search(r).is_err()) {
            return Err(MigrationLogError::Refused);
        }
        let plain = payload.to_bytes().map_err(|_| MigrationLogError::Refused)?;
        let mut item = Item {
            kind: ItemKind::Base,
            collection: self.cfg.collection,
            seq: Some(head.seq + 1),
            prev: Some(head.chain),
            epoch: None,
            signer: Some(me),
            salt: None,
            idem: None,
            refs: Some(refs),
            stream: None,
            body: mdbn_wire::common::Bytes(Vec::new()),
            sig: None,
        };
        self.sealer
            .seal(&mut item, &plain, false, self.host.entropy.as_mut())
            .map_err(|_| MigrationLogError::Refused)?;
        let bytes = item.to_bytes().map_err(|_| MigrationLogError::Refused)?;
        Ok(SealedMigrationBase {
            item: mdbn_wire::hash::sha256(&bytes),
            bytes,
            seq: head.seq + 1,
            prev: head.chain,
        })
    }

    /// Send (or resend) exactly `sealed` at its position. Refused unless the
    /// replica is caught up exactly one before it and nothing is in flight.
    pub fn hosted_migration_base_send(
        &mut self,
        expected: &VerifiedHostedAdmission,
        sealed: &SealedMigrationBase,
    ) -> Result<()> {
        let head = self.hosted_migration_head(expected)?;
        if !matches!(self.append, AppendState::Idle) {
            return Err(MigrationLogError::NotReady);
        }
        if head.seq + 1 != sealed.seq
            || head.chain != sealed.prev
            || self.policy.content_seen
            || mdbn_wire::hash::sha256(&sealed.bytes) != sealed.item
        {
            return Err(MigrationLogError::Refused);
        }
        self.append_sealed_at(sealed.seq, sealed.prev, sealed.bytes.clone());
        self.migration_append = Some(AppendTrack {
            item: sealed.item,
            outcome: AppendOutcome::InFlight,
        });
        Ok(())
    }

    /// What became of the batch carrying `item`, if it is the tracked one.
    pub fn hosted_migration_append_outcome(&self, item: &B32) -> Option<AppendOutcome> {
        self.migration_append
            .as_ref()
            .filter(|t| t.item == *item)
            .map(|t| t.outcome)
    }

    /// Record the reply to the tracked base batch (`append.rs`, current call).
    pub(crate) fn track_migration_append(&mut self, sent: &Sent, reply: &LogReply) {
        let Some(track) = self.migration_append.as_mut() else {
            return;
        };
        let [item] = sent.params.items.as_slice() else {
            return;
        };
        if !sent.mutations.is_empty() || mdbn_wire::hash::sha256(&item.0) != track.item {
            return;
        }
        track.outcome = match reply {
            Ok(LogResponse::Append(AppendResult::Appended(_))) => AppendOutcome::Appended,
            Err(LogError::NoResponse | LogError::Offline) => AppendOutcome::InFlight,
            Err(LogError::Service {
                code:
                    LogErrorCode::Unavailable
                    | LogErrorCode::RateLimited
                    | LogErrorCode::Unauthenticated,
                ..
            }) => AppendOutcome::InFlight,
            Err(LogError::Service {
                code: LogErrorCode::RefsMissing,
                ..
            }) => AppendOutcome::RefsMissing,
            _ => AppendOutcome::Dropped,
        };
    }

    /// The valid `base` this replica installed, if any.
    pub fn hosted_migration_installed_base(
        &self,
        expected: &VerifiedHostedAdmission,
    ) -> Result<Option<InstalledBase>> {
        self.migration_admitted(expected)?;
        let raw = self
            .store
            .meta(meta_keys::BASE)
            .map_err(|_| MigrationLogError::Unavailable)?;
        match raw {
            None => Ok(None),
            Some(raw) => InstalledBase::decode(&raw)
                .filter(|b| b.seq >= 1 && b.seq <= self.head.seq)
                .map(Some)
                .ok_or(MigrationLogError::Unavailable),
        }
    }

    /// The migration cutover policy applied, if any, read from its retained
    /// item. A pruned or unreadable item is [`MigrationLogError::Unavailable`].
    pub fn hosted_migration_cutover(
        &self,
        expected: &VerifiedHostedAdmission,
    ) -> Result<Option<AppliedCutover>> {
        self.migration_admitted(expected)?;
        let Some(seq) = self.policy.cutover else {
            return Ok(None);
        };
        let item = self.migration_retained(seq)?;
        if item.kind != ItemKind::Policy || item.seq != Some(seq) {
            return Err(MigrationLogError::Unavailable);
        }
        let payload =
            PolicyPayload::from_bytes(&item.body.0).map_err(|_| MigrationLogError::Unavailable)?;
        let mut cutover = None;
        let mut freeze = None;
        for op in &payload.ops {
            match op {
                PolicyOp::MigrationCutover(c) if cutover.is_none() => {
                    cutover = Some((c.legacy_collection, c.revoked.clone()))
                }
                PolicyOp::MigrationCutover(_) => return Err(MigrationLogError::Unavailable),
                PolicyOp::Freeze(f) => freeze = Some(f.frozen),
                _ => {}
            }
        }
        let (legacy_collection, revoked) = cutover.ok_or(MigrationLogError::Unavailable)?;
        Ok(Some(AppliedCutover {
            seq,
            legacy_collection,
            revoked,
            freeze,
        }))
    }

    /// Whether every position after `after` up to the head holds a retained
    /// control item only: no `entry` or `base` (valid or void) changed the
    /// state since. At most [`MAX_SINCE`] positions; a gap is unavailable.
    pub fn hosted_migration_control_only_since(
        &self,
        expected: &VerifiedHostedAdmission,
        after: u64,
    ) -> Result<bool> {
        self.migration_admitted(expected)?;
        let head = self.head.seq;
        if head < after {
            return Ok(false);
        }
        if head - after > MAX_SINCE {
            return Err(MigrationLogError::Unavailable);
        }
        if head == after {
            return Ok(true);
        }
        let rows = self
            .store
            .tail(after, (head - after) as u32)
            .map_err(|_| MigrationLogError::Unavailable)?;
        if rows.len() as u64 != head - after {
            return Err(MigrationLogError::Unavailable);
        }
        for (i, row) in rows.iter().enumerate() {
            if row.seq != after + 1 + i as u64 {
                return Err(MigrationLogError::Unavailable);
            }
            let item = Item::from_bytes(&row.item).map_err(|_| MigrationLogError::Unavailable)?;
            if matches!(item.kind, ItemKind::Entry | ItemKind::Base) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn migration_retained(&self, seq: u64) -> Result<Item> {
        let row = self
            .store
            .tail(seq - 1, 1)
            .map_err(|_| MigrationLogError::Unavailable)?
            .into_iter()
            .next()
            .filter(|r| r.seq == seq)
            .ok_or(MigrationLogError::Unavailable)?;
        Item::from_bytes(&row.item).map_err(|_| MigrationLogError::Unavailable)
    }
}
