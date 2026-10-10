//! Bounded independent request windows; never a cross-request cursor/lease.
use super::*;
/// Requested global typed-sort window. A request still scans all semantic keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BasesExecutionWindow {
    /// Global sorted row offset; uint32, including offsets past the final row.
    pub offset: u32,
    /// Requested row count, 1..=65536; the existing full-profile cap is unchanged.
    pub limit: u32,
}
impl BasesExecutionWindow {
    pub(super) fn check(self) -> ApiResult<()> {
        if self.limit == 0 || self.limit > 65_536 {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_bases_window", "invalid bounded Bases window"));
        }
        Ok(())
    }
}
/// Placement aligned one-to-one with the returned visible groups.
pub struct BasesGroupPlacement {
    /// Ordinal in the whole view's typed group order, not an invented label.
    pub ordinal: u32,
    /// Exact matching rows in that whole group, bounded by total<=65536.
    pub total_rows: u32,
    /// Each returned group row's ordinal inside its whole sorted group.
    pub row_ordinals: Vec<u32>,
}
/// Explicit window metadata; None preserves the existing complete success shape.
pub struct BasesWindowInfo {
    /// Exactly echoed request, not a silently clamped offset or limit.
    pub request: BasesExecutionWindow,
    /// Complete matching count, bounded by the unchanged 65536 profile cap.
    pub total_rows: u32,
    /// Placement aligned with result.groups; absent for ungrouped views.
    pub groups: Vec<BasesGroupPlacement>,
}
/// Trusted native read producer inputs, not a caller source/clock/authority.
pub struct BasesReadRequest<'a> {
    /// Exact record/source/ordinal selection.
    pub selection: BasesViewSelection,
    /// Strict captured property registry inputs.
    pub property_types: &'a BTreeMap<String, String>,
    /// Capture zone; the instant is always captured by the actor.
    pub timezone: &'a str,
    /// Optional independent requested display window; absent means full result.
    pub window: Option<BasesExecutionWindow>,
}
