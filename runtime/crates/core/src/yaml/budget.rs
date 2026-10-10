//! Fixed, portable frontmatter structure/admission limits. Accounting is a
//! conservative parser allocation estimate, not an allocator/aggregate heap meter.
use crate::value::Value;

/// Maximum composed values, including collection nodes and string mapping keys.
pub const MAX_VALUES: u64 = 65_536;
/// Maximum value depth; the root has depth one.
pub const MAX_DEPTH: u32 = 32;
/// Maximum UTF-8 bytes in any decoded scalar/key/property token.
pub const MAX_STRING_BYTES: usize = 64 * 1024;
/// Maximum conservative cumulative parsed allocation estimate.
pub const MAX_ESTIMATED_HEAP_BYTES: u64 = 16 * 1024 * 1024;

/// Which immutable frontmatter limit refused the parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Composed values, including expanded aliases and mapping keys.
    Values,
    /// Value nesting, including expanded aliases.
    Depth,
    /// Decoded UTF-8 scalar/key/property bytes.
    StringBytes,
    /// Conservative capacity/clone allocation estimate.
    EstimatedHeapBytes,
}
/// Typed outer refusal: never converted into invalid-frontmatter `{}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitExceeded {
    /// Limit dimension.
    pub kind: Kind,
    /// Requested total in that dimension.
    pub actual: u64,
    /// Immutable maximum.
    pub max: u64,
}
impl LimitExceeded {
    /// Stable caller-facing reason.
    pub const fn reason(&self) -> &'static str {
        "record_frontmatter_limit_exceeded"
    }
}
impl std::fmt::Display for LimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {:?} {} exceeds {}; move large content out of frontmatter or into an attachment",
            self.reason(),
            self.kind,
            self.actual,
            self.max
        )
    }
}
impl std::error::Error for LimitExceeded {}

/// Accounting report for one bounded parse; not resident/aggregate heap proof.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Footprint {
    /// Composed values including keys.
    pub values: u64,
    /// Maximum root-one value depth.
    pub depth: u32,
    /// Conservative cumulative syntax/value/anchor/document-map allocation cost.
    pub estimated_heap_bytes: u64,
}

pub(crate) struct Budget {
    pub(crate) footprint: Footprint,
    failure: Option<LimitExceeded>,
}
impl Budget {
    pub(crate) fn new() -> Self {
        Self {
            footprint: Footprint::default(),
            failure: None,
        }
    }
    pub(crate) fn failure(&self) -> Option<LimitExceeded> {
        self.failure
    }
    fn check(&mut self, kind: Kind, actual: u64, max: u64) -> Result<(), LimitExceeded> {
        if let Some(e) = self.failure {
            return Err(e);
        }
        if actual > max {
            let e = LimitExceeded { kind, actual, max };
            self.failure = Some(e);
            return Err(e);
        }
        Ok(())
    }
    pub(crate) fn depth(&mut self, depth: u32) -> Result<(), LimitExceeded> {
        self.check(Kind::Depth, u64::from(depth), u64::from(MAX_DEPTH))?;
        self.footprint.depth = self.footprint.depth.max(depth);
        Ok(())
    }
    pub(crate) fn values(&mut self, n: u64) -> Result<(), LimitExceeded> {
        let next = self.footprint.values.saturating_add(n);
        self.check(Kind::Values, next, MAX_VALUES)?;
        self.footprint.values = next;
        Ok(())
    }
    pub(crate) fn string(&mut self, bytes: usize) -> Result<(), LimitExceeded> {
        self.check(Kind::StringBytes, bytes as u64, MAX_STRING_BYTES as u64)
    }
    pub(crate) fn heap(&mut self, bytes: u64) -> Result<(), LimitExceeded> {
        let next = self.footprint.estimated_heap_bytes.saturating_add(bytes);
        self.check(Kind::EstimatedHeapBytes, next, MAX_ESTIMATED_HEAP_BYTES)?;
        self.footprint.estimated_heap_bytes = next;
        Ok(())
    }
    pub(crate) fn owned_string(&mut self, bytes: usize) -> Result<(), LimitExceeded> {
        self.string(bytes)?;
        self.heap(bytes as u64)
    }
    // Exact reserve prevents implicit unmetered geometric growth. The estimate
    // uses fixed 64-bit upper slot sizes, not target-dependent size_of costs.
    pub(crate) fn reserve_string(
        &mut self,
        out: &mut String,
        additional: usize,
    ) -> Result<(), LimitExceeded> {
        let need = out.len().saturating_add(additional);
        self.string(need)?;
        if need > out.capacity() {
            let capacity = need
                .max(out.capacity().saturating_mul(2))
                .clamp(8, MAX_STRING_BYTES);
            self.heap((capacity - out.capacity()) as u64)?;
            out.reserve_exact(capacity - out.len());
        }
        Ok(())
    }
    pub(crate) fn reserve_vec<T>(
        &mut self,
        out: &mut Vec<T>,
        slot_bytes: u64,
    ) -> Result<(), LimitExceeded> {
        if out.len() == out.capacity() {
            let capacity = out.capacity().saturating_mul(2).max(4);
            self.heap((capacity - out.capacity()) as u64 * slot_bytes)?;
            out.reserve_exact(capacity - out.len());
        }
        Ok(())
    }
    /// Preflight an existing bounded value BEFORE cloning an anchor/map subtree.
    pub(crate) fn copy_value(
        &mut self,
        value: &Value,
        at_depth: u32,
        count_values: bool,
    ) -> Result<(), LimitExceeded> {
        let cost = value_cost(value);
        self.depth(at_depth.saturating_add(cost.depth.saturating_sub(1)))?;
        if count_values {
            self.values(cost.values)?;
        }
        self.heap(cost.estimated_heap_bytes)
    }
}
/// Fixed conservative model for a Value clone, including both insertion-order
/// entries and BTreeMap key/index storage. Existing trees are already depth-bound.
pub(crate) fn value_cost(value: &Value) -> Footprint {
    let mut out = Footprint {
        values: 1,
        depth: 1,
        estimated_heap_bytes: 0,
    };
    match value {
        Value::Text(s) => out.estimated_heap_bytes = s.len() as u64,
        Value::List(items) => {
            out.estimated_heap_bytes = items.len() as u64 * 64;
            for v in items {
                add_child(&mut out, value_cost(v));
            }
        }
        Value::Map(map) => {
            // Covers vector growth and even a sparsely occupied BTreeMap node
            // per entry, plus duplicate key text; intentionally conservative.
            out.estimated_heap_bytes = map.len() as u64 * 768;
            for (key, v) in map.iter() {
                out.values = out.values.saturating_add(1);
                out.depth = out.depth.max(2);
                out.estimated_heap_bytes = out
                    .estimated_heap_bytes
                    .saturating_add(key.len() as u64 * 2);
                add_child(&mut out, value_cost(v));
            }
        }
        _ => {}
    }
    out
}
fn add_child(out: &mut Footprint, child: Footprint) {
    out.values = out.values.saturating_add(child.values);
    out.depth = out.depth.max(child.depth.saturating_add(1));
    out.estimated_heap_bytes = out
        .estimated_heap_bytes
        .saturating_add(child.estimated_heap_bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn value_count_boundary_and_first_failure_are_sticky() {
        let mut b = Budget::new();
        b.values(MAX_VALUES).unwrap();
        let e = b.values(1).unwrap_err();
        assert_eq!(
            e,
            LimitExceeded {
                kind: Kind::Values,
                actual: MAX_VALUES + 1,
                max: MAX_VALUES
            }
        );
        assert_eq!(b.heap(0).unwrap_err(), e);
        assert_eq!(b.depth(1).unwrap_err(), e);
        assert_eq!(b.footprint.values, MAX_VALUES);
    }
    #[test]
    fn expanded_alias_is_preflighted_before_clone_allocation() {
        let value = Value::List(vec![Value::Bool(true), Value::Bool(false)]);
        let mut b = Budget::new();
        b.values(MAX_VALUES - 1).unwrap();
        let before = b.footprint.estimated_heap_bytes;
        assert_eq!(
            b.copy_value(&value, 1, true).unwrap_err().kind,
            Kind::Values
        );
        assert_eq!(b.footprint.estimated_heap_bytes, before);
        assert_eq!(
            value,
            Value::List(vec![Value::Bool(true), Value::Bool(false)])
        );
    }
    #[test]
    fn capacity_models_cover_boolean_values_and_native_syntax_slots() {
        assert!(std::mem::size_of::<Value>() <= 64);
        assert!(std::mem::size_of::<crate::yaml::parse::Node>() <= 128);
        assert!(std::mem::size_of::<(crate::yaml::parse::Node, crate::yaml::parse::Node)>() <= 256);
        let value = Value::List(vec![Value::Bool(true); 100]);
        assert_eq!(value_cost(&value).estimated_heap_bytes, 6400);
        assert!(
            value_cost(&value).estimated_heap_bytes >= (100 * std::mem::size_of::<Value>()) as u64
        );
    }
}
