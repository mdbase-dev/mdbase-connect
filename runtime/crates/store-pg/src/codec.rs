//! Row encodings: replica types that are stored as opaque `bytea`.
//!
//! Wire types use their canonical `mdb-cbor/1` bytes. Replica-only rows
//! ([`RecordMeta`], [`LocalReceipt`], [`TransferRow`], [`TombstoneLast`]) are CBOR
//! arrays in field order, like [`PendingRow::to_bytes`](mdbn_replica::store::PendingRow::to_bytes).
//! Decoding failures are [`StoreError::Corrupt`].

use std::collections::BTreeSet;
#[cfg(test)]
mod native_tests;

use mdbn_replica::store::{
    FileLocal, LocalReceipt, RecordMeta, StoreError, StoreResult, TombstoneLast, TransferRow,
};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, DataMap, Hash, Uuid, Value};
use mdbn_wire::schema::{SchemaError, Wire, array};

/// Canonical bytes of a wire value.
pub fn bytes<T: Wire>(v: &T) -> StoreResult<Vec<u8>> {
    v.to_bytes()
        .map_err(|e| StoreError::Io(format!("encode: {e:?}")))
}

/// Decode canonical bytes.
pub fn from_bytes<T: Wire>(b: &[u8], what: &str) -> StoreResult<T> {
    let c = cbor::decode(b).map_err(|e| corrupt(what, format!("{e:?}")))?;
    T::from_cbor(&c).map_err(|e| corrupt(what, format!("{e:?}")))
}

/// A corrupt-row error.
pub fn corrupt(what: &str, why: impl std::fmt::Display) -> StoreError {
    StoreError::Corrupt(format!("{what}: {why}"))
}

/// A UUID from a `bytea` column.
pub fn uuid(b: &[u8]) -> StoreResult<Uuid> {
    <[u8; 16]>::try_from(b)
        .map(B16)
        .map_err(|_| corrupt("uuid", "not 16 bytes"))
}

/// A hash from a `bytea` column.
pub fn hash(b: &[u8]) -> StoreResult<Hash> {
    <[u8; 32]>::try_from(b)
        .map(B32)
        .map_err(|_| corrupt("hash", "not 32 bytes"))
}

/// A `u64` as a `bigint`.
pub fn i64_of(v: u64) -> StoreResult<i64> {
    i64::try_from(v).map_err(|_| StoreError::Io(format!("{v} exceeds bigint")))
}

/// A `bigint` as a `u64`.
pub fn u64_of(v: i64) -> StoreResult<u64> {
    u64::try_from(v).map_err(|_| corrupt("bigint", format!("{v} is negative")))
}

/// A wire enum as its small integer.
pub fn enum_code<T: Wire>(v: &T) -> i16 {
    match v.to_cbor() {
        Cbor::Uint(n) => i16::try_from(n).unwrap_or(i16::MAX),
        _ => i16::MAX,
    }
}

/// A wire enum from its small integer.
pub fn enum_from<T: Wire>(n: i16, what: &str) -> StoreResult<T> {
    let n = u64::try_from(n).map_err(|_| corrupt(what, "negative enum"))?;
    T::from_cbor(&Cbor::Uint(n)).map_err(|e| corrupt(what, format!("{e:?}")))
}

/// [`FileLocal`] as a small integer.
pub fn local_code(l: FileLocal) -> i16 {
    match l {
        FileLocal::Materialized => 0,
        FileLocal::Remote => 1,
        FileLocal::Fetching => 2,
    }
}

/// [`FileLocal`] from its small integer.
pub fn local_from(n: i16) -> StoreResult<FileLocal> {
    Ok(match n {
        0 => FileLocal::Materialized,
        1 => FileLocal::Remote,
        2 => FileLocal::Fetching,
        _ => return Err(corrupt("file local", n)),
    })
}

fn enc(c: Cbor, what: &str) -> StoreResult<Vec<u8>> {
    cbor::encode(&c).map_err(|e| StoreError::Io(format!("encode {what}: {e:?}")))
}

fn dec_array<'a>(c: &'a Cbor, what: &'static str, n: usize) -> StoreResult<&'a [Cbor]> {
    let a = array(c, what).map_err(|e| corrupt(what, format!("{e:?}")))?;
    if a.len() != n {
        return Err(corrupt(what, "wrong number of elements"));
    }
    Ok(a)
}

fn opt<T: Wire>(v: &Option<T>) -> Cbor {
    match v {
        Some(v) => v.to_cbor(),
        None => Cbor::Null,
    }
}

fn unopt<T: Wire>(c: &Cbor) -> Result<Option<T>, SchemaError> {
    match c {
        Cbor::Null => Ok(None),
        c => T::from_cbor(c).map(Some),
    }
}

fn wrap<T>(r: Result<T, SchemaError>, what: &str) -> StoreResult<T> {
    r.map_err(|e| corrupt(what, format!("{e:?}")))
}

fn pairs(v: &[(String, String)]) -> Cbor {
    Cbor::Array(
        v.iter()
            .map(|(a, b)| Cbor::Array(vec![Cbor::Text(a.clone()), Cbor::Text(b.clone())]))
            .collect(),
    )
}

fn unpairs(c: &Cbor) -> Result<Vec<(String, String)>, SchemaError> {
    array(c, "pairs")?
        .iter()
        .map(|p| {
            let a = array(p, "pair")?;
            match a {
                [x, y] => Ok((String::from_cbor(x)?, String::from_cbor(y)?)),
                _ => Err(SchemaError::Invalid {
                    ty: "pair",
                    reason: "wrong number of elements",
                }),
            }
        })
        .collect()
}

/// Encode [`RecordMeta`].
pub fn meta_bytes(m: &RecordMeta) -> StoreResult<Vec<u8>> {
    enc(
        Cbor::Array(vec![
            m.types.to_cbor(),
            m.effective.to_cbor(),
            m.links.to_cbor(),
            m.tags.to_cbor(),
            pairs(&m.unique),
        ]),
        "meta",
    )
}

/// Decode [`RecordMeta`].
pub fn meta_from(b: &[u8]) -> StoreResult<RecordMeta> {
    let c = cbor::decode(b).map_err(|e| corrupt("meta", format!("{e:?}")))?;
    let a = dec_array(&c, "RecordMeta", 5)?;
    Ok(RecordMeta {
        types: wrap(Vec::<String>::from_cbor(&a[0]), "meta.types")?,
        effective: wrap(DataMap::<Value>::from_cbor(&a[1]), "meta.effective")?,
        links: wrap(Vec::<String>::from_cbor(&a[2]), "meta.links")?,
        tags: wrap(Vec::<String>::from_cbor(&a[3]), "meta.tags")?,
        unique: wrap(unpairs(&a[4]), "meta.unique")?,
    })
}

/// Encode authoritative native kind in the existing blob bytea column. Legacy
/// Ordinary Blob bytes remain exact; native payloads use the closed Wire box.
pub fn file_payload_bytes(
    kind: mdbn_wire::unindexed_markdown::FileKindV1,
    content: &mdbn_wire::attachment::FileContent,
) -> StoreResult<Vec<u8>> {
    use mdbn_wire::{
        attachment::FileContent,
        unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
    };
    match kind {
        FileKindV1::Ordinary => match content {
            FileContent::Blob(b) => bytes(b),
            _ => Err(StoreError::Io(
                "attachment file rows have no Postgres codec yet".into(),
            )),
        },
        FileKindV1::UnindexedOversizedMarkdown => {
            let payload = UnindexedMarkdownPayloadV1 {
                content: content.clone(),
            };
            wrap(
                UnindexedMarkdownPayloadV1::from_cbor(&payload.to_cbor()),
                "native file payload",
            )?;
            bytes(&payload)
        }
    }
}
/// Decode without extension inference or loss of authoritative native kind.
pub fn file_payload_from(
    b: &[u8],
) -> StoreResult<(
    mdbn_wire::unindexed_markdown::FileKindV1,
    mdbn_wire::attachment::FileContent,
)> {
    use mdbn_wire::{
        attachment::FileContent,
        unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1},
    };
    let c = cbor::decode(b).map_err(|e| corrupt("file payload", format!("{e:?}")))?;
    match &c {
        Cbor::Array(_) => {
            let p = wrap(
                UnindexedMarkdownPayloadV1::from_cbor(&c),
                "native file payload",
            )?;
            Ok((FileKindV1::UnindexedOversizedMarkdown, p.content))
        }
        _ => Ok((
            FileKindV1::Ordinary,
            FileContent::Blob(wrap(Wire::from_cbor(&c), "file blob")?),
        )),
    }
}

/// Encode [`TombstoneLast`].
pub fn last_bytes(l: &TombstoneLast) -> StoreResult<Vec<u8>> {
    let c = match l {
        TombstoneLast::Doc(d) => Cbor::Array(vec![Cbor::Uint(0), Cbor::Text(d.clone())]),
        TombstoneLast::Blob(b) => Cbor::Array(vec![Cbor::Uint(1), b.to_cbor()]),
        TombstoneLast::UnindexedMarkdown(p) => {
            wrap(
                mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1::from_cbor(&p.to_cbor()),
                "native tombstone payload",
            )?;
            Cbor::Array(vec![Cbor::Uint(3), p.to_cbor()])
        }
        TombstoneLast::Attachment(_) => {
            return Err(StoreError::Io(
                "attachment tombstones have no Postgres codec yet".into(),
            ));
        }
    };
    enc(c, "tombstone")
}

/// Decode [`TombstoneLast`].
pub fn last_from(b: &[u8]) -> StoreResult<TombstoneLast> {
    let c = cbor::decode(b).map_err(|e| corrupt("tombstone", format!("{e:?}")))?;
    let a = dec_array(&c, "TombstoneLast", 2)?;
    match &a[0] {
        Cbor::Uint(0) => Ok(TombstoneLast::Doc(wrap(
            String::from_cbor(&a[1]),
            "tombstone.doc",
        )?)),
        Cbor::Uint(1) => Ok(TombstoneLast::Blob(wrap(
            Wire::from_cbor(&a[1]),
            "tombstone.blob",
        )?)),
        Cbor::Uint(3) => Ok(TombstoneLast::UnindexedMarkdown(wrap(
            Wire::from_cbor(&a[1]),
            "native tombstone payload",
        )?)),
        _ => Err(corrupt("tombstone", "unknown variant")),
    }
}

/// Encode a [`LocalReceipt`].
pub fn local_receipt_bytes(r: &LocalReceipt) -> StoreResult<Vec<u8>> {
    enc(
        Cbor::Array(vec![
            r.mutation.to_cbor(),
            r.state.to_cbor(),
            opt(&r.seq),
            opt(&r.status),
            r.conflicts.to_cbor(),
            opt(&r.problem),
            r.resolved_at.to_cbor(),
            opt(&r.grant),
        ]),
        "local receipt",
    )
}

/// Decode a [`LocalReceipt`].
pub fn local_receipt_from(b: &[u8]) -> StoreResult<LocalReceipt> {
    let c = cbor::decode(b).map_err(|e| corrupt("local receipt", format!("{e:?}")))?;
    // 8 elements since `grant`; rows written before it have 7.
    let a = array(&c, "LocalReceipt").map_err(|e| corrupt("LocalReceipt", format!("{e:?}")))?;
    if a.len() != 7 && a.len() != 8 {
        return Err(corrupt("LocalReceipt", "wrong number of elements"));
    }
    let w = "local receipt";
    Ok(LocalReceipt {
        mutation: wrap(Wire::from_cbor(&a[0]), w)?,
        state: wrap(Wire::from_cbor(&a[1]), w)?,
        seq: wrap(unopt(&a[2]), w)?,
        status: wrap(unopt(&a[3]), w)?,
        conflicts: wrap(Wire::from_cbor(&a[4]), w)?,
        problem: wrap(unopt(&a[5]), w)?,
        resolved_at: wrap(i64::from_cbor(&a[6]), w)?,
        grant: match a.get(7) {
            Some(g) => wrap(unopt(g), w)?,
            None => None,
        },
    })
}

/// Encode a [`TransferRow`].
pub fn transfer_bytes(t: &TransferRow) -> StoreResult<Vec<u8>> {
    let received: Vec<u64> = t.received.iter().copied().collect();
    enc(
        Cbor::Array(vec![
            t.id.to_cbor(),
            Cbor::Text(t.path.clone()),
            t.size.to_cbor(),
            opt(&t.digest),
            opt(&t.file),
            opt(&t.if_revision),
            opt(&t.mutation),
            t.chunk_size.to_cbor(),
            received.to_cbor(),
            t.expires_at.to_cbor(),
            opt(&t.grant),
        ]),
        "transfer",
    )
}

/// Decode a [`TransferRow`].
pub fn transfer_from(b: &[u8]) -> StoreResult<TransferRow> {
    let c = cbor::decode(b).map_err(|e| corrupt("transfer", format!("{e:?}")))?;
    let a = dec_array(&c, "TransferRow", 11)?;
    let w = "transfer";
    let received: Vec<u64> = wrap(Wire::from_cbor(&a[8]), w)?;
    Ok(TransferRow {
        id: wrap(Wire::from_cbor(&a[0]), w)?,
        path: wrap(String::from_cbor(&a[1]), w)?,
        size: wrap(u64::from_cbor(&a[2]), w)?,
        digest: wrap(unopt(&a[3]), w)?,
        file: wrap(unopt(&a[4]), w)?,
        if_revision: wrap(unopt(&a[5]), w)?,
        mutation: wrap(unopt(&a[6]), w)?,
        chunk_size: wrap(u64::from_cbor(&a[7]), w)?,
        received: received.into_iter().collect::<BTreeSet<u64>>(),
        expires_at: wrap(i64::from_cbor(&a[9]), w)?,
        grant: wrap(unopt(&a[10]), w)?,
    })
}

/// The pushdown columns of a scalar value: `(v, k2, num)`.
///
/// `v` is the canonical encoding, compared bytewise for equality. That equals
/// the wire `Value`'s structural equality except for floats (`-0.0 == 0.0`), so
/// float literals are never pushed down as equality (see `query`). `k2` holds
/// text for range comparisons; `num` holds numbers that a `double` represents
/// exactly.
pub fn value_columns(v: &Value) -> (Option<Vec<u8>>, Option<String>, Option<f64>) {
    let bytes = v.to_bytes().ok();
    match v {
        Value::Text(s) => (bytes, Some(s.clone()), None),
        Value::Int(i) => (bytes, None, exact_f64(*i)),
        Value::Float(f) => (bytes, None, Some(*f)),
        Value::Null | Value::Bool(_) => (bytes, None, None),
        Value::List(_) | Value::Map(_) => (None, None, None),
    }
}

/// An integer as a `double`, when the conversion is exact (|i| ≤ 2^53).
pub fn exact_f64(i: i64) -> Option<f64> {
    const LIMIT: i64 = 1 << 53;
    // The bound makes the cast exact.
    #[allow(clippy::cast_precision_loss)]
    (-LIMIT..=LIMIT).contains(&i).then_some(i as f64)
}
