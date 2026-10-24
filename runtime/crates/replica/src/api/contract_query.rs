//! Version-one read-only contract inspection over the ordinary query cursor.
use mdbn_wire::client::{Issue, QueryResult};
use mdbn_wire::common::{DataMap, Hash, Uuid, Value};
use mdbn_wire::{Cbor, Wire};

/// Exact registered record contract and bounded page selection.
#[derive(Debug, Clone)]
pub struct ContractQuery {
    /// Registered contract ID, never a type-name inference.
    pub contract: String,
    /// Exact resolved version.
    pub version: String,
    /// Page size, 1–128.
    pub limit: u32,
    /// Ordinary session-bound query continuation.
    pub cursor: Option<String>,
    /// CEL over each projection's contract fields (as for a record `where`);
    /// non-matching projections and records left without one are dropped, so
    /// a filtered page may hold fewer than `limit` records.
    pub where_: Option<String>,
}
/// One resolved type's canonical projection, including invalid data for inspection.
#[derive(Debug, Clone)]
pub struct ContractProjection {
    /// Exact implementing type.
    pub type_name: String,
    /// Mapped effective values; missing optional mappings remain missing.
    pub fields: DataMap<Value>,
    /// Validation issues; nonempty means NOT a valid contract view.
    pub issues: Vec<Issue>,
}
/// Projections of one exact record in the enclosing query page.
#[derive(Debug, Clone)]
pub struct ContractQueryRecord {
    /// Native record UUID, not its path.
    pub id: Uuid,
    /// All matching resolved implementations.
    pub implementations: Vec<ContractProjection>,
}
/// One consistent query page with canonical contract projections.
#[derive(Debug, Clone)]
pub struct ContractQueryResult {
    /// Ordinary query records, completeness and continuation metadata.
    pub page: QueryResult,
    /// One projection entry for every page record, in the same order.
    pub records: Vec<ContractQueryRecord>,
    /// Exact registered schema identity, bound into the continuation.
    pub contract_digest: Hash,
}
impl ContractQueryResult {
    pub(crate) fn to_cbor(&self) -> Cbor {
        let field = |key, value| (Cbor::Uint(key), value);
        Cbor::Map(vec![
            field(0, Cbor::Uint(1)),
            field(1, self.page.to_cbor()),
            field(
                2,
                Cbor::Array(
                    self.records
                        .iter()
                        .map(|r| {
                            Cbor::Map(vec![
                                field(0, r.id.to_cbor()),
                                field(
                                    1,
                                    Cbor::Array(
                                        r.implementations
                                            .iter()
                                            .map(|i| {
                                                Cbor::Map(vec![
                                                    field(0, Cbor::Text(i.type_name.clone())),
                                                    field(1, i.fields.to_cbor()),
                                                    field(2, i.issues.to_cbor()),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            field(3, self.contract_digest.to_cbor()),
        ])
    }
}
