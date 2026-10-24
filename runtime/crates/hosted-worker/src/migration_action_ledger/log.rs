//! Closed native settlement of the fence-first Driver's log actions through the
//! actual Engine's replica and its authenticated log session.
//!
//! | Retained action | Effect (`log_append`) | Settles from |
//! |---|---|---|
//! | `AppendBase` | seal ONE hosted-import base, send/resend those bytes | the base installed at its position, or the batch's fate |
//! | `FindBase` | — | the installed base, caught up |
//! | `AppendCutover` | none: the control plane appends it | the applied `migration-cutover` |
//! | `FindCutover` | — | the applied `migration-cutover`, caught up |
//! | `LogHead` | — | the caught-up head, at or past the cutover |
//! | `Rebuild` | — | an Engine opened over an empty cache, caught up past `at_least` |
//! | `ReadNew` | — | the rebuilt cache's live entities, nothing but control items since |
//!
//! Evidence only, never an input: there is no byte ingress for a log outcome.
//! A base counts only when the replica INSTALLED it (every `base` rule, the
//! manifest and the state digest checked) and it names this run's collection,
//! generation-0 manifest and state digest, signed by this hosted device. A
//! cutover counts only when policy applied it (control-plane certified, the
//! first and only one) and it names this run's legacy collection and exactly
//! the revoked replicas. Anything foreign refuses and leaves the pending.
//!
//! The base refs come from the generation-0 finish this JournalDriver settled
//! (RAM only, like the custody); the sealed base is kept per action so a lost
//! reply or dropped batch resends the SAME bytes and an action never seals two.
//!
//! `Rebuild` needs the Engine to have opened over an empty cache: preparing it
//! is refused otherwise (see `abi.rs`), so the host resets the cache and reopens
//! first. `ReadNew` pages are bound to that rebuild's head; a content item
//! applied since (another writer) refuses every later page.
use super::{JournalDriver, LedgerError, PreparedAction, Result, target_fingerprint};
use mdbn_migrate_portable::hosted_import::{Action, Class, Key, Meta, Outcome, Step};
use mdbn_migrate_portable::preflight::EntityKind;
use mdbn_replica::replica::migration_log::{
    AppendOutcome, InstalledBase, MigrationLogError, SealedMigrationBase,
};
use mdbn_replica::store::Page;
use mdbn_store_file::index::IndexStorage;
use mdbn_wire::attachment::FileContent;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::snapshot::BaseSource;
use mdbn_wire::unindexed_markdown::FileKindV1;

/// Live entities per `ReadNew` page.
const PAGE: usize = 64;
/// Most resources the rebuilt cache may hold (they are read whole).
const MAX_RESOURCES: usize = 4096;
const MAX_CURSOR: usize = 1024;

/// The base sealed for one retained `AppendBase`.
pub(super) struct BaseAppend {
    action: Uuid,
    sealed: SealedMigrationBase,
}

/// What the host learns from an append: the item's hash and position.
pub(crate) struct LogAppendOutput {
    pub(crate) item: B32,
    pub(crate) seq: u64,
}
impl LogAppendOutput {
    /// `[item hash, seq]`.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub(crate) fn encode(&self) -> Vec<u8> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Bytes(self.item.0.to_vec()),
            Cbor::Uint(self.seq),
        ]))
        .unwrap_or_default()
    }
}

fn refused(e: MigrationLogError) -> LedgerError {
    match e {
        MigrationLogError::Denied => LedgerError::Refused,
        MigrationLogError::NotReady => LedgerError::Refused,
        MigrationLogError::Refused => LedgerError::Conflict,
        MigrationLogError::Unavailable => LedgerError::Refused,
    }
}

/// `ReadNew` position: the rebuilt head, the phase and the last key read.
#[derive(Debug, PartialEq, Eq)]
struct Cursor {
    head: u64,
    phase: u64,
    after: Option<Vec<u8>>,
}
const RESOURCES: u64 = 0;
const RECORDS: u64 = 1;
const FILES: u64 = 2;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || s.len() > MAX_CURSOR {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}
impl Cursor {
    fn encode(&self) -> String {
        hex(&cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(self.head),
            Cbor::Uint(self.phase),
            self.after.clone().map_or(Cbor::Null, Cbor::Bytes),
        ]))
        .unwrap_or_default())
    }
    fn decode(s: &str) -> Result<Cursor> {
        let raw = unhex(s).ok_or(LedgerError::Conflict)?;
        let Ok(Cbor::Array(f)) = cbor::decode(&raw) else {
            return Err(LedgerError::Conflict);
        };
        let [Cbor::Uint(head), Cbor::Uint(phase), after] = f.as_slice() else {
            return Err(LedgerError::Conflict);
        };
        let after = match after {
            Cbor::Null => None,
            Cbor::Bytes(b) => Some(b.clone()),
            _ => return Err(LedgerError::Conflict),
        };
        if *phase > FILES {
            return Err(LedgerError::Conflict);
        }
        let c = Cursor {
            head: *head,
            phase: *phase,
            after,
        };
        // Canonical only: one encoding per position.
        if c.encode() != s {
            return Err(LedgerError::Conflict);
        }
        Ok(c)
    }
}

fn uuid_after(after: &Option<Vec<u8>>) -> Result<Option<Uuid>> {
    after
        .as_ref()
        .map(|b| {
            <[u8; 16]>::try_from(b.as_slice())
                .map(B16)
                .map_err(|_| LedgerError::Conflict)
        })
        .transpose()
}

fn uuid_set(ids: &[String]) -> Result<Vec<Uuid>> {
    let mut v = ids
        .iter()
        .map(|s| {
            mdbn_migrate_portable::ids::uuid(s)
                .map(|u| B16(u.0))
                .map_err(|_| LedgerError::Corrupt)
        })
        .collect::<Result<Vec<_>>>()?;
    v.sort();
    v.dedup();
    if v.len() != ids.len() {
        return Err(LedgerError::Corrupt);
    }
    Ok(v)
}

/// Provenance of one page: the rebuilt head, the cursor asked and every row.
fn digest_page(head: u64, cursor: &Option<String>, rows: &[(Key, Meta)]) -> Result<Cbor> {
    let class = |c: Class| match c {
        Class::Resource => 0,
        Class::Record => 1,
        Class::Attachment => 2,
        Class::UnindexedMarkdown => 3,
    };
    let b = cbor::encode(&Cbor::Array(vec![
        Cbor::Uint(head),
        cursor.clone().map_or(Cbor::Null, Cbor::Text),
        Cbor::Array(
            rows.iter()
                .map(|(k, m)| {
                    Cbor::Array(vec![
                        Cbor::Text(k.id.clone()),
                        Cbor::Uint(class(m.class)),
                        Cbor::Text(m.path.clone()),
                        Cbor::Bytes(m.content.0.to_vec()),
                        Cbor::Uint(m.size),
                    ])
                })
                .collect(),
        ),
    ]))
    .map_err(|_| LedgerError::Invalid)?;
    Ok(Cbor::Bytes(
        mdbn_wire::hash::h("mdbase/v1/native-log-page", &b)
            .0
            .to_vec(),
    ))
}

impl<I: IndexStorage> JournalDriver<I> {
    /// Keep the generation-0 base refs of the settled finish (RAM only).
    pub(super) fn retain_base_refs(&mut self, manifest: B32, refs: Vec<B32>) {
        self.base_refs = Some((manifest, refs));
    }

    /// Same live ticket, same actual native target as the run binding.
    fn log_bound<S: mdbn_replica::Store>(
        &mut self,
        ticket: &PreparedAction,
        engine: &crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<()> {
        self.assert_prepared(ticket)?;
        engine
            .recheck_native_target(target)
            .map_err(|_| LedgerError::Refused)?;
        if target.admission().collection() != self.binding.collection
            || target_fingerprint(target) != self.binding.target
        {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }

    /// This run's base: signed by this hosted device, a hosted import of this
    /// run's collection naming the finish's manifest and state digest.
    pub(super) fn base_is_ours(&self, b: &InstalledBase, device: Uuid) -> bool {
        let cp = self.driver.checkpoint();
        b.signer == device
            && b.source == BaseSource::HostedImport
            && b.legacy_collection == Some(self.binding.collection)
            && Some(b.manifest) == cp.manifest
            && Some(b.state_digest) == cp.state_digest
    }

    /// Seal (once per action) and send the retained `AppendBase`'s base, or
    /// resend the same bytes after a lost reply or dropped batch. Sending never
    /// settles: [`Self::settle_log`] reads what the log made of it.
    pub(crate) fn log_append<S: mdbn_replica::Store>(
        &mut self,
        ticket: &PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<LogAppendOutput> {
        self.log_bound(ticket, engine, target)?;
        let Action::AppendBase {
            manifest,
            state_digest,
        } = *self.prepared_action(ticket)?
        else {
            return Err(LedgerError::Conflict);
        };
        let action = ticket.data.action;
        let collection = self.binding.collection;
        let replica = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?;
        if let Some(b) = self.log_base.as_ref().filter(|b| b.action == action) {
            // Resend only a batch that is gone; never one in flight or answered.
            match replica.hosted_migration_append_outcome(&b.sealed.item()) {
                Some(AppendOutcome::Dropped) => {}
                _ => return Err(LedgerError::Conflict),
            }
            replica
                .hosted_migration_base_send(target.admission(), &b.sealed)
                .map_err(refused)?;
            return Ok(LogAppendOutput {
                item: b.sealed.item(),
                seq: b.sealed.seq(),
            });
        }
        let refs = match &self.base_refs {
            Some((m, refs)) if *m == manifest => refs.clone(),
            // Lost with the RAM (eviction): this action cannot seal a base.
            _ => return Err(LedgerError::Conflict),
        };
        let sealed = replica
            .hosted_migration_base_seal(
                target.admission(),
                manifest,
                state_digest,
                collection,
                refs,
            )
            .map_err(refused)?;
        replica
            .hosted_migration_base_send(target.admission(), &sealed)
            .map_err(refused)?;
        let out = LogAppendOutput {
            item: sealed.item(),
            seq: sealed.seq(),
        };
        self.log_base = Some(BaseAppend { action, sealed });
        Ok(out)
    }

    /// Settle the retained log action from the Engine's own log evidence (see
    /// the module table). A refusal writes nothing and leaves the pending.
    pub(crate) fn settle_log<S: mdbn_replica::Store>(
        &mut self,
        ticket: &PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<B32> {
        self.log_bound(ticket, engine, target)?;
        let action = self.prepared_action(ticket)?.clone();
        let fresh = engine.migration_opened_empty();
        let replica = engine.replica();
        let admission = target.admission();
        let device = admission.device();
        let cp = self.driver.checkpoint().clone();
        let mut provenance = Vec::new();
        let outcome = match &action {
            Action::AppendBase { manifest, .. } => {
                let Some(b) = self
                    .log_base
                    .as_ref()
                    .filter(|b| b.action == ticket.data.action)
                else {
                    // This instance prepared the action (the ticket is
                    // instance-bound) and never sealed or sent a base for it.
                    // With the finish's refs lost to an eviction it never can:
                    // settle Stale, so the Driver re-imports (one attempt).
                    if self.base_refs.as_ref().is_some_and(|(m, _)| m == manifest) {
                        return Err(LedgerError::Conflict);
                    }
                    replica.hosted_migration_head(admission).map_err(refused)?;
                    if replica
                        .hosted_migration_installed_base(admission)
                        .map_err(refused)?
                        .is_some()
                    {
                        return Err(LedgerError::Conflict);
                    }
                    provenance.push(Cbor::Bytes(manifest.0.to_vec()));
                    let pending = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
                    let result = super::codec::log_outcome(pending, &Outcome::Stale, provenance)?;
                    return self.settle_checked(ticket, Outcome::Stale, result);
                };
                let installed = replica
                    .hosted_migration_installed_base(admission)
                    .map_err(refused)?;
                let fate = replica.hosted_migration_append_outcome(&b.sealed.item());
                provenance.push(Cbor::Bytes(b.sealed.item().0.to_vec()));
                match installed {
                    Some(i)
                        if i.item == b.sealed.item()
                            && i.seq == b.sealed.seq()
                            && self.base_is_ours(&i, device) =>
                    {
                        Outcome::Appended { seq: i.seq }
                    }
                    _ if fate == Some(AppendOutcome::RefsMissing) => Outcome::Stale,
                    _ => {
                        // Unknown only once the position is provably not ours:
                        // caught up past it with our batch answered or gone.
                        let head = replica.hosted_migration_head(admission).map_err(refused)?;
                        if head.seq < b.sealed.seq()
                            || !matches!(
                                fate,
                                Some(AppendOutcome::Appended | AppendOutcome::Dropped)
                            )
                        {
                            return Err(LedgerError::Refused);
                        }
                        Outcome::Unknown
                    }
                }
            }
            Action::FindBase => {
                replica.hosted_migration_head(admission).map_err(refused)?;
                match replica
                    .hosted_migration_installed_base(admission)
                    .map_err(refused)?
                {
                    Some(i) if self.base_is_ours(&i, device) => {
                        provenance.push(Cbor::Bytes(i.item.0.to_vec()));
                        Outcome::Found { seq: Some(i.seq) }
                    }
                    // Another base holds generation 0: never this run's.
                    Some(_) => return Err(LedgerError::Conflict),
                    None => Outcome::Found { seq: None },
                }
            }
            Action::AppendCutover { .. } | Action::FindCutover => {
                let find = matches!(action, Action::FindCutover);
                if find {
                    replica.hosted_migration_head(admission).map_err(refused)?;
                }
                match replica
                    .hosted_migration_cutover(admission)
                    .map_err(refused)?
                {
                    Some(c) => {
                        if c.legacy_collection != self.binding.collection
                            || uuid_set(&cp.revoked)? != {
                                let mut r = c.revoked.clone();
                                r.sort();
                                r
                            }
                            || c.freeze == Some(true)
                            || cp.base_seq.is_none_or(|b| c.seq <= b)
                        {
                            return Err(LedgerError::Conflict);
                        }
                        provenance.push(Cbor::Uint(c.seq));
                        if find {
                            Outcome::Found { seq: Some(c.seq) }
                        } else {
                            Outcome::Appended { seq: c.seq }
                        }
                    }
                    None if find => Outcome::Found { seq: None },
                    // The control plane has not appended it yet.
                    None => return Err(LedgerError::Refused),
                }
            }
            Action::LogHead => {
                let head = replica.hosted_migration_head(admission).map_err(refused)?;
                if cp.cutover_seq.is_none_or(|c| head.seq < c) {
                    return Err(LedgerError::Refused);
                }
                provenance.push(Cbor::Bytes(head.chain.0.to_vec()));
                Outcome::Head { seq: head.seq }
            }
            Action::Rebuild { at_least } => {
                let head = replica.hosted_migration_head(admission).map_err(refused)?;
                if !fresh || head.seq < *at_least {
                    return Err(LedgerError::Refused);
                }
                let base_seq = cp.base_seq.ok_or(LedgerError::Corrupt)?;
                match replica
                    .hosted_migration_installed_base(admission)
                    .map_err(refused)?
                {
                    Some(i) if i.seq == base_seq && self.base_is_ours(&i, device) => {}
                    _ => return Err(LedgerError::Conflict),
                }
                if cp.step == Step::Replayed {
                    match replica
                        .hosted_migration_cutover(admission)
                        .map_err(refused)?
                    {
                        Some(c) if Some(c.seq) == cp.cutover_seq => {}
                        _ => return Err(LedgerError::Conflict),
                    }
                }
                provenance.push(Cbor::Bytes(head.chain.0.to_vec()));
                Outcome::Rebuilt { head: head.seq }
            }
            Action::ReadNew { cursor } => {
                let rebuilt = self.log_rebuilt.ok_or(LedgerError::Conflict)?;
                replica.hosted_migration_head(admission).map_err(refused)?;
                if !replica
                    .hosted_migration_control_only_since(admission, rebuilt)
                    .map_err(refused)?
                {
                    return Err(LedgerError::Conflict);
                }
                let at = match cursor {
                    None => Cursor {
                        head: rebuilt,
                        phase: RESOURCES,
                        after: None,
                    },
                    Some(s) => Cursor::decode(s)?,
                };
                if at.head != rebuilt {
                    return Err(LedgerError::Conflict);
                }
                let (rows, next) = page(replica.store(), &at)?;
                let next = next.map(|c| c.encode());
                provenance.push(digest_page(rebuilt, cursor, &rows)?);
                Outcome::NewPage { rows, next }
            }
            _ => return Err(LedgerError::Conflict),
        };
        let pending = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
        let result = super::codec::log_outcome(pending, &outcome, provenance)?;
        let rebuilt = match outcome {
            Outcome::Rebuilt { head } => Some(head),
            _ => None,
        };
        let settled = self.settle_checked(ticket, outcome, result)?;
        if let Some(head) = rebuilt {
            self.log_rebuilt = Some(head);
        }
        if matches!(action, Action::AppendBase { .. }) {
            self.log_base = None;
        }
        Ok(settled)
    }
}

/// Live entities of one page, and the position after it.
type Paged = (Vec<(Key, Meta)>, Option<Cursor>);

/// One page of live entities at `at`, and the position after it.
fn page<S: mdbn_replica::Store>(store: &S, at: &Cursor) -> Result<Paged> {
    let next_phase = |phase| {
        (phase < FILES).then(|| Cursor {
            head: at.head,
            phase: phase + 1,
            after: None,
        })
    };
    let more = |after: Vec<u8>| Cursor {
        head: at.head,
        phase: at.phase,
        after: Some(after),
    };
    let storage = |_| LedgerError::StorageUnknown;
    match at.phase {
        RESOURCES => {
            let mut all = store.resources().map_err(storage)?;
            if all.len() > MAX_RESOURCES {
                return Err(LedgerError::Unsupported);
            }
            all.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            let after = at.after.as_deref();
            let mut rows: Vec<_> = all
                .into_iter()
                .filter(|(p, _)| after.is_none_or(|a| p.as_bytes() > a))
                .take(PAGE + 1)
                .collect();
            let full = rows.len() > PAGE;
            rows.truncate(PAGE);
            let next = match (full, rows.last()) {
                (true, Some((p, _))) => Some(more(p.as_bytes().to_vec())),
                _ => next_phase(RESOURCES),
            };
            let rows = rows
                .into_iter()
                .map(|(path, text)| {
                    (
                        Key {
                            kind: EntityKind::Resource,
                            id: path.clone(),
                        },
                        Meta {
                            class: Class::Resource,
                            content: mdbn_wire::hash::sha256(text.as_bytes()),
                            size: text.len() as u64,
                            path,
                        },
                    )
                })
                .collect();
            Ok((rows, next))
        }
        RECORDS => {
            let mut rows = store
                .records(Page {
                    after: uuid_after(&at.after)?,
                    limit: PAGE as u32 + 1,
                })
                .map_err(storage)?;
            let full = rows.len() > PAGE;
            rows.truncate(PAGE);
            let next = match (full, rows.last()) {
                (true, Some(r)) => Some(more(r.id.0.to_vec())),
                _ => next_phase(RECORDS),
            };
            let rows = rows
                .into_iter()
                .map(|r| {
                    if r.revision != mdbn_wire::hash::sha256(r.doc.as_bytes()) {
                        return Err(LedgerError::Corrupt);
                    }
                    Ok((
                        Key {
                            kind: EntityKind::Record,
                            id: r.id.to_uuid_string(),
                        },
                        Meta {
                            class: Class::Record,
                            content: r.revision,
                            size: r.doc.len() as u64,
                            path: r.path,
                        },
                    ))
                })
                .collect::<Result<_>>()?;
            Ok((rows, next))
        }
        _ => {
            let mut rows = store
                .files(Page {
                    after: uuid_after(&at.after)?,
                    limit: PAGE as u32 + 1,
                })
                .map_err(storage)?;
            let full = rows.len() > PAGE;
            rows.truncate(PAGE);
            let next = match (full, rows.last()) {
                (true, Some(f)) => Some(more(f.id.0.to_vec())),
                _ => None,
            };
            let rows = rows
                .into_iter()
                .map(|f| {
                    let FileContent::AttachmentV1(c) = &f.content else {
                        return Err(LedgerError::Unsupported);
                    };
                    if f.kind != FileKindV1::Ordinary {
                        return Err(LedgerError::Unsupported);
                    }
                    Ok((
                        Key {
                            kind: EntityKind::File,
                            id: f.id.to_uuid_string(),
                        },
                        Meta {
                            class: Class::Attachment,
                            content: c.whole_plain_hash,
                            size: c.total_plain_bytes,
                            path: f.path,
                        },
                    ))
                })
                .collect::<Result<_>>()?;
            Ok((rows, next))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_is_canonical_and_bounded() {
        let c = Cursor {
            head: 7,
            phase: RECORDS,
            after: Some(vec![0xab; 16]),
        };
        let s = c.encode();
        assert_ne!(s, s.to_uppercase());
        assert_eq!(Cursor::decode(&s).unwrap(), c);
        assert!(Cursor::decode(&s.to_uppercase()).is_err());
        assert!(Cursor::decode(&format!("{s}00")).is_err());
        let bad = Cursor {
            head: 7,
            phase: 3,
            after: None,
        };
        assert!(Cursor::decode(&bad.encode()).is_err());
        assert!(Cursor::decode(&"0".repeat(MAX_CURSOR + 2)).is_err());
    }
}
