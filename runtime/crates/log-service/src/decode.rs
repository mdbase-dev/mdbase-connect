//! Allocation-free CBOR resource preflight at log-service trust boundaries.
//!
//! This is not a second schema/profile validator: the ordinary wire decoder
//! still validates canonical CBOR and typed structure after these safety bounds.
use crate::error::{Code, Result, ServiceError};
use mdbn_wire::cbor::MAX_DEPTH;
use mdbn_wire::schema::Wire;
use std::sync::{Arc, Mutex};
/// Largest CBOR value accepted at a service decode boundary.
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
/// Global value count, including map keys and all nested containers.
pub const MAX_NODES: usize = 4096;
/// Aggregate encoded bytes entering decoders in one request (not memory credits).
pub const MAX_WORK_BYTES: usize = 64 * 1024 * 1024;
/// Identifier-free usage shared by every decode within a request.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    /// CBOR value heads inspected across all decode boundaries.
    pub nodes: usize,
    /// Encoded bytes admitted for preflight/decoding, including opaque strings.
    pub work_bytes: usize,
    /// Largest depth observed at any actual decode boundary.
    pub depth: usize,
}
/// A whole-request decode budget. Cloning shares counters; it never resets them.
///
/// Create this at request admission and pass it through authentication, dispatch
/// and nested decoders. Ciphertext is opaque until a legitimate decode boundary.
/// This work bound is separate from transport lifetime memory admission.
#[derive(Clone, Debug, Default)]
pub struct Budget {
    usage: Arc<Mutex<Usage>>,
    #[cfg(not(target_arch = "wasm32"))]
    offline: Option<Arc<crate::offline_decode::Ledger>>,
}
impl Budget {
    /// Continue bounded accounting across a transport hop. Counters are only
    /// resource restrictions, NEVER authentication. Forwarders overwrite client
    /// headers; receivers cannot admit more than a fresh budget even if forged.
    pub fn from_usage(usage: Usage) -> Result<Self> {
        if usage.nodes > MAX_NODES || usage.work_bytes > MAX_WORK_BYTES || usage.depth > MAX_DEPTH {
            return Err(ServiceError::invalid("cbor_budget"));
        }
        Ok(Self {
            usage: Arc::new(Mutex::new(usage)),
            #[cfg(not(target_arch = "wasm32"))]
            offline: None,
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn with_offline(ledger: Arc<crate::offline_decode::Ledger>) -> Self {
        Self {
            usage: Arc::default(),
            offline: Some(ledger),
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn require_offline(&self) -> Result<()> {
        self.offline
            .as_ref()
            .ok_or_else(|| ServiceError::invalid("cbor_offline_budget"))?
            .charge(0)
            .map_err(ServiceError::invalid)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn reserve_owned(
        &self,
        bytes: u64,
    ) -> Result<crate::offline_decode::OfflineOwnedReservation> {
        self.offline
            .as_ref()
            .ok_or_else(|| ServiceError::invalid("cbor_offline_budget"))?
            .reserve_owned(bytes)
            .map_err(ServiceError::invalid)
    }

    pub(crate) fn poison_offline(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(ledger) = &self.offline {
            ledger.poison();
        }
    }

    /// Read identifier-free aggregate evidence.
    pub fn usage(&self) -> Usage {
        *self.usage.lock().expect("decode budget mutex poisoned")
    }
    /// Preflight another value against this request's remaining resources.
    /// Failed scans still consume inspected nodes and admitted work; no refund.
    pub fn preflight(&self, bytes: &[u8]) -> std::result::Result<Stats, Rejected> {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(ledger) = &self.offline {
            ledger.charge(bytes.len()).map_err(|reason| Rejected {
                reason,
                stats: Stats::default(),
            })?;
        }
        let result = self.preflight_local(bytes);
        if result.is_err() {
            self.poison_offline();
        }
        result
    }

    fn preflight_local(&self, bytes: &[u8]) -> std::result::Result<Stats, Rejected> {
        let mut usage = self.usage.lock().expect("decode budget mutex poisoned");
        let rejection = |reason| Rejected {
            reason,
            stats: Stats::default(),
        };
        if bytes.len() > MAX_BYTES {
            return Err(rejection("cbor_bytes"));
        }
        let work = usage
            .work_bytes
            .checked_add(bytes.len())
            .filter(|work| *work <= MAX_WORK_BYTES)
            .ok_or_else(|| rejection("cbor_work"))?;
        usage.work_bytes = work;
        let mut scan = Scan {
            bytes,
            offset: 0,
            stats: Stats::default(),
            node_limit: MAX_NODES - usage.nodes,
        };
        let result = scan.value(0).and_then(|()| {
            if scan.offset == bytes.len() {
                Ok(scan.stats)
            } else {
                Err(scan.err("cbor_shape"))
            }
        });
        usage.nodes += scan.stats.nodes;
        usage.depth = usage.depth.max(scan.stats.depth);
        result
    }
    /// Materialize a raw value only after charging this request's budget.
    pub fn raw(&self, bytes: &[u8]) -> Result<mdbn_wire::cbor::Cbor> {
        self.preflight(bytes)
            .map_err(|e| ServiceError::invalid(e.reason))?;
        let result = mdbn_wire::cbor::decode(bytes).map_err(materialization_error);
        if result.is_err() {
            self.poison_offline();
        }
        result
    }
    /// Materialize a typed value only after charging this request's budget.
    pub fn wire<T: Wire>(&self, bytes: &[u8]) -> Result<T> {
        self.preflight(bytes)
            .map_err(|e| ServiceError::invalid(e.reason))?;
        let result = T::from_bytes(bytes).map_err(schema_materialization_error);
        if result.is_err() {
            self.poison_offline();
        }
        result
    }
}
// Only called after successful preflight proved every encoded length/offset
// fits the bounded input. TooLong here is a fallible reservation refusal, not
// evidence that stored bytes are corrupt; never erase that distinction.
fn materialization_error(error: mdbn_wire::cbor::CborError) -> ServiceError {
    match error {
        mdbn_wire::cbor::CborError::TooLong => ServiceError::invalid("cbor_alloc"),
        _ => ServiceError::invalid("shape"),
    }
}

fn schema_materialization_error(error: mdbn_wire::schema::SchemaError) -> ServiceError {
    match error {
        mdbn_wire::schema::SchemaError::Cbor(error) => materialization_error(error),
        _ => ServiceError::invalid("shape"),
    }
}

/// Resource/admission refusal cannot confer stored-byte deletion authority.
pub(crate) fn is_resource_refusal(error: &ServiceError) -> bool {
    error.code == Code::Invalid
        && matches!(
            error.reason.as_deref(),
            Some(
                "cbor_nodes"
                    | "cbor_work"
                    | "cbor_bytes"
                    | "cbor_depth"
                    | "cbor_budget"
                    | "cbor_alloc"
                    | "cbor_offline_work"
                    | "cbor_offline_budget"
                    | "cbor_offline_memory"
            )
        )
}

/// Resource evidence without payload/identity fields.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Value heads inspected; no decoded Cbor objects are allocated.
    pub nodes: usize,
    /// Greatest nesting depth inspected.
    pub depth: usize,
}
/// A rejected allocation-free preflight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rejected {
    /// Static failure category.
    pub reason: &'static str,
    /// Heads inspected before failure; no Cbor nodes were materialized.
    pub stats: Stats,
}
struct Scan<'a> {
    bytes: &'a [u8],
    offset: usize,
    stats: Stats,
    node_limit: usize,
}
impl Scan<'_> {
    fn err(&self, reason: &'static str) -> Rejected {
        Rejected {
            reason,
            stats: self.stats,
        }
    }
    fn take(&mut self, n: usize) -> std::result::Result<&[u8], Rejected> {
        let end = self
            .offset
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| self.err("cbor_shape"))?;
        let part = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(part)
    }
    fn argument(&mut self, ai: u8) -> std::result::Result<u64, Rejected> {
        let width = match ai {
            0..=23 => return Ok(ai as u64),
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => return Err(self.err("cbor_shape")),
        };
        Ok(self
            .take(width)?
            .iter()
            .fold(0, |n, b| (n << 8) | (*b as u64)))
    }
    fn value(&mut self, depth: usize) -> std::result::Result<(), Rejected> {
        if depth > MAX_DEPTH {
            return Err(self.err("cbor_depth"));
        }
        self.stats.depth = self.stats.depth.max(depth);
        if self.stats.nodes == self.node_limit {
            return Err(self.err("cbor_nodes"));
        }
        self.stats.nodes += 1;
        let byte = *self.take(1)?.first().expect("one byte");
        let major = byte >> 5;
        let ai = byte & 31;
        match major {
            0 | 1 => {
                self.argument(ai)?;
            }
            2 | 3 => {
                let n = usize::try_from(self.argument(ai)?).map_err(|_| self.err("cbor_shape"))?;
                self.take(n)?;
            }
            4 | 5 => {
                let n = usize::try_from(self.argument(ai)?).map_err(|_| self.err("cbor_nodes"))?;
                let count = n
                    .checked_mul(if major == 5 { 2 } else { 1 })
                    .ok_or_else(|| self.err("cbor_nodes"))?;
                // Reject the minimum implied allocation before walking children.
                if count > self.node_limit - self.stats.nodes {
                    return Err(self.err("cbor_nodes"));
                }
                if count > self.bytes.len() - self.offset {
                    return Err(self.err("cbor_shape"));
                }
                for _ in 0..count {
                    self.value(depth + 1)?;
                }
            }
            7 => match ai {
                20..=22 => {}
                27 => {
                    self.take(8)?;
                }
                _ => return Err(self.err("cbor_shape")),
            },
            _ => return Err(self.err("cbor_shape")),
        }
        Ok(())
    }
}
/// Validate resource bounds without allocating any container/string/value.
/// Byte strings remain opaque; callers preflight again at each actual nested
/// decode boundary (sealed ciphertext must not be recursively interpreted).
pub fn preflight(bytes: &[u8]) -> std::result::Result<Stats, Rejected> {
    Budget::default().preflight(bytes)
}
/// Apply resource preflight before materializing a raw canonical CBOR value.
pub fn raw(bytes: &[u8]) -> Result<mdbn_wire::cbor::Cbor> {
    Budget::default().raw(bytes)
}
/// Apply resource preflight before the normal typed/canonical decoder.
pub fn wire<T: Wire>(bytes: &[u8]) -> Result<T> {
    Budget::default().wire(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_refusal_after_preflight_is_not_corruption() {
        // Inject only the error enum; never exhaust physical memory in tests.
        let error = materialization_error(mdbn_wire::cbor::CborError::TooLong);
        assert_eq!(error.reason.as_deref(), Some("cbor_alloc"));
        assert!(is_resource_refusal(&error));
        assert!(is_resource_refusal(&schema_materialization_error(
            mdbn_wire::schema::SchemaError::Cbor(mdbn_wire::cbor::CborError::TooLong)
        )));
        assert!(!is_resource_refusal(&materialization_error(
            mdbn_wire::cbor::CborError::UnexpectedEnd
        )));
        assert!(!is_resource_refusal(&ServiceError::invalid("cbor_shape")));
        assert!(!is_resource_refusal(&ServiceError::reason(
            Code::Forbidden,
            "cbor_alloc"
        )));
    }
    #[test]
    fn huge_container_rejected_at_head_without_materializing_nodes() {
        let mut bytes = vec![0x9a, 0, 0x60, 0, 0];
        bytes.resize(5 + 6 * 1024 * 1024, 0xf6);
        let e = preflight(&bytes).unwrap_err();
        assert_eq!(e.reason, "cbor_nodes");
        assert_eq!(e.stats.nodes, 1);
    }
    #[test]
    fn global_budget_not_merely_per_container() {
        let mut bytes = vec![0x82, 0x99, 0x08, 0];
        bytes.resize(bytes.len() + 2048, 0xf6);
        bytes.extend([0x99, 0x08, 0]);
        bytes.resize(bytes.len() + 2048, 0xf6);
        let e = preflight(&bytes).unwrap_err();
        assert_eq!(e.reason, "cbor_nodes");
        assert!(e.stats.nodes <= MAX_NODES);
    }
    #[test]
    fn bytecap_map_keys_and_nested_opaque_decode_boundaries() {
        let large = vec![0; MAX_BYTES + 1];
        let e = preflight(&large).unwrap_err();
        assert_eq!(e.reason, "cbor_bytes");
        assert_eq!(e.stats.nodes, 0);
        // A map counts both key and value, not just entries.
        let mut map = vec![0xb9, 0x08, 0];
        map.resize(3 + 4096, 0xf6);
        assert_eq!(preflight(&map).unwrap_err().reason, "cbor_nodes");
        let mut inner = vec![0x9a, 0, 0x60, 0, 0];
        inner.resize(5 + 6 * 1024 * 1024, 0xf6);
        let wrapped =
            mdbn_wire::cbor::encode(&mdbn_wire::cbor::Cbor::Bytes(inner.clone())).unwrap();
        assert_eq!(preflight(&wrapped).unwrap().nodes, 1);
        let mdbn_wire::cbor::Cbor::Bytes(actual) = raw(&wrapped).unwrap() else {
            panic!("bytes");
        };
        assert_eq!(preflight(&actual).unwrap_err().reason, "cbor_nodes");
    }
    #[test]
    fn inclusive_nodes_depth_and_bytes_are_bounded() {
        let mut bytes = vec![0x99, 0x0f, 0xff];
        bytes.resize(3 + 4095, 0xf6);
        assert_eq!(preflight(&bytes).unwrap().nodes, 4096);
        bytes[2] = 0;
        assert!(preflight(&bytes).is_err());
        let mut deep = vec![0x81; MAX_DEPTH];
        deep.push(0xf6);
        assert_eq!(preflight(&deep).unwrap().depth, MAX_DEPTH);
        deep.insert(0, 0x81);
        assert_eq!(preflight(&deep).unwrap_err().reason, "cbor_depth");
        let raw = [0x43, 0xff, 0xff, 0xff];
        assert_eq!(preflight(&raw).unwrap().nodes, 1);
        assert!(preflight(&[]).is_err());
        assert!(preflight(&[0xf6, 0xf6]).is_err());
    }
}
