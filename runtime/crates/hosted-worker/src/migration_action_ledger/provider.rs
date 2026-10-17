//! Closed native settlement of Connect and legacy-provider route results.
//!
//! Input is a fixed CBOR mirror of ONE current Connect/provider response body,
//! decoded by the closed host from the migration-token route. Nothing here is
//! signed: no Connect route echoes the Driver action, so native binds what the
//! bodies do carry (collection, owner account, provider migration run) to the
//! saved run and to the exact retained pending action, and refuses everything
//! else. A refusal never settles; the original pending stays UNKNOWN.
//!
//! | Tag | Driver action | Connect/provider body |
//! |---|---|---|
//! | 0 | `EnsureBackup` | operator hold id (`backup_admin acquire`) |
//! | 1 | `MayFence` | `GET …/migration/accounts/:owner` |
//! | 2 | `Fence` | `POST …/migration/collections/:id/fence` |
//! | 3 | `DrainStatus` | `GET …/migration/collections/:id/source` |
//! | 4 | `ListReplicas` | provider `GET …/collections/:id/replicas` ids |
//! | 5 | `RevokeReplicas` | provider `POST …/revoke-replicas` `revoked` |
//! | 6 | `Route` | `POST …/migration/collections/:id/cutover` |
//!
//! Rollback (`Unrevoke`/`Unfence`) is not settled here: it needs the original
//! rollback receipt binding and a re-run after rollback.
use super::{LedgerError, Result};
use mdbn_migrate_portable::hosted_import::{Action, Outcome};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};

/// Whole encoded input. 1000 replica ids at 17 bytes each plus framing fit.
pub(super) const MAX_INPUT: usize = 20 * 1024;
const MAX_IDS: usize = 1000;
const MAX_TEXT: usize = 64;
const MAX_HEAD: u64 = 9_007_199_254_740_991;

/// One decoded Connect/provider result. DATA only until bound to the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ProviderResult {
    Backup {
        hold: Uuid,
    },
    Account(AccountView),
    Fence(Run),
    Drain {
        collection: Uuid,
        state: State,
        run: Option<Run>,
        head: u64,
        retained: bool,
        in_flight: u64,
        unresolved: u64,
        applied_unreceipted: u64,
    },
    Replicas(Vec<Uuid>),
    Revoked(Vec<Uuid>),
    Cutover {
        collection: Uuid,
        account: Uuid,
    },
}

/// The provider's legacy migration run, as fence and drain report it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Run {
    pub(super) collection: Uuid,
    pub(super) migration: Uuid,
    pub(super) started_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum State {
    Active,
    Migrating,
    Migrated,
}

/// Connect's `accountMigrationView` (pause flag included).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AccountView {
    pub(super) account: Uuid,
    pub(super) legacy_backend: bool,
    pub(super) cohort: bool,
    pub(super) released: bool,
    pub(super) started: bool,
    pub(super) terminal_excluded: bool,
    pub(super) paused: bool,
    pub(super) hosted: Vec<Uuid>,
    pub(super) unsettled: Vec<Uuid>,
    pub(super) cut_over: Vec<Uuid>,
}

pub(super) fn uuid(v: &Cbor) -> Result<Uuid> {
    let Cbor::Bytes(b) = v else {
        return Err(LedgerError::Invalid);
    };
    let b: [u8; 16] = b.as_slice().try_into().map_err(|_| LedgerError::Invalid)?;
    if b == [0; 16] {
        return Err(LedgerError::Invalid);
    }
    Ok(B16(b))
}
fn flag(v: &Cbor) -> Result<bool> {
    match v {
        Cbor::Bool(b) => Ok(*b),
        _ => Err(LedgerError::Invalid),
    }
}
pub(super) fn count(v: &Cbor) -> Result<u64> {
    match v {
        Cbor::Uint(n) if *n <= MAX_HEAD => Ok(*n),
        _ => Err(LedgerError::Invalid),
    }
}
/// Opaque provider timestamp text, compared exactly, never interpreted.
pub(super) fn stamp(v: &Cbor) -> Result<String> {
    match v {
        Cbor::Text(s)
            if !s.is_empty() && s.len() <= MAX_TEXT && s.bytes().all(|b| b.is_ascii_graphic()) =>
        {
            Ok(s.clone())
        }
        _ => Err(LedgerError::Invalid),
    }
}
/// Strictly ascending: canonical order, no duplicates, bounded.
pub(super) fn ids(v: &Cbor) -> Result<Vec<Uuid>> {
    let Cbor::Array(items) = v else {
        return Err(LedgerError::Invalid);
    };
    if items.len() > MAX_IDS {
        return Err(LedgerError::Invalid);
    }
    let ids = items.iter().map(uuid).collect::<Result<Vec<_>>>()?;
    if ids.windows(2).any(|w| w[0].0 >= w[1].0) {
        return Err(LedgerError::Invalid);
    }
    Ok(ids)
}
fn state(v: &Cbor) -> Result<State> {
    match v {
        Cbor::Text(s) if s == "active" => Ok(State::Active),
        Cbor::Text(s) if s == "migrating" => Ok(State::Migrating),
        Cbor::Text(s) if s == "migrated" => Ok(State::Migrated),
        _ => Err(LedgerError::Invalid),
    }
}

pub(super) fn decode(input: &[u8]) -> Result<ProviderResult> {
    if input.is_empty() || input.len() > MAX_INPUT {
        return Err(LedgerError::Invalid);
    }
    let Ok(Cbor::Array(fields)) = cbor::decode(input) else {
        return Err(LedgerError::Invalid);
    };
    let Some((Cbor::Uint(tag), f)) = fields.split_first() else {
        return Err(LedgerError::Invalid);
    };
    Ok(match (*tag, f) {
        (0, [hold]) => ProviderResult::Backup { hold: uuid(hold)? },
        (
            1,
            [
                account,
                backend,
                cohort,
                released,
                started,
                excluded,
                paused,
                hosted,
                unsettled,
                cut_over,
            ],
        ) => {
            let legacy_backend = match backend {
                Cbor::Text(s) if s == "legacy" => true,
                Cbor::Text(s) if s == "next" => false,
                _ => return Err(LedgerError::Invalid),
            };
            let cohort = match cohort {
                Cbor::Null => false,
                Cbor::Text(s) if !s.is_empty() && s.len() <= MAX_TEXT => true,
                _ => return Err(LedgerError::Invalid),
            };
            let view = AccountView {
                account: uuid(account)?,
                legacy_backend,
                cohort,
                released: flag(released)?,
                started: flag(started)?,
                terminal_excluded: flag(excluded)?,
                paused: flag(paused)?,
                hosted: ids(hosted)?,
                unsettled: ids(unsettled)?,
                cut_over: ids(cut_over)?,
            };
            // Connect derives both lists from the hosted list.
            if !view
                .unsettled
                .iter()
                .chain(&view.cut_over)
                .all(|c| view.hosted.binary_search_by(|h| h.0.cmp(&c.0)).is_ok())
            {
                return Err(LedgerError::Invalid);
            }
            ProviderResult::Account(view)
        }
        // The fence body is strict: migrating, unretained, nothing restored.
        (
            2,
            [
                collection,
                s,
                migration,
                started_at,
                Cbor::Null,
                Cbor::Array(restored),
            ],
        ) if restored.is_empty() && state(s)? == State::Migrating => ProviderResult::Fence(Run {
            collection: uuid(collection)?,
            migration: uuid(migration)?,
            started_at: stamp(started_at)?,
        }),
        (
            3,
            [
                collection,
                s,
                migration,
                head,
                started_at,
                retain_until,
                in_flight,
                unresolved,
                applied,
            ],
        ) => {
            let collection = uuid(collection)?;
            let run = match (migration, started_at) {
                (Cbor::Null, Cbor::Null) => None,
                (m, t) => Some(Run {
                    collection,
                    migration: uuid(m)?,
                    started_at: stamp(t)?,
                }),
            };
            let retained = match retain_until {
                Cbor::Null => false,
                t => stamp(t).map(|_| true)?,
            };
            let (in_flight, unresolved) = (count(in_flight)?, count(unresolved)?);
            // The provider's unresolved count includes every in-flight row.
            if in_flight > unresolved {
                return Err(LedgerError::Invalid);
            }
            ProviderResult::Drain {
                collection,
                state: state(s)?,
                run,
                head: count(head)?,
                retained,
                in_flight,
                unresolved,
                applied_unreceipted: count(applied)?,
            }
        }
        (4, [list]) => ProviderResult::Replicas(ids(list)?),
        (5, [list]) => ProviderResult::Revoked(ids(list)?),
        (6, [collection, account]) => ProviderResult::Cutover {
            collection: uuid(collection)?,
            account: uuid(account)?,
        },
        _ => return Err(LedgerError::Invalid),
    })
}

/// The run's fixed identity a result is bound to.
pub(super) struct Bound {
    pub(super) collection: Uuid,
    pub(super) owner: Uuid,
}

/// Map one decoded result onto the EXACT retained action. Wrong-kind, foreign
/// or stale results are `Conflict`; nothing is settled. The extra provenance is
/// folded into the settlement digest for later chaining checks.
pub(super) fn outcome(
    action: &Action,
    result: ProviderResult,
    run: &Bound,
    prior_fence: Option<&B32>,
) -> Result<(Outcome, Vec<Cbor>)> {
    let same_run = |r: &Run| -> Result<bool> {
        prior_fence.map_or(Ok(false), |digest| fence_matches(digest, r))
    };
    let stamp_of = |r: &Run| {
        vec![
            Cbor::Bytes(r.migration.0.to_vec()),
            Cbor::Text(r.started_at.clone()),
        ]
    };
    Ok(match (action, result) {
        (Action::EnsureBackup, ProviderResult::Backup { hold }) => (
            Outcome::Backup {
                hold: hold.to_uuid_string(),
            },
            vec![],
        ),
        (Action::MayFence, ProviderResult::Account(v)) => {
            let has = |list: &[Uuid]| list.contains(&run.collection);
            if v.account != run.owner || !has(&v.hosted) {
                return Err(LedgerError::Conflict);
            }
            // Conservative: Connect exposes no per-collection Driver step, so a
            // pause always waits, even for an account already mid-cutover.
            let may = v.legacy_backend
                && v.cohort
                && v.released
                && v.started
                && !v.terminal_excluded
                && !v.paused
                && !has(&v.unsettled)
                && !has(&v.cut_over);
            (Outcome::MayFence(may), vec![])
        }
        (Action::Fence, ProviderResult::Fence(r)) => {
            if r.collection != run.collection {
                return Err(LedgerError::Conflict);
            }
            // A repeated fence must observe the SAME provider run: a different
            // run means legacy was unfenced in between and may have moved.
            if prior_fence.is_some() && !same_run(&r)? {
                return Err(LedgerError::Conflict);
            }
            (Outcome::Ok, stamp_of(&r))
        }
        (
            Action::DrainStatus,
            ProviderResult::Drain {
                collection,
                state,
                run: observed,
                head,
                retained,
                in_flight,
                unresolved,
                applied_unreceipted,
            },
        ) => {
            // Only the run this Driver itself fenced, still migrating and
            // unretained. Connect's own drained rule: in_flight == 0.
            let Some(observed) = observed else {
                return Err(LedgerError::Conflict);
            };
            if collection != run.collection
                || state != State::Migrating
                || retained
                || !same_run(&observed)?
            {
                return Err(LedgerError::Conflict);
            }
            let mut provenance = stamp_of(&observed);
            provenance.extend([Cbor::Uint(unresolved), Cbor::Uint(applied_unreceipted)]);
            (
                Outcome::Drain {
                    pending: in_flight,
                    head,
                },
                provenance,
            )
        }
        (Action::ListReplicas, ProviderResult::Replicas(ids)) => {
            if prior_fence.is_none() {
                return Err(LedgerError::Conflict);
            }
            (
                Outcome::Replicas {
                    ids: ids.iter().map(Uuid::to_uuid_string).collect(),
                },
                vec![],
            )
        }
        (Action::RevokeReplicas { ids: asked }, ProviderResult::Revoked(revoked)) => {
            // Exactly the saved set: a partial or extra revocation stays UNKNOWN.
            let mut asked = asked.clone();
            asked.sort();
            let revoked: Vec<String> = revoked.iter().map(Uuid::to_uuid_string).collect();
            if prior_fence.is_none() || asked != revoked {
                return Err(LedgerError::Conflict);
            }
            (Outcome::Ok, vec![])
        }
        (
            Action::Route { .. },
            ProviderResult::Cutover {
                collection,
                account,
            },
        ) => {
            if collection != run.collection || account != run.owner || prior_fence.is_none() {
                return Err(LedgerError::Conflict);
            }
            (Outcome::Ok, vec![])
        }
        _ => return Err(LedgerError::Conflict),
    })
}

/// Whether a reported run is the one the settled fence's digest recorded.
pub(super) fn fence_matches(result: &B32, candidate: &Run) -> Result<bool> {
    Ok(super::codec::provider_outcome(
        &Action::Fence,
        &Outcome::Ok,
        vec![
            Cbor::Bytes(candidate.migration.0.to_vec()),
            Cbor::Text(candidate.started_at.clone()),
        ],
    )? == *result)
}
