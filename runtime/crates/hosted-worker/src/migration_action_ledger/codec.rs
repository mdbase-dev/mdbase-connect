//! Closed native metadata fingerprints of ACTUAL portable enums, not a new
//! completion language or an input decoder. Replay producers remain a separate
//! integration; unsupported inputs refuse before saving an action.
use super::{LedgerError, Result};
use mdbn_migrate_portable::budget::{MAX_SOURCE_PAGE_BYTES, MAX_SOURCE_PAGE_ROWS};
use mdbn_migrate_portable::hosted_import::{Action, Generation, Key, Outcome, Table};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::B32;
use mdbn_wire::hash::h;
fn n(v: u64) -> Cbor {
    Cbor::Uint(v)
}
fn text(v: &str) -> Result<Cbor> {
    if v.len() > 4096 {
        Err(LedgerError::Invalid)
    } else {
        Ok(Cbor::Text(v.into()))
    }
}
fn opt(v: Option<u64>) -> Cbor {
    v.map_or(Cbor::Null, n)
}
fn cursor(v: &Option<String>) -> Result<Cbor> {
    v.as_deref()
        .map(text)
        .transpose()
        .map(|v| v.unwrap_or(Cbor::Null))
}
fn key(v: &Option<Key>) -> Result<Cbor> {
    match v {
        None => Ok(Cbor::Null),
        Some(k) if k.id.len() <= 4096 => Ok(Cbor::Bytes(k.to_bytes())),
        _ => Err(LedgerError::Invalid),
    }
}
fn generation(g: Generation) -> Cbor {
    n(match g {
        Generation::S0 => 0,
        Generation::Final => 1,
    })
}
fn ids(v: &[String]) -> Result<Cbor> {
    if v.len() > 1000
        || v.iter()
            .try_fold(0usize, |n, s| {
                n.checked_add(s.len()).and_then(|n| n.checked_add(3))
            })
            .is_none_or(|n| n > 60 * 1024)
    {
        return Err(LedgerError::Invalid);
    }
    Ok(Cbor::Array(
        v.iter().map(|s| text(s)).collect::<Result<_>>()?,
    ))
}
pub(super) fn digest(tag: &str, values: Vec<Cbor>) -> Result<B32> {
    let b = cbor::encode(&Cbor::Array(values)).map_err(|_| LedgerError::Invalid)?;
    if b.len() > 64 * 1024 {
        return Err(LedgerError::Invalid);
    }
    Ok(h(tag, &b))
}
pub(super) fn action(a: &Action) -> Result<(u64, B32)> {
    let fields = action_fields(a)?;
    let kind = match fields.first() {
        Some(Cbor::Uint(kind)) => *kind,
        _ => return Err(LedgerError::Invalid),
    };
    Ok((kind, digest("mdbase/v1/native-driver-action", fields)?))
}
/// `[kind, ...params]`: exactly the fields the action fingerprint hashes, so the
/// host executes the very parameters the ledger saved (no second encoding).
pub(super) fn action_fields(a: &Action) -> Result<Vec<Cbor>> {
    use Action::*;
    let (kind, mut fields) = match a {
        EnsureBackup => (0, vec![]),
        CreateCollection => (1, vec![]),
        OpenSource {
            generation: g,
            expect_head,
        } => (2, vec![generation(*g), opt(*expect_head)]),
        ReadPage {
            generation: g,
            table,
            cursor: c,
            max_rows,
            max_bytes,
        } => {
            // The source page budget, never the portable hydrate defaults.
            if *max_rows > MAX_SOURCE_PAGE_ROWS || *max_bytes > MAX_SOURCE_PAGE_BYTES {
                return Err(LedgerError::Invalid);
            }
            let t = table_tag(*table);
            (
                3,
                vec![
                    generation(*g),
                    n(t),
                    cursor(c)?,
                    n(*max_rows as u64),
                    n(*max_bytes as u64),
                ],
            )
        }
        ImportGen0 {
            bits,
            bucket,
            after,
        } => (4, vec![n(*bits), opt(*bucket), key(after)?]),
        FinishGen0 => (5, vec![]),
        AppendBase {
            manifest,
            state_digest,
        } => (
            6,
            vec![
                Cbor::Bytes(manifest.0.to_vec()),
                Cbor::Bytes(state_digest.0.to_vec()),
            ],
        ),
        FindBase => (7, vec![]),
        Rebuild { at_least } => (8, vec![n(*at_least)]),
        ReadNew { cursor: c } => (9, vec![cursor(c)?]),
        MayFence => (10, vec![]),
        Fence => (11, vec![]),
        DrainStatus => (12, vec![]),
        ListReplicas => (13, vec![]),
        RevokeReplicas { ids: v } => (14, vec![ids(v)?]),
        AppendCutover { s_final } => (15, vec![n(*s_final)]),
        FindCutover => (16, vec![]),
        FindMutation { mutation } => (17, vec![Cbor::Bytes(mutation.0.to_vec())]),
        LogHead => (18, vec![]),
        Route {
            s_final,
            cutover_seq,
            barrier_f,
            final_digest,
        } => (
            19,
            vec![
                n(*s_final),
                n(*cutover_seq),
                n(*barrier_f),
                Cbor::Bytes(final_digest.0.to_vec()),
            ],
        ),
        Unrevoke { ids: v } => (20, vec![ids(v)?]),
        Unfence => (21, vec![]),
        // No replay metadata or host authority is synthesized by this ledger.
        Replay(_) | Wait(_) | Continue | Done(_) => return Err(LedgerError::Unsupported),
    };
    fields.insert(0, n(kind));
    Ok(fields)
}
pub(super) fn outcome(a: &Action, o: &Outcome) -> Result<B32> {
    use Action::*;
    let fields = match (a, o) {
        (CreateCollection, Outcome::Created { verified: false }) => vec![n(1)],
        // Only settle_created's actual native target verifier reaches this case.
        (CreateCollection, Outcome::Created { verified: true }) => vec![n(10)],
        // Connect/provider results go only through `provider_outcome`, source
        // open/page results only through `source_outcome`, generation-0
        // windows and finish only through `gen0_outcome`, log results only
        // through `log_outcome` (replay's `FindMutation` has no producer yet). Rollback
        // needs its own adapter: an un-revoke/unfence Ok must not clear owned IDs
        // without the independently preserved ORIGINAL rollback receipt.
        _ => return Err(LedgerError::Unsupported),
    };
    digest("mdbase/v1/native-driver-outcome", fields)
}

/// Settlement digest of a Connect/provider result, with the provenance the
/// adapter bound (provider run, drain counters). Only `provider` calls this.
pub(super) fn provider_outcome(a: &Action, o: &Outcome, provenance: Vec<Cbor>) -> Result<B32> {
    use Action::*;
    let mut fields = match (a, o) {
        (EnsureBackup, Outcome::Backup { hold }) => vec![n(0), text(hold)?],
        (MayFence, Outcome::MayFence(may)) => vec![n(11), Cbor::Bool(*may)],
        (Fence, Outcome::Ok) => vec![n(7)],
        (DrainStatus, Outcome::Drain { pending, head }) => vec![n(8), n(*pending), n(*head)],
        (ListReplicas, Outcome::Replicas { ids: v }) => vec![n(12), ids(v)?],
        (RevokeReplicas { .. }, Outcome::Ok) => vec![n(13)],
        (Route { .. }, Outcome::Ok) => vec![n(14)],
        _ => return Err(LedgerError::Unsupported),
    };
    fields.extend(provenance);
    digest("mdbase/v1/native-provider-outcome", fields)
}

/// Settlement digest of a legacy source open or page result, with the source
/// session the adapter bound. Only `source` calls this.
pub(super) fn source_outcome(a: &Action, o: &Outcome, provenance: Vec<Cbor>) -> Result<B32> {
    use Action::*;
    let mut fields = match (a, o) {
        (OpenSource { generation: g, .. }, Outcome::Opened { head }) => {
            vec![n(15), generation(*g), n(*head)]
        }
        (
            ReadPage {
                generation: g,
                table,
                cursor: c,
                ..
            },
            Outcome::Page { rows, next },
        ) => vec![
            n(16),
            generation(*g),
            n(table_tag(*table)),
            cursor(c)?,
            n(rows.len() as u64),
            cursor(next)?,
        ],
        _ => return Err(LedgerError::Unsupported),
    };
    fields.extend(provenance);
    digest("mdbase/v1/native-source-outcome", fields)
}
/// Settlement digest of a generation-0 window or finish whose uploads the host
/// showed present, with the window provenance. Only `gen0` calls this.
pub(super) fn gen0_outcome(a: &Action, o: &Outcome, provenance: B32) -> Result<B32> {
    use Action::*;
    let mut fields = match (a, o) {
        (ImportGen0 { .. }, Outcome::Gen0Progress { last, done }) => {
            vec![n(2), key(last)?, Cbor::Bool(*done)]
        }
        (
            FinishGen0,
            Outcome::Gen0Built {
                manifest,
                state_digest,
            },
        ) => vec![
            n(3),
            Cbor::Bytes(manifest.0.to_vec()),
            Cbor::Bytes(state_digest.0.to_vec()),
        ],
        _ => return Err(LedgerError::Unsupported),
    };
    fields.push(Cbor::Bytes(provenance.0.to_vec()));
    digest("mdbase/v1/native-gen0-outcome", fields)
}
/// Settlement digest of a log result read from the Engine, with the evidence
/// the adapter bound (item hash, head chain, page digest). Only `log` calls this.
pub(super) fn log_outcome(a: &Action, o: &Outcome, provenance: Vec<Cbor>) -> Result<B32> {
    use Action::*;
    let mut fields = match (a, o) {
        (AppendBase { .. } | AppendCutover { .. }, Outcome::Appended { seq }) => {
            vec![n(4), n(*seq)]
        }
        (AppendBase { .. }, Outcome::Unknown) => vec![n(17)],
        (AppendBase { .. }, Outcome::Stale) => vec![n(18)],
        (FindBase | FindCutover, Outcome::Found { seq }) => vec![n(5), opt(*seq)],
        (Rebuild { .. }, Outcome::Rebuilt { head }) => vec![n(6), n(*head)],
        (ReadNew { cursor: c }, Outcome::NewPage { rows, next }) => {
            vec![n(19), cursor(c)?, n(rows.len() as u64), cursor(next)?]
        }
        (LogHead, Outcome::Head { seq }) => vec![n(9), n(*seq)],
        _ => return Err(LedgerError::Unsupported),
    };
    fields.extend(provenance);
    digest("mdbase/v1/native-log-outcome", fields)
}
fn table_tag(t: Table) -> u64 {
    match t {
        Table::Resources => 0,
        Table::Files => 1,
        Table::Records => 2,
    }
}
