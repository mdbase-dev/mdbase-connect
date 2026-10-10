//! Bounded, lossless binary transport for [`crate::index::IndexStorage`].
//!
//! Version 1 starts with `MDBIDX\0\x01`, followed by an operation byte. Integers,
//! counts and lengths are little endian; text/blob lengths and counts are u32.
//! Request 0: mode (0 transaction, 1 autocommit), statement count, then each
//! SQL string, parameter count and tagged values. Request 1: reset (no payload).
//! Reply 2: result count, then columns:u32, changes:u64, rowid:i64, value count,
//! and values for each result. Reply 3: error kind:u8, statement flag:u8 plus
//! optional index:u32, and detail string. Reply 4: reset success (no payload).
//! Values: null=0, integer=1+i64, real=2+IEEE f64, text=3+string, blob=4+bytes.
//!
//! Decode directly into domain objects, never an intermediate CBOR/JSON tree.
//! Every count is checked against both configured budgets and remaining bytes
//! before allocation. No silent truncation, lossy integer coercion or REAL/INT
//! inference. Hosts must preserve tags and reject unsupported SQL numeric ranges.
//! These are transport budgets, NOT the separate effect/source/hydration budgets
//! of the hosted replica. Pointer ownership and generation/error fencing belong
//! to the host adapter; no borrowed memory may survive an import or memory grow.

use crate::index::{Batch, BatchMode, IndexError, IndexErrorKind, SqlValue, Stmt, StmtResult};
use std::fmt;

const MAGIC: &[u8; 8] = b"MDBIDX\0\x01";

/// Independent transport budgets. The host must enforce the same limits.
#[derive(Debug, Clone, Copy)]
pub struct CodecLimits {
    /// Maximum encoded bytes in one request or reply.
    pub max_bytes: usize,
    /// Maximum statements or statement results per message.
    pub max_statements: usize,
    /// Maximum cumulative tagged values per message.
    pub max_values: usize,
    /// Maximum cumulative result rows per message (not an effect count).
    pub max_rows: usize,
    /// Maximum columns in one statement result.
    pub max_columns: u32,
    /// Maximum UTF-8 bytes in one SQL statement.
    pub max_sql_bytes: usize,
    /// Maximum positional parameters in one statement.
    pub max_parameters: usize,
}
impl CodecLimits {
    /// DO transport envelope; decoded source and hydration budgets remain separate.
    pub const HOSTED: Self = Self {
        max_bytes: 4 * 1024 * 1024,
        max_statements: 16_384,
        max_values: 131_072,
        max_rows: 1_000,
        max_columns: 100,
        max_sql_bytes: 100 * 1024,
        max_parameters: 100,
    };
}

/// A synchronous index operation; reset is a rebuild operation, not serving.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexRequest {
    /// Execute statements in order with the batch's transaction policy.
    Run(Batch),
    /// Drop the owned index and start a new, untrusted cache generation.
    Reset,
}
/// A complete reply; an error never certifies rollback or prior durability.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexReply {
    /// Exactly one result per requested statement, in order.
    Results(Vec<StmtResult>),
    /// A typed backend error; the adapter must fence uncertain generations.
    Error(IndexError),
    /// Reset completed, but authenticated replay/admission is still required.
    ResetOk,
}
/// Encoding/decoding failed without returning a partial result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecError {
    /// A configured allocation, count or byte budget was exceeded.
    Limit(&'static str),
    /// Invalid framing, tags, types, cardinality, UTF-8 or numeric values.
    Invalid(&'static str),
}
impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Limit(s) => write!(f, "index ABI limit: {s}"),
            Self::Invalid(s) => write!(f, "invalid index ABI: {s}"),
        }
    }
}
impl std::error::Error for CodecError {}
type Result<T> = std::result::Result<T, CodecError>;

fn bounded(n: usize, max: usize, name: &'static str) -> Result<()> {
    if n > max {
        Err(CodecError::Limit(name))
    } else {
        Ok(())
    }
}
fn add(total: &mut usize, n: usize, max: usize, name: &'static str) -> Result<()> {
    *total = total.checked_add(n).ok_or(CodecError::Limit(name))?;
    bounded(*total, max, name)
}
fn result_shape(columns: u32, values: usize, limits: CodecLimits) -> Result<usize> {
    bounded(columns as usize, limits.max_columns as usize, "columns")?;
    if columns == 0 {
        if values != 0 {
            return Err(CodecError::Invalid("values without columns"));
        }
        Ok(0)
    } else if !values.is_multiple_of(columns as usize) {
        Err(CodecError::Invalid("partial row"))
    } else {
        Ok(values / columns as usize)
    }
}

struct Writer {
    bytes: Vec<u8>,
    limits: CodecLimits,
    values: usize,
}
impl Writer {
    fn new(limits: CodecLimits, op: u8) -> Result<Self> {
        let mut w = Self {
            bytes: Vec::new(),
            limits,
            values: 0,
        };
        w.put(MAGIC)?;
        w.byte(op)?;
        Ok(w)
    }
    fn put(&mut self, b: &[u8]) -> Result<()> {
        let n = self
            .bytes
            .len()
            .checked_add(b.len())
            .ok_or(CodecError::Limit("bytes"))?;
        bounded(n, self.limits.max_bytes, "bytes")?;
        self.bytes
            .try_reserve(b.len())
            .map_err(|_| CodecError::Limit("allocation"))?;
        self.bytes.extend_from_slice(b);
        Ok(())
    }
    fn byte(&mut self, b: u8) -> Result<()> {
        self.put(&[b])
    }
    fn u32(&mut self, n: u32) -> Result<()> {
        self.put(&n.to_le_bytes())
    }
    fn count(&mut self, n: usize, max: usize, name: &'static str) -> Result<()> {
        bounded(n, max, name)?;
        self.u32(u32::try_from(n).map_err(|_| CodecError::Limit(name))?)
    }
    fn data(&mut self, b: &[u8], max: usize, name: &'static str) -> Result<()> {
        self.count(b.len(), max, name)?;
        self.put(b)
    }
    fn value(&mut self, v: &SqlValue) -> Result<()> {
        add(&mut self.values, 1, self.limits.max_values, "values")?;
        match v {
            SqlValue::Null => self.byte(0),
            SqlValue::Integer(n) => {
                self.byte(1)?;
                self.put(&n.to_le_bytes())
            }
            SqlValue::Real(n) => {
                if !n.is_finite() {
                    return Err(CodecError::Invalid("nonfinite real"));
                }
                self.byte(2)?;
                self.put(&n.to_bits().to_le_bytes())
            }
            SqlValue::Text(s) => {
                self.byte(3)?;
                self.data(s.as_bytes(), self.limits.max_bytes, "text")
            }
            SqlValue::Blob(b) => {
                self.byte(4)?;
                self.data(b, self.limits.max_bytes, "blob")
            }
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
    limits: CodecLimits,
    values: usize,
}
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], limits: CodecLimits) -> Result<(Self, u8)> {
        bounded(bytes.len(), limits.max_bytes, "bytes")?;
        let mut r = Self {
            bytes,
            pos: 0,
            limits,
            values: 0,
        };
        if r.take(8)? != MAGIC {
            return Err(CodecError::Invalid("magic/version"));
        }
        let op = r.byte()?;
        Ok((r, op))
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(CodecError::Invalid("length overflow"))?;
        let b = self
            .bytes
            .get(self.pos..end)
            .ok_or(CodecError::Invalid("truncated"))?;
        self.pos = end;
        Ok(b)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        let mut b = [0; 4];
        b.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(b))
    }
    fn u64(&mut self) -> Result<u64> {
        let mut b = [0; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(b))
    }
    fn count(&mut self, max: usize, min_bytes: usize, name: &'static str) -> Result<usize> {
        let n = usize::try_from(self.u32()?).map_err(|_| CodecError::Limit(name))?;
        bounded(n, max, name)?;
        if n > (self.bytes.len() - self.pos) / min_bytes {
            return Err(CodecError::Invalid("count exceeds remaining bytes"));
        }
        Ok(n)
    }
    fn data(&mut self, max: usize, name: &'static str) -> Result<&'a [u8]> {
        let n = self.count(max, 1, name)?;
        self.take(n)
    }
    fn text(&mut self, max: usize, name: &'static str) -> Result<String> {
        let b = self.data(max, name)?;
        Ok(std::str::from_utf8(b)
            .map_err(|_| CodecError::Invalid("UTF-8"))?
            .to_owned())
    }
    fn value(&mut self) -> Result<SqlValue> {
        add(&mut self.values, 1, self.limits.max_values, "values")?;
        match self.byte()? {
            0 => Ok(SqlValue::Null),
            1 => Ok(SqlValue::Integer(self.u64()? as i64)),
            2 => {
                let f = f64::from_bits(self.u64()?);
                if !f.is_finite() {
                    return Err(CodecError::Invalid("nonfinite real"));
                }
                Ok(SqlValue::Real(f))
            }
            3 => Ok(SqlValue::Text(self.text(self.limits.max_bytes, "text")?)),
            4 => Ok(SqlValue::Blob(
                self.data(self.limits.max_bytes, "blob")?.to_vec(),
            )),
            _ => Err(CodecError::Invalid("value tag")),
        }
    }
    fn done(self) -> Result<()> {
        if self.pos == self.bytes.len() {
            Ok(())
        } else {
            Err(CodecError::Invalid("trailing bytes"))
        }
    }
}

/// Encode a complete bounded request, preserving each SQLite value type.
pub fn encode_request(request: &IndexRequest, limits: CodecLimits) -> Result<Vec<u8>> {
    let mut w = Writer::new(
        limits,
        if matches!(request, IndexRequest::Reset) {
            1
        } else {
            0
        },
    )?;
    if let IndexRequest::Run(batch) = request {
        w.byte(match batch.mode {
            BatchMode::Transaction => 0,
            BatchMode::Autocommit => 1,
        })?;
        w.count(batch.stmts.len(), limits.max_statements, "statements")?;
        for st in &batch.stmts {
            w.data(st.sql.as_bytes(), limits.max_sql_bytes, "SQL bytes")?;
            w.count(st.params.len(), limits.max_parameters, "parameters")?;
            for v in &st.params {
                w.value(v)?;
            }
        }
    }
    Ok(w.bytes)
}
/// Validate and decode a request before executing any of its statements.
pub fn decode_request(bytes: &[u8], limits: CodecLimits) -> Result<IndexRequest> {
    let (mut r, op) = Reader::new(bytes, limits)?;
    let request = match op {
        0 => {
            let mode = match r.byte()? {
                0 => BatchMode::Transaction,
                1 => BatchMode::Autocommit,
                _ => return Err(CodecError::Invalid("batch mode")),
            };
            let n = r.count(limits.max_statements, 8, "statements")?;
            let mut stmts = Vec::with_capacity(n);
            for _ in 0..n {
                let sql = r.text(limits.max_sql_bytes, "SQL bytes")?;
                let n = r.count(limits.max_parameters, 1, "parameters")?;
                bounded(
                    r.values.checked_add(n).ok_or(CodecError::Limit("values"))?,
                    limits.max_values,
                    "values",
                )?;
                let mut params = Vec::with_capacity(n);
                for _ in 0..n {
                    params.push(r.value()?);
                }
                stmts.push(Stmt { sql, params });
            }
            IndexRequest::Run(Batch { mode, stmts })
        }
        1 => IndexRequest::Reset,
        _ => return Err(CodecError::Invalid("request operation")),
    };
    r.done()?;
    Ok(request)
}

fn error_tag(kind: IndexErrorKind) -> u8 {
    match kind {
        IndexErrorKind::Sql => 0,
        IndexErrorKind::Corrupt => 1,
        IndexErrorKind::Full => 2,
        IndexErrorKind::Busy => 3,
        IndexErrorKind::Other => 4,
    }
}
fn error_kind(tag: u8) -> Result<IndexErrorKind> {
    match tag {
        0 => Ok(IndexErrorKind::Sql),
        1 => Ok(IndexErrorKind::Corrupt),
        2 => Ok(IndexErrorKind::Full),
        3 => Ok(IndexErrorKind::Busy),
        4 => Ok(IndexErrorKind::Other),
        _ => Err(CodecError::Invalid("error kind")),
    }
}

/// Encode a complete bounded reply; never truncate or coerce rows or values.
pub fn encode_reply(reply: &IndexReply, limits: CodecLimits) -> Result<Vec<u8>> {
    let op = match reply {
        IndexReply::Results(_) => 2,
        IndexReply::Error(_) => 3,
        IndexReply::ResetOk => 4,
    };
    let mut w = Writer::new(limits, op)?;
    match reply {
        IndexReply::Results(results) => {
            w.count(results.len(), limits.max_statements, "results")?;
            let mut rows = 0;
            for result in results {
                add(
                    &mut rows,
                    result_shape(result.columns, result.values.len(), limits)?,
                    limits.max_rows,
                    "rows",
                )?;
                w.u32(result.columns)?;
                w.put(&result.changes.to_le_bytes())?;
                w.put(&result.last_insert_rowid.to_le_bytes())?;
                w.count(result.values.len(), limits.max_values, "values")?;
                for value in &result.values {
                    w.value(value)?;
                }
            }
        }
        IndexReply::Error(error) => {
            w.byte(error_tag(error.kind))?;
            w.byte(u8::from(error.stmt.is_some()))?;
            if let Some(stmt) = error.stmt {
                if stmt as usize >= limits.max_statements {
                    return Err(CodecError::Limit("error statement"));
                }
                w.u32(stmt)?;
            }
            w.data(error.detail.as_bytes(), limits.max_bytes, "error detail")?;
        }
        IndexReply::ResetOk => {}
    }
    Ok(w.bytes)
}

/// `expected_results=Some(n)` for a Run request, `None` for Reset. Validate the
/// complete envelope before returning any results to the caller.
pub fn decode_reply(
    bytes: &[u8],
    limits: CodecLimits,
    expected_results: Option<usize>,
) -> Result<IndexReply> {
    if let Some(n) = expected_results {
        bounded(n, limits.max_statements, "expected results")?;
    }
    let (mut r, op) = Reader::new(bytes, limits)?;
    let reply = match op {
        2 => {
            let n = r.count(limits.max_statements, 24, "results")?;
            if expected_results != Some(n) {
                return Err(CodecError::Invalid("result cardinality"));
            }
            let mut results = Vec::with_capacity(n);
            let mut rows = 0;
            for _ in 0..n {
                let columns = r.u32()?;
                let changes = r.u64()?;
                let last_insert_rowid = r.u64()? as i64;
                let n = r.count(limits.max_values, 1, "values")?;
                bounded(
                    r.values.checked_add(n).ok_or(CodecError::Limit("values"))?,
                    limits.max_values,
                    "values",
                )?;
                add(
                    &mut rows,
                    result_shape(columns, n, limits)?,
                    limits.max_rows,
                    "rows",
                )?;
                let mut values = Vec::with_capacity(n);
                for _ in 0..n {
                    values.push(r.value()?);
                }
                results.push(StmtResult {
                    columns,
                    changes,
                    last_insert_rowid,
                    values,
                });
            }
            IndexReply::Results(results)
        }
        3 => {
            let kind = error_kind(r.byte()?)?;
            let stmt = match r.byte()? {
                0 => None,
                1 => {
                    let stmt = r.u32()?;
                    if expected_results.is_none_or(|n| stmt as usize >= n) {
                        return Err(CodecError::Invalid("error statement"));
                    }
                    Some(stmt)
                }
                _ => return Err(CodecError::Invalid("error statement flag")),
            };
            let detail = r.text(limits.max_bytes, "error detail")?;
            IndexReply::Error(IndexError { kind, detail, stmt })
        }
        4 if expected_results.is_none() => IndexReply::ResetOk,
        _ => return Err(CodecError::Invalid("reply operation")),
    };
    r.done()?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    const L: CodecLimits = CodecLimits::HOSTED;
    fn request(values: Vec<SqlValue>) -> IndexRequest {
        IndexRequest::Run(Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new("SELECT ?", values)],
        })
    }
    #[test]
    fn all_values_roundtrip_without_integer_float_or_blob_coercion() {
        let req = request(vec![
            SqlValue::Null,
            SqlValue::Integer(i64::MIN),
            SqlValue::Integer(i64::MAX),
            SqlValue::Integer(9_007_199_254_740_993),
            SqlValue::Real(2.0),
            SqlValue::Real(-0.0),
            SqlValue::Text("日\0é".into()),
            SqlValue::Blob(vec![0, 255, 128]),
        ]);
        let bytes = encode_request(&req, L).unwrap();
        assert_eq!(decode_request(&bytes, L).unwrap(), req);
        let IndexRequest::Run(batch) = decode_request(&bytes, L).unwrap() else {
            unreachable!()
        };
        assert!(matches!(batch.stmts[0].params[4], SqlValue::Real(2.0)));
        let SqlValue::Real(zero) = batch.stmts[0].params[5] else {
            unreachable!()
        };
        assert_eq!(zero.to_bits(), (-0.0_f64).to_bits());
    }
    #[test]
    fn reply_preserves_shapes_counts_errors_and_request_context() {
        let reply = IndexReply::Results(vec![StmtResult {
            columns: 2,
            values: vec![SqlValue::Integer(-1), SqlValue::Blob(vec![8])],
            changes: u64::MAX,
            last_insert_rowid: i64::MIN,
        }]);
        let bytes = encode_reply(&reply, L).unwrap();
        assert_eq!(decode_reply(&bytes, L, Some(1)).unwrap(), reply);
        assert!(decode_reply(&bytes, L, Some(2)).is_err());
        assert!(decode_reply(&bytes, L, None).is_err());
        for kind in [
            IndexErrorKind::Sql,
            IndexErrorKind::Corrupt,
            IndexErrorKind::Full,
            IndexErrorKind::Busy,
            IndexErrorKind::Other,
        ] {
            let reply = IndexReply::Error(IndexError {
                kind,
                stmt: Some(0),
                detail: "failed".into(),
            });
            assert_eq!(
                decode_reply(&encode_reply(&reply, L).unwrap(), L, Some(1)).unwrap(),
                reply
            );
            assert!(decode_reply(&encode_reply(&reply, L).unwrap(), L, Some(0)).is_err());
        }
        assert_eq!(
            decode_request(&encode_request(&IndexRequest::Reset, L).unwrap(), L).unwrap(),
            IndexRequest::Reset
        );
        let bytes = encode_reply(&IndexReply::ResetOk, L).unwrap();
        assert_eq!(decode_reply(&bytes, L, None).unwrap(), IndexReply::ResetOk);
        assert!(decode_reply(&bytes, L, Some(0)).is_err());
    }
    #[test]
    fn every_truncation_and_trailing_bytes_are_rejected() {
        let req = encode_request(&request(vec![SqlValue::Blob(vec![1, 2, 3])]), L).unwrap();
        for end in 0..req.len() {
            assert!(decode_request(&req[..end], L).is_err(), "{end}");
        }
        let mut req = req;
        req.push(0);
        assert!(decode_request(&req, L).is_err());
        let reply = encode_reply(&IndexReply::Results(vec![StmtResult::default()]), L).unwrap();
        for end in 0..reply.len() {
            assert!(decode_reply(&reply[..end], L, Some(1)).is_err(), "{end}");
        }
    }
    #[test]
    fn budgets_and_malicious_counts_reject_before_allocation() {
        let mut limits = L;
        limits.max_bytes = 9;
        assert!(encode_request(&request(vec![]), limits).is_err());
        let mut limits = L;
        limits.max_parameters = 0;
        assert!(encode_request(&request(vec![SqlValue::Null]), limits).is_err());
        let mut limits = L;
        limits.max_values = 0;
        let bytes = encode_request(&request(vec![SqlValue::Null]), L).unwrap();
        assert!(decode_request(&bytes, limits).is_err());
        let mut bytes = MAGIC.to_vec();
        bytes.extend([0, 0]);
        bytes.extend(u32::MAX.to_le_bytes());
        assert!(decode_request(&bytes, L).is_err());
        let partial = IndexReply::Results(vec![StmtResult {
            columns: 2,
            values: vec![SqlValue::Null],
            ..StmtResult::default()
        }]);
        assert!(encode_reply(&partial, L).is_err());
        let no_columns = IndexReply::Results(vec![StmtResult {
            columns: 0,
            values: vec![SqlValue::Null],
            ..StmtResult::default()
        }]);
        assert!(encode_reply(&no_columns, L).is_err());
        let mut limits = L;
        limits.max_rows = 0;
        let one_row = IndexReply::Results(vec![StmtResult {
            columns: 1,
            values: vec![SqlValue::Null],
            ..StmtResult::default()
        }]);
        assert!(encode_reply(&one_row, limits).is_err());
    }
    #[test]
    fn nonfinite_unknown_tags_and_invalid_text_are_rejected() {
        for f in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            assert!(encode_request(&request(vec![SqlValue::Real(f)]), L).is_err());
        }
        let mut bytes = encode_request(&request(vec![SqlValue::Null]), L).unwrap();
        *bytes.last_mut().unwrap() = 255;
        assert!(decode_request(&bytes, L).is_err());
        let mut bytes = encode_request(&request(vec![SqlValue::Text("x".into())]), L).unwrap();
        *bytes.last_mut().unwrap() = 255;
        assert!(decode_request(&bytes, L).is_err());
    }
    #[test]
    fn exact_byte_and_cumulative_budgets_apply_on_both_sides() {
        let request = IndexRequest::Run(Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new("SELECT ?", vec![SqlValue::Null]); 2],
        });
        let bytes = encode_request(&request, L).unwrap();
        let exact = CodecLimits {
            max_bytes: bytes.len(),
            ..L
        };
        assert_eq!(encode_request(&request, exact).unwrap(), bytes);
        assert_eq!(decode_request(&bytes, exact).unwrap(), request);
        let short = CodecLimits {
            max_bytes: bytes.len() - 1,
            ..L
        };
        assert!(encode_request(&request, short).is_err());
        assert!(decode_request(&bytes, short).is_err());
        for limits in [
            CodecLimits { max_values: 1, ..L },
            CodecLimits {
                max_sql_bytes: 1,
                ..L
            },
        ] {
            assert!(encode_request(&request, limits).is_err());
            assert!(decode_request(&bytes, limits).is_err());
        }
        let reply = IndexReply::Results(vec![
            StmtResult {
                columns: 1,
                values: vec![SqlValue::Real(2.0)],
                ..StmtResult::default()
            };
            2
        ]);
        let bytes = encode_reply(&reply, L).unwrap();
        for limits in [
            CodecLimits { max_values: 1, ..L },
            CodecLimits { max_rows: 1, ..L },
            CodecLimits {
                max_columns: 0,
                ..L
            },
        ] {
            assert!(encode_reply(&reply, limits).is_err());
            assert!(decode_reply(&bytes, limits, Some(2)).is_err());
        }
        let mut bytes =
            encode_request(&super::tests::request(vec![SqlValue::Real(2.0)]), L).unwrap();
        let start = bytes.len() - 8;
        bytes[start..].copy_from_slice(&f64::INFINITY.to_bits().to_le_bytes());
        assert!(decode_request(&bytes, L).is_err());
    }
    #[test]
    fn bounded_garbage_does_not_panic_or_allocate_from_unchecked_counts() {
        let mut seed = 0x1234_5678_u64;
        for len in 0..256 {
            let mut bytes = vec![0; len];
            for byte in &mut bytes {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                *byte = seed as u8;
            }
            for op in 0..=4 {
                if len >= 9 {
                    bytes[..8].copy_from_slice(MAGIC);
                    bytes[8] = op;
                }
                let _ = decode_request(&bytes, L);
                let _ = decode_reply(&bytes, L, Some(1));
            }
        }
    }
    #[test]
    fn reset_golden_bytes_pin_version_and_operations() {
        assert_eq!(
            encode_request(&IndexRequest::Reset, L).unwrap(),
            b"MDBIDX\0\x01\x01"
        );
        assert_eq!(
            encode_reply(&IndexReply::ResetOk, L).unwrap(),
            b"MDBIDX\0\x01\x04"
        );
    }
}
