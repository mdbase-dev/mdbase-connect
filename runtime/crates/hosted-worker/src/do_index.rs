//! [`IndexStorage`] over the Durable Object's SQLite (`ctx.storage.sql`).
//!
//! The DO host runs each batch synchronously: a [`BatchMode::Transaction`] batch
//! inside `ctx.storage.transactionSync`, so it is atomic. It is **not** confirmed
//! durable when it returns (the output gate confirms writes later), so the index
//! reports [`IndexDurability::Disposable`] and backs only `mdbn_store_file::LogCache`
//! inside `mdbn_replica::HostedCache`: only log-derived rows reach it, and a lost
//! write is rebuilt from the log.
//!
//! **Wire.** file's bounded binary index ABI (`mdbn_store_file::index_codec`,
//! file binary index ABI): typed Run/Reset
//! requests and Results/Error/ResetOk replies, little endian, INTEGER and REAL kept
//! distinct, validated before allocation. Oversized messages are refused, never
//! truncated. Reset is a host operation (drop the `st_*` tables); it starts a new,
//! untrusted cache generation that must be rebuilt from the log before serving.

use mdbn_store_file::index::{
    Batch, IndexDurability, IndexError, IndexErrorKind, IndexInfo, IndexStorage, OpenState,
    StmtResult,
};
use mdbn_store_file::index_codec::{
    CodecLimits, IndexReply, IndexRequest, decode_reply, encode_request,
};

/// Transport limits: file's hosted envelope, with room for the store's internal
/// 1,024-row pages (the 1,000-record hydration budget applies to client requests).
pub const LIMITS: CodecLimits = CodecLimits {
    max_rows: 4_096,
    ..CodecLimits::HOSTED
};

/// The host side of the import: run one encoded request, return the encoded reply.
pub trait SqlHost {
    /// Run `request`; `None` when the host refused it outright.
    fn run(&mut self, request: &[u8]) -> Option<Vec<u8>>;
}

/// The DO SQLite index.
pub struct DoIndex {
    host: Box<dyn SqlHost>,
}

impl std::fmt::Debug for DoIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DoIndex(..)")
    }
}

impl DoIndex {
    /// An index over `host`.
    pub fn new(host: Box<dyn SqlHost>) -> DoIndex {
        DoIndex { host }
    }

    fn call(
        &mut self,
        request: &IndexRequest,
        stmts: Option<usize>,
    ) -> Result<IndexReply, IndexError> {
        let bytes = encode_request(request, LIMITS)
            .map_err(|e| IndexError::new(IndexErrorKind::Full, format!("do sql: {e}")))?;
        let reply = self
            .host
            .run(&bytes)
            .ok_or_else(|| IndexError::new(IndexErrorKind::Other, "do sql: host refused"))?;
        decode_reply(&reply, LIMITS, stmts)
            .map_err(|e| IndexError::new(IndexErrorKind::Other, format!("do sql: {e}")))
    }
}

impl IndexStorage for DoIndex {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            // SqlStore creates its schema idempotently; it does not branch on this.
            opened: OpenState::Existing,
            // The DO sandbox does not expose sqlite_version(); never fabricate one.
            sqlite_version: 0,
        }
    }

    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        match self.call(&IndexRequest::Run(batch.clone()), Some(batch.stmts.len()))? {
            IndexReply::Results(r) => Ok(r),
            IndexReply::Error(e) => Err(e),
            IndexReply::ResetOk => Err(IndexError::new(IndexErrorKind::Other, "do sql: reply")),
        }
    }

    /// Drop every store table: a new cache generation, rebuilt from the log.
    fn reset(&mut self) -> Result<(), IndexError> {
        match self.call(&IndexRequest::Reset, None)? {
            IndexReply::ResetOk => Ok(()),
            IndexReply::Error(e) => Err(e),
            IndexReply::Results(_) => Err(IndexError::new(IndexErrorKind::Other, "do sql: reply")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_store_file::index::{BatchMode, SqlValue, Stmt};
    use mdbn_store_file::index_codec::{decode_request, encode_reply};

    /// A host that echoes one result per statement and checks the request shape.
    struct Echo;
    impl SqlHost for Echo {
        fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
            let reply = match decode_request(request, LIMITS).ok()? {
                IndexRequest::Run(b) => IndexReply::Results(
                    b.stmts
                        .iter()
                        .map(|s| StmtResult {
                            columns: s.params.len() as u32,
                            values: s.params.clone(),
                            changes: 0,
                            last_insert_rowid: i64::MIN,
                        })
                        .collect(),
                ),
                IndexRequest::Reset => IndexReply::ResetOk,
            };
            encode_reply(&reply, LIMITS).ok()
        }
    }

    #[test]
    fn round_trips_typed_values_through_the_binary_abi() {
        let mut ix = DoIndex::new(Box::new(Echo));
        let vals = vec![
            SqlValue::Integer(i64::MIN),
            SqlValue::Integer(i64::MAX),
            SqlValue::Real(1.0),
            SqlValue::Text("ü".into()),
            SqlValue::Blob(vec![0, 255]),
            SqlValue::Null,
        ];
        let r = ix
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts: vec![Stmt::new("SELECT ?,?,?,?,?,?", vals.clone())],
            })
            .unwrap();
        assert_eq!(r[0].values, vals, "INTEGER and REAL stay distinct");
        assert_eq!(r[0].last_insert_rowid, i64::MIN);
        ix.reset().unwrap();
        assert_eq!(ix.info().durability, IndexDurability::Disposable);
    }

    #[test]
    fn oversized_batches_are_refused_not_truncated() {
        let mut ix = DoIndex::new(Box::new(Echo));
        let big = Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new("INSERT", vec![SqlValue::Blob(vec![0; 5 << 20])])],
        };
        assert_eq!(ix.run(&big).unwrap_err().kind, IndexErrorKind::Full);
    }
}
