//! Typed independent deletion floor and durable collection Gone identity.
//! A record is denial authority, never a positive permission or erasure proof.
use crate::error::{Code, Result, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, Uuid};
use mdbn_wire::schema::Wire;

/// The one immutable deletion identity for a collection, supplied by its backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectionDeletionRecord {
    /// Actual nonnil collection.
    pub collection: Uuid,
    /// First nonnil deletion identity, never superseded.
    pub deletion_id: Uuid,
    /// First positive lifecycle epoch, not a policy/wake epoch.
    pub lifecycle_epoch: u64,
}
impl CollectionDeletionRecord {
    /// Validate fixed-width identity and positive epoch.
    pub fn validate(self) -> Result<Self> {
        if self.collection == B16([0; 16])
            || self.deletion_id == B16([0; 16])
            || self.lifecycle_epoch == 0
        {
            return Err(Self::unavailable());
        }
        Ok(self)
    }
    /// Strict versioned typed receipt `[1, collection, deletion_id, epoch]`.
    pub fn to_cbor(self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            self.collection.to_cbor(),
            self.deletion_id.to_cbor(),
            Cbor::Uint(self.lifecycle_epoch),
        ])
    }
    /// Decode only a complete versioned typed receipt, never a boolean.
    pub fn parse(value: &Cbor) -> Result<Self> {
        let Cbor::Array(values) = value else {
            return Err(Self::unavailable());
        };
        if values.len() != 4 || values[0] != Cbor::Uint(1) {
            return Err(Self::unavailable());
        }
        let Cbor::Uint(lifecycle_epoch) = values[3] else {
            return Err(Self::unavailable());
        };
        Self {
            collection: Uuid::from_cbor(&values[1]).map_err(|_| Self::unavailable())?,
            deletion_id: Uuid::from_cbor(&values[2]).map_err(|_| Self::unavailable())?,
            lifecycle_epoch,
        }
        .validate()
    }
    /// Missing/unreachable/malformed independent floor always fails closed.
    pub fn unavailable() -> ServiceError {
        ServiceError::reason(Code::Unavailable, "collection_deletion_floor_unavailable")
    }
    /// Refuse with authoritative first identity, never successful replacement.
    pub fn conflict(self) -> ServiceError {
        let mut error = ServiceError::reason(Code::Forbidden, "collection_deletion_conflict");
        error.details = Some(self.to_cbor());
        error
    }
}
