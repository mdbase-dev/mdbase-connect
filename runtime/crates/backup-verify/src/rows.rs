//! Exact actual SQL-export row schemas; borrowed envelope bytes remain opaque.
use crate::Refusal;
use crate::completion::{digest, uint};
use mdbn_log_service::model::{ObjectMeta, SnapshotRow};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::schema::Wire;

fn fields(row: &Cbor, count: usize) -> Result<&[Cbor], Refusal> {
    let Cbor::Array(values) = row else {
        return Err(Refusal::Canonical);
    };
    if values.len() != count {
        return Err(Refusal::Canonical);
    }
    if uint(&values[0])? == 0 {
        return Err(Refusal::Pages);
    }
    Ok(values)
}
fn time(value: &Cbor) -> Result<i64, Refusal> {
    value.as_i64().ok_or(Refusal::Canonical)
}
fn holder(value: &Cbor, head: u64) -> Result<u64, Refusal> {
    let seq = uint(value)?;
    if seq == 0 || seq > head {
        return Err(Refusal::Inventory);
    }
    Ok(seq)
}
fn uuid(value: &Cbor) -> Result<Uuid, Refusal> {
    Uuid::from_cbor(value).map_err(|_| Refusal::Canonical)
}

pub(crate) struct ItemRow<'a> {
    pub(crate) seq: u64,
    pub(crate) kind: u64,
    pub(crate) bytes: &'a [u8],
    pub(crate) created_at: i64,
}
pub(crate) fn item(row: &Cbor, head: u64) -> Result<ItemRow<'_>, Refusal> {
    let values = fields(row, 4)?;
    let kind = uint(&values[1])?;
    if !(1..=6).contains(&kind) {
        return Err(Refusal::History);
    }
    let Cbor::Bytes(bytes) = &values[2] else {
        return Err(Refusal::Canonical);
    };
    Ok(ItemRow {
        seq: holder(&values[0], head)?,
        kind,
        bytes,
        created_at: time(&values[3])?,
    })
}
pub(crate) fn snapshot(row: &Cbor, head: u64) -> Result<SnapshotRow, Refusal> {
    let values = fields(row, 5)?;
    // SQL export converts endorsed INTEGER to CBOR uint, NOT a CBOR bool.
    let endorsed = match &values[4] {
        Cbor::Uint(0) => false,
        Cbor::Uint(1) => true,
        _ => return Err(Refusal::Canonical),
    };
    Ok(SnapshotRow {
        seq: holder(&values[0], head)?,
        manifest: digest(&values[1])?,
        author: uuid(&values[2])?,
        created_at: time(&values[3])?,
        endorsed,
        refs: Vec::new(),
    })
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct RefRow {
    pub(crate) kind: u64,
    pub(crate) holder: u64,
    pub(crate) address: B32,
}
pub(crate) fn reference(row: &Cbor, head: u64) -> Result<RefRow, Refusal> {
    let values = fields(row, 4)?;
    // Actual schema is [rowid, ADDRESS, holder_kind, holder], not reordered JSON.
    let kind = uint(&values[2])?;
    if kind > 1 {
        return Err(Refusal::Refs);
    }
    Ok(RefRow {
        kind,
        holder: holder(&values[3], head)?,
        address: digest(&values[1])?,
    })
}
pub(crate) fn object(row: &Cbor) -> Result<ObjectMeta, Refusal> {
    let values = fields(row, 6)?;
    let kind = uint(&values[2])?;
    if !(16..=19).contains(&kind) {
        return Err(Refusal::Objects);
    }
    let size = uint(&values[3])?;
    if size == 0 || size > 9 * 1024 * 1024 {
        return Err(Refusal::Bounds);
    }
    Ok(ObjectMeta {
        address: digest(&values[1])?,
        kind,
        size,
        checksum: digest(&values[4])?,
        committed: true,
        created_at: time(&values[5])?,
    })
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct TokenRow {
    pub(crate) token: Uuid,
    pub(crate) seq: u64,
    pub(crate) expires_at: i64,
}
pub(crate) fn token(row: &Cbor, head: u64) -> Result<TokenRow, Refusal> {
    let values = fields(row, 4)?;
    Ok(TokenRow {
        token: uuid(&values[1])?,
        seq: holder(&values[2], head)?,
        expires_at: time(&values[3])?,
    })
}
pub(crate) struct NonceRow {
    pub(crate) nonce: B32,
    pub(crate) expires_at: i64,
}
pub(crate) fn nonce(row: &Cbor) -> Result<NonceRow, Refusal> {
    let values = fields(row, 3)?;
    Ok(NonceRow {
        nonce: digest(&values[1])?,
        expires_at: time(&values[2])?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;
    fn row(values: Vec<Cbor>) -> Cbor {
        Cbor::Array(values)
    }
    #[test]
    fn refs_use_actual_address_then_kind_then_holder_order() {
        let values = vec![
            Cbor::Uint(1),
            B32([2; 32]).to_cbor(),
            Cbor::Uint(1),
            Cbor::Uint(8),
        ];
        let reference = reference(&row(values.clone()), 10).unwrap();
        assert_eq!(reference.address, B32([2; 32]));
        assert_eq!(reference.kind, 1);
        assert_eq!(reference.holder, 8);
        let mut bad = values;
        bad.swap(1, 2);
        assert!(reference_parser(&row(bad), 10).is_err());
    }
    fn reference_parser(row: &Cbor, head: u64) -> Result<RefRow, Refusal> {
        reference(row, head)
    }
    #[test]
    fn snapshot_sql_integer_endorsement_and_original_time_are_preserved() {
        let mut values = vec![
            Cbor::Uint(8),
            B32([2; 32]).to_cbor(),
            B16([3; 16]).to_cbor(),
            Cbor::int(-2),
            Cbor::Uint(1),
        ];
        let snapshot = snapshot(&row(values.clone()), 10).unwrap();
        assert!(snapshot.endorsed);
        assert_eq!(snapshot.created_at, -2);
        values[4] = Cbor::Bool(true);
        assert!(super::snapshot(&row(values), 10).is_err());
    }
    #[test]
    fn all_committed_object_fields_and_nine_mib_ceiling_are_exact() {
        let mut values = vec![
            Cbor::Uint(1),
            B32([2; 32]).to_cbor(),
            Cbor::Uint(18),
            Cbor::Uint(9 * 1024 * 1024),
            B32([4; 32]).to_cbor(),
            Cbor::int(-3),
        ];
        let object = object(&row(values.clone())).unwrap();
        assert!(object.committed);
        assert_eq!(object.created_at, -3);
        values[3] = Cbor::Uint(9 * 1024 * 1024 + 1);
        assert!(matches!(super::object(&row(values)), Err(Refusal::Bounds)));
    }
    #[test]
    fn token_and_nonce_negative_expiry_is_capture_metadata_not_current_permission() {
        let token = token(
            &row(vec![
                Cbor::Uint(1),
                B16([2; 16]).to_cbor(),
                Cbor::Uint(4),
                Cbor::int(-9),
            ]),
            10,
        )
        .unwrap();
        assert_eq!(token.expires_at, -9);
        let nonce = nonce(&row(vec![
            Cbor::Uint(1),
            B32([3; 32]).to_cbor(),
            Cbor::int(-10),
        ]))
        .unwrap();
        assert_eq!(nonce.expires_at, -10);
        assert_eq!(nonce.nonce, B32([3; 32]));
    }
    #[test]
    fn exact_shapes_holder_bounds_and_timestamp_overflow_refuse() {
        assert!(item(&row(vec![]), 10).is_err());
        assert!(
            item(
                &row(vec![
                    Cbor::Uint(11),
                    Cbor::Uint(1),
                    Cbor::Bytes(vec![1]),
                    Cbor::Uint(0)
                ]),
                10
            )
            .is_err()
        );
        assert!(
            token(
                &row(vec![
                    Cbor::Uint(1),
                    B16([2; 16]).to_cbor(),
                    Cbor::Uint(1),
                    Cbor::Uint(u64::MAX)
                ]),
                10
            )
            .is_err()
        );
        assert!(
            nonce(&row(vec![
                Cbor::Uint(1),
                B32([3; 32]).to_cbor(),
                Cbor::Uint(0),
                Cbor::Uint(0)
            ]))
            .is_err()
        );
    }
}
