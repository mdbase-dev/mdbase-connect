//! Read-only SQLite access.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::{Error, Result};

/// Open `path` read-only. The file must exist. A live WAL database is readable this
/// way. The connection never writes, so the old connector's files are left
/// byte-identical, apart from SQLite's own `-shm` bookkeeping when the WAL is in use.
pub(crate) fn open_read_only(path: &Path) -> Result<Connection> {
    if !path.is_file() {
        return Err(Error::format(path, "database file is missing"));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| sqlite(path, e))?;
    // Belt and braces: refuse writes at the connection level too.
    conn.pragma_update(None, "query_only", true)
        .map_err(|e| sqlite(path, e))?;
    Ok(conn)
}

pub(crate) fn sqlite(path: &Path, source: rusqlite::Error) -> Error {
    Error::Sqlite {
        path: path.to_path_buf(),
        source,
    }
}

pub(crate) fn user_version(conn: &Connection, path: &Path) -> Result<u32> {
    conn.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
        .map_err(|e| sqlite(path, e))
}

pub(crate) fn has_table(conn: &Connection, path: &Path, name: &str) -> Result<bool> {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| sqlite(path, e))
}
