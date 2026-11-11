//! Ordered migrations of the per-collection SQLite database. They never
//! destroy authoritative rows; a derived index may be dropped for rebuild.
//! Schema/codec changes belong here; replica-derived metadata has its own version.

use super::{SCHEMA, corrupt, idx_err, st, staging_schema};
use crate::index::{Batch, BatchMode, IndexStorage, SqlValue};
use mdbn_replica::store::{StoreError, StoreResult};

const VERSION: i64 = 2;

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
    if version == VERSION {
        return Ok(());
    }
    let mut stmts = Vec::new();
    for next in version + 1..=VERSION {
        match next {
            // Version zero includes both fresh databases and the unversioned
            // deployed schema. IF NOT EXISTS adopts every existing row in place.
            1 => stmts.extend(
                SCHEMA
                    .iter()
                    .chain(crate::sql_fields::SCHEMA)
                    .chain(crate::sql_bases::SCHEMA)
                    .chain(super::tail::SCHEMA)
                    .map(|s| st(s, vec![]))
                    .chain(staging_schema().iter().map(|s| st(s, vec![]))),
            ),
            // The field index orders ties by path (it ordered them by ID).
            2 => stmts.extend(
                crate::sql_fields::FIELD_SCHEMA
                    .iter()
                    .map(|s| st(s, vec![])),
            ),
            _ => unreachable!("missing SQL store migration"),
        }
    }
    stmts.push(st(&format!("PRAGMA user_version={VERSION}"), vec![]));
    // Every pending step and the version commit together, never the version
    // ahead of a failed migration.
    index
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts,
        })
        .map_err(idx_err)?;
    Ok(())
}
