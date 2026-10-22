//! Version-one contract-scoped single-record reads and write mapping.
use crate::api::Target;
use mdbn_wire::common::{DataMap, Hash, Uuid, Value};
use mdbn_wire::intent::BaseField;
use mdbn_wire::{Cbor, Wire};

/// An exact registered record contract and, optionally, its implementing type.
#[derive(Debug, Clone)]
pub struct ContractSelection {
    /// Registered contract ID.
    pub contract: String,
    /// Exact version.
    pub version: String,
    /// Implementing type; required when several implement the contract.
    pub type_name: Option<String>,
}

/// One record's valid contract view.
#[derive(Debug, Clone)]
pub struct ContractRecordView {
    /// Native record ID.
    pub id: Uuid,
    /// Current path.
    pub path: String,
    /// Document revision.
    pub revision: Hash,
    /// The implementing type.
    pub type_name: String,
    /// Contract fields.
    pub fields: DataMap<Value>,
    /// Contract digest.
    pub contract_digest: Hash,
    /// Implementation digest.
    pub implementation_digest: Hash,
}

/// Contract field values and removals to map to record fields.
#[derive(Debug, Clone)]
pub struct ContractWriteRequest {
    /// The selection.
    pub selection: ContractSelection,
    /// The record to update; `None` maps a create.
    pub target: Option<Target>,
    /// Contract field values.
    pub fields: Value,
    /// Contract field references to remove.
    pub unset: Vec<String>,
    /// Give an untyped target the selected implementing type in the same write.
    pub promote: bool,
}

/// A contract write as ordinary top-level record changes.
#[derive(Debug, Clone)]
pub struct ContractWritePlan {
    /// The implementing type (a create's `type`).
    pub type_name: String,
    /// Top-level fields to set.
    pub patch: DataMap<Value>,
    /// Top-level fields to remove.
    pub unset: Vec<String>,
    /// Observed values of merged (nested) keys.
    pub base: Vec<BaseField>,
    /// Contract digest.
    pub contract_digest: Hash,
    /// Implementation digest.
    pub implementation_digest: Hash,
    /// The target record (updates): ID, path and revision.
    pub record: Option<(Uuid, String, Hash)>,
}

fn field(key: u64, value: Cbor) -> (Cbor, Cbor) {
    (Cbor::Uint(key), value)
}

impl ContractRecordView {
    pub(crate) fn to_cbor(&self) -> Cbor {
        Cbor::Map(vec![
            field(0, Cbor::Uint(1)),
            field(1, self.id.to_cbor()),
            field(2, Cbor::Text(self.path.clone())),
            field(3, self.revision.to_cbor()),
            field(4, Cbor::Text(self.type_name.clone())),
            field(5, self.fields.to_cbor()),
            field(6, self.contract_digest.to_cbor()),
            field(7, self.implementation_digest.to_cbor()),
        ])
    }
}

impl ContractWritePlan {
    pub(crate) fn to_cbor(&self) -> Cbor {
        let mut m = vec![
            field(0, Cbor::Uint(1)),
            field(1, Cbor::Text(self.type_name.clone())),
            field(2, self.patch.to_cbor()),
            field(3, self.unset.to_cbor()),
            field(4, self.base.to_cbor()),
            field(5, self.contract_digest.to_cbor()),
            field(6, self.implementation_digest.to_cbor()),
        ];
        if let Some((id, path, revision)) = &self.record {
            m.push(field(7, id.to_cbor()));
            m.push(field(8, Cbor::Text(path.clone())));
            m.push(field(9, revision.to_cbor()));
        }
        Cbor::Map(m)
    }
}
