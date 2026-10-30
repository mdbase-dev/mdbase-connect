//! Ordered, non-destructive migrations of the per-collection SQLite database.
//! Schema/codec changes belong here; replica-derived metadata has its own version.

use super::{SCHEMA, corrupt, idx_err, st, staging_schema};
use crate::index::{Batch, BatchMode, IndexStorage, SqlValue};
use mdbn_replica::store::{StoreError, StoreResult};

const VERSION: i64 = 1;

pub(super) fn migrate(index: &mut impl IndexStorage) -> StoreResult<()> {
    let result = index
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![st("PRAGMA user_version", vec![])],
        })
        .map_err(idx_err)?;
    let version = match result.as_slice() {
        [row] if row.columns == 1 => match row.values.as_slice() {
            [SqlValue::Integer(v)] if *v >= 0 => *v,
            _ => return Err(corrupt("schema version")),
        },
        _ => return Err(corrupt("schema version result")),
    };
    if version > VERSION {
        // Not corruption: in particular, callers must NOT reset this database.
        return Err(StoreError::Io(format!(
            "SQL store schema version {version} is newer than supported version {VERSION}; upgrade the runtime"
        )));
    }
    for next in version + 1..=VERSION {
        let mut stmts = match next {
            // Version zero includes both fresh databases and the unversioned
            // deployed schema. IF NOT EXISTS adopts every existing row in place.
            1 => SCHEMA
                .iter()
                .chain(crate::sql_fields::SCHEMA)
                .chain(crate::sql_bases::SCHEMA)
                .chain(super::tail::SCHEMA)
                .map(|s| st(s, vec![]))
                .chain(staging_schema().iter().map(|s| st(s, vec![])))
                .collect::<Vec<_>>(),
            _ => unreachable!("missing SQL store migration"),
        };
        stmts.push(st(&format!("PRAGMA user_version={next}"), vec![]));
        // The version advances with the DDL, never ahead of a failed migration.
        index
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts,
            })
            .map_err(idx_err)?;
    }
    Ok(())
}
