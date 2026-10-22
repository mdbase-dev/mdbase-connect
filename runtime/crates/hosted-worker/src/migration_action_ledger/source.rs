//! Closed native settlement of legacy source open and page results.
//!
//! Input is a fixed CBOR mirror of ONE legacy source result, built by the closed
//! host from the bounded legacy reader (`legacy-source/source.ts`): the opened
//! checkpoint, or one metadata page. Nothing here is signed. Native binds what
//! the result carries (collection, head, source session, backup hold, table and
//! cursors) to the saved run, the settled backup hold, the settled open of the
//! current read and the exact retained action, and refuses everything else. A
//! refusal never settles; the original pending stays UNKNOWN.
//!
//! | Tag | Driver action | Source result |
//! |---|---|---|
//! | 0 | `OpenSource` | `openCheckpoint` request facts + returned `session` |
//! | 1 | `ReadPage` | one `nextPage` page as `SourceRow`s, with the request cursor |
//!
//! Page bounds match Connect's paged migration sources: at most 64 rows and a
//! 48 KiB whole input. A full page may stop short; the rest follows from `next`.
use super::{LedgerError, Result};
use mdbn_migrate_portable::budget::{MAX_SOURCE_PAGE_BYTES, MAX_SOURCE_PAGE_ROWS};
use mdbn_migrate_portable::hosted_import::{Action, Outcome, SourceRow, Table};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use std::collections::BTreeSet;

/// Whole encoded input: one page mirror, header included.
pub(super) const MAX_INPUT: usize = MAX_SOURCE_PAGE_BYTES;
const MAX_TEXT: usize = 4096;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// One decoded source result. DATA only until bound to the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum SourceResult {
    Opened {
        collection: Uuid,
        migrating: bool,
        head: u64,
        session: Uuid,
        hold: Uuid,
    },
    Page {
        collection: Uuid,
        head: u64,
        session: Uuid,
        table: Table,
        after: Option<String>,
        rows: Vec<SourceRow>,
        next: Option<String>,
        digest: B32,
    },
}

fn uuid(v: &Cbor) -> Result<Uuid> {
    let Cbor::Bytes(b) = v else {
        return Err(LedgerError::Invalid);
    };
    let b: [u8; 16] = b.as_slice().try_into().map_err(|_| LedgerError::Invalid)?;
    if b == [0; 16] {
        return Err(LedgerError::Invalid);
    }
    Ok(B16(b))
}
fn count(v: &Cbor) -> Result<u64> {
    match v {
        Cbor::Uint(n) if *n <= MAX_SAFE => Ok(*n),
        _ => Err(LedgerError::Invalid),
    }
}
fn text(v: &Cbor) -> Result<String> {
    match v {
        Cbor::Text(s) if !s.is_empty() && s.len() <= MAX_TEXT => Ok(s.clone()),
        _ => Err(LedgerError::Invalid),
    }
}
fn cursor(v: &Cbor) -> Result<Option<String>> {
    match v {
        Cbor::Null => Ok(None),
        v => text(v).map(Some),
    }
}
fn table(v: &Cbor) -> Result<Table> {
    match v {
        Cbor::Text(s) if s == "resources" => Ok(Table::Resources),
        Cbor::Text(s) if s == "records" => Ok(Table::Records),
        Cbor::Text(s) if s == "files" => Ok(Table::Files),
        _ => Err(LedgerError::Invalid),
    }
}
fn row(v: &Cbor, table: Table) -> Result<SourceRow> {
    let Cbor::Array(f) = v else {
        return Err(LedgerError::Invalid);
    };
    let [id, path, Cbor::Bytes(content), size] = f.as_slice() else {
        return Err(LedgerError::Invalid);
    };
    // Resources are keyed by path; records and files by their legacy ID.
    let id = match (table, id) {
        (Table::Resources, Cbor::Null) => None,
        (Table::Records | Table::Files, id) => Some(uuid(id)?.to_uuid_string()),
        _ => return Err(LedgerError::Invalid),
    };
    Ok(SourceRow {
        id,
        path: text(path)?,
        content: B32(content
            .as_slice()
            .try_into()
            .map_err(|_| LedgerError::Invalid)?),
        size: count(size)?,
    })
}
/// The cursor a page row ends at: the source's keyset key.
fn key(table: Table, r: &SourceRow) -> &str {
    match table {
        Table::Resources => &r.path,
        Table::Records | Table::Files => r.id.as_deref().unwrap_or_default(),
    }
}
/// Keyset order inside one page and against the request cursor. Canonical
/// lowercase UUID text sorts as its bytes; resource paths use the source's
/// collation, so only uniqueness and the cursor itself are checked for them.
fn ordered(table: Table, after: Option<&str>, rows: &[SourceRow]) -> Result<()> {
    match table {
        Table::Records | Table::Files => {
            if let Some(after) = after {
                let canonical = mdbn_migrate_portable::ids::uuid(after)
                    .map_err(|_| LedgerError::Invalid)?
                    .to_uuid_string();
                if canonical != after {
                    return Err(LedgerError::Invalid);
                }
            }
            let mut last = after;
            for r in rows {
                let k = key(table, r);
                if last.is_some_and(|l| l >= k) {
                    return Err(LedgerError::Invalid);
                }
                last = Some(k);
            }
        }
        Table::Resources => {
            let mut seen = BTreeSet::new();
            if rows
                .iter()
                .any(|r| Some(r.path.as_str()) == after || !seen.insert(r.path.as_str()))
            {
                return Err(LedgerError::Invalid);
            }
        }
    }
    Ok(())
}

pub(super) fn decode(input: &[u8]) -> Result<SourceResult> {
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
        (0, [collection, state, head, session, hold]) => SourceResult::Opened {
            collection: uuid(collection)?,
            migrating: match state {
                Cbor::Text(s) if s == "active" => false,
                Cbor::Text(s) if s == "migrating" => true,
                _ => return Err(LedgerError::Invalid),
            },
            head: count(head)?,
            session: uuid(session)?,
            hold: uuid(hold)?,
        },
        (
            1,
            [
                collection,
                head,
                session,
                t,
                after,
                Cbor::Array(items),
                next,
            ],
        ) => {
            let table = table(t)?;
            if items.len() > MAX_SOURCE_PAGE_ROWS {
                return Err(LedgerError::Invalid);
            }
            let rows = items
                .iter()
                .map(|r| row(r, table))
                .collect::<Result<Vec<_>>>()?;
            let after = cursor(after)?;
            let next = cursor(next)?;
            ordered(table, after.as_deref(), &rows)?;
            // A page continues exactly at its last row, or ends the table. An
            // empty page always ends it: no page may stall the read.
            match (&next, rows.last()) {
                (None, _) => {}
                (Some(n), Some(last)) if n == key(table, last) => {}
                _ => return Err(LedgerError::Invalid),
            }
            SourceResult::Page {
                collection: uuid(collection)?,
                head: count(head)?,
                session: uuid(session)?,
                table,
                after,
                rows,
                next,
                digest: mdbn_wire::hash::h("mdbase/v1/native-source-page", input),
            }
        }
        _ => return Err(LedgerError::Invalid),
    })
}

/// The settled facts a source result is bound to.
pub(super) struct Bound<'a> {
    pub(super) collection: Uuid,
    /// The latest settled backup hold's digest.
    pub(super) backup: Option<&'a B32>,
    /// The latest settled source open's digest (the current read).
    pub(super) open: Option<&'a B32>,
}

/// Map one decoded result onto the EXACT retained action. Wrong-kind, foreign,
/// stale, replayed or out-of-order results are `Conflict`; nothing is settled.
pub(super) fn outcome(
    action: &Action,
    result: SourceResult,
    run: &Bound<'_>,
) -> Result<(Outcome, Vec<Cbor>)> {
    Ok(match (action, result) {
        (
            Action::OpenSource { expect_head, .. },
            SourceResult::Opened {
                collection,
                migrating,
                head,
                session,
                hold,
            },
        ) => {
            // The read must stay under the hold this run settled, and at the
            // fenced head (`migrating`) whenever the Driver names one.
            let state_ok = match expect_head {
                Some(h) => migrating && head == *h,
                None => !migrating,
            };
            if collection != run.collection || !state_ok || !backup_matches(run.backup, hold)? {
                return Err(LedgerError::Conflict);
            }
            (
                Outcome::Opened { head },
                vec![Cbor::Bytes(session.0.to_vec())],
            )
        }
        (
            Action::ReadPage {
                generation,
                table: asked,
                cursor: asked_after,
                ..
            },
            SourceResult::Page {
                collection,
                head,
                session,
                table,
                after,
                rows,
                next,
                digest,
            },
        ) => {
            // Only the current read's own session, at its opened head, for the
            // exact table and cursor the Driver asked: a replayed, skipped or
            // reordered page names another cursor; a closed or foreign source
            // names another session or head.
            let opened = super::codec::source_outcome(
                &Action::OpenSource {
                    generation: *generation,
                    expect_head: None,
                },
                &Outcome::Opened { head },
                vec![Cbor::Bytes(session.0.to_vec())],
            )?;
            if collection != run.collection
                || table != *asked
                || after != *asked_after
                || run.open != Some(&opened)
            {
                return Err(LedgerError::Conflict);
            }
            (
                Outcome::Page { rows, next },
                vec![
                    Cbor::Bytes(session.0.to_vec()),
                    Cbor::Bytes(digest.0.to_vec()),
                ],
            )
        }
        _ => return Err(LedgerError::Conflict),
    })
}

/// Whether the opened hold is the one the latest settled backup recorded.
fn backup_matches(settled: Option<&B32>, hold: Uuid) -> Result<bool> {
    let Some(settled) = settled else {
        return Ok(false);
    };
    Ok(super::codec::provider_outcome(
        &Action::EnsureBackup,
        &Outcome::Backup {
            hold: hold.to_uuid_string(),
        },
        vec![],
    )? == *settled)
}
