//! Closed native metadata fingerprints of ACTUAL portable enums, not a new
//! completion language or an input decoder. Replay/source-page producers remain
//! separate integrations; unsupported inputs refuse before saving an action.
use super::{LedgerError, Result};
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
fn digest(tag: &str, values: Vec<Cbor>) -> Result<B32> {
    let b = cbor::encode(&Cbor::Array(values)).map_err(|_| LedgerError::Invalid)?;
    if b.len() > 64 * 1024 {
        return Err(LedgerError::Invalid);
    }
    Ok(h(tag, &b))
}
pub(super) fn action(a: &Action) -> Result<(u64, B32)> {
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
            if *max_rows > 128 || *max_bytes > 64 * 1024 {
                return Err(LedgerError::Invalid);
            }
            let t = match table {
                Table::Resources => 0,
                Table::Files => 1,
                Table::Records => 2,
            };
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
        } => {
            if after.is_some() {
                return Err(LedgerError::Unsupported);
            }
            (4, vec![n(*bits), opt(*bucket), key(after)?])
        }
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
    Ok((kind, digest("mdbase/v1/native-driver-action", fields)?))
}
pub(super) fn outcome(a: &Action, o: &Outcome) -> Result<B32> {
    use Action::*;
    let fields = match (a, o) {
        (EnsureBackup, Outcome::Backup { hold }) => vec![n(0), text(hold)?],
        (CreateCollection, Outcome::Created { verified: false }) => vec![n(1)],
        (ImportGen0 { .. }, Outcome::Gen0Progress { last, done: true }) => vec![n(2), key(last)?],
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
        (AppendBase { .. } | AppendCutover { .. }, Outcome::Appended { seq }) => {
            vec![n(4), n(*seq)]
        }
        (FindBase | FindCutover | FindMutation { .. }, Outcome::Found { seq }) => {
            vec![n(5), opt(*seq)]
        }
        (Rebuild { .. }, Outcome::Rebuilt { head }) => vec![n(6), n(*head)],
        (Fence, Outcome::Ok) => vec![n(7)],
        (DrainStatus, Outcome::Drain { pending, head }) => vec![n(8), n(*pending), n(*head)],
        (LogHead, Outcome::Head { seq }) => vec![n(9), n(*seq)],
        // These need their actual provenance-owned receipt/read/policy adapters.
        // In particular an un-revoke/unfence Ok must not clear owned IDs without
        // the independently preserved ORIGINAL rollback receipt.
        _ => return Err(LedgerError::Unsupported),
    };
    digest("mdbase/v1/native-driver-outcome", fields)
}
