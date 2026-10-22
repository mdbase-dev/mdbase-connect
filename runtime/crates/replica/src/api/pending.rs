//! Read-only runtime pending-journal recovery DTOs (§6.1).
use mdbn_wire::attachment_runtime_v1::Op;
use mdbn_wire::client::Receipt;
use mdbn_wire::common::Uuid;
use mdbn_wire::{Cbor, Wire};

/// Evidence from one original durable pending row, not a caller projection.
#[derive(Debug, Clone)]
pub struct PendingMutation {
    /// Current pending receipt with its original mutation ID.
    pub receipt: Receipt,
    /// Original capture clock in milliseconds.
    pub captured: i64,
    /// Exact runtime operations, including attachment captures.
    pub ops: Vec<Op>,
}
impl PendingMutation {
    pub(crate) fn to_cbor(&self) -> Cbor {
        Cbor::Map(vec![
            (Cbor::Uint(0), self.receipt.to_cbor()),
            (Cbor::Uint(1), self.captured.to_cbor()),
            (Cbor::Uint(2), self.ops.to_cbor()),
        ])
    }
}
/// A bounded live page of the same replica's pending journal.
#[derive(Debug, Clone)]
pub struct PendingPage {
    /// Visible original rows in capture order.
    pub pending: Vec<PendingMutation>,
    /// Opaque session-owned position; not a mutation or replacement identity.
    pub next: Option<Uuid>,
}
impl PendingPage {
    pub(crate) fn to_cbor(&self) -> Cbor {
        let mut fields = vec![(
            Cbor::Uint(0),
            Cbor::Array(self.pending.iter().map(PendingMutation::to_cbor).collect()),
        )];
        if let Some(next) = self.next {
            fields.push((Cbor::Uint(1), next.to_cbor()));
        }
        Cbor::Map(fields)
    }
}
