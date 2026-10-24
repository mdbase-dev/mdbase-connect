//! Version-one type pack planning (Core `packs`, spec 05A).
use mdbn_wire::common::{Hash, Value};
use mdbn_wire::{Cbor, Wire};

/// A type pack and the caller's decisions, for an assessment or an apply plan.
#[derive(Debug, Clone)]
pub struct TypePackRequest {
    /// `{manifest, resources: [{source, document}], provides?}`.
    pub provision: Value,
    /// Reverse-domain installer identity.
    pub installed_by: String,
    /// Reviewed adoptions: unmanaged target → its exact current digest (text).
    pub adopt: Option<Value>,
    /// Seed targets intentionally omitted.
    pub preserve_seed_targets: Vec<String>,
    /// Canonical target → collection target.
    pub target_overrides: Option<Value>,
    /// Permit a downgrade.
    pub allow_downgrade: bool,
    /// The reviewed assessment digest; present: plan the writes of the apply.
    pub expected: Option<Hash>,
}

/// One resource write of an apply, guarded like Core's ops.
#[derive(Debug, Clone, PartialEq)]
pub struct TypePackWrite {
    /// Resource path.
    pub path: String,
    /// New source; `None` deletes the resource.
    pub doc: Option<String>,
    /// The observed revision the write is guarded by.
    pub base_revision: Option<Hash>,
    /// Create only.
    pub must_not_exist: bool,
}

/// An assessment and, for an apply, the writes of its one mutation.
#[derive(Debug, Clone)]
pub struct TypePackPlan {
    /// The assessment (prod `TypePackAssessment` keys, snake_case).
    pub assessment: Value,
    /// Apply only: the writes (empty when the pack is already current).
    pub writes: Option<Vec<TypePackWrite>>,
}

fn field(key: u64, value: Cbor) -> (Cbor, Cbor) {
    (Cbor::Uint(key), value)
}

impl TypePackPlan {
    pub(crate) fn to_cbor(&self) -> Cbor {
        let mut m = vec![field(0, Cbor::Uint(1)), field(1, self.assessment.to_cbor())];
        if let Some(writes) = &self.writes {
            let list = writes
                .iter()
                .map(|w| {
                    let mut e = vec![field(0, Cbor::Text(w.path.clone()))];
                    if let Some(doc) = &w.doc {
                        e.push(field(1, Cbor::Text(doc.clone())));
                    }
                    if let Some(base) = &w.base_revision {
                        e.push(field(2, base.to_cbor()));
                    }
                    e.push(field(3, Cbor::Bool(w.must_not_exist)));
                    Cbor::Map(e)
                })
                .collect();
            m.push(field(2, Cbor::Array(list)));
        }
        Cbor::Map(m)
    }
}
