//! The Bases dialect, ported from mdbase-rs's Rust implementation.
//!
//! [`Expression::parse`] recognizes legacy Bases syntax under fixed source,
//! token, node, parser-recursion and resulting-tree limits. It does not resolve
//! functions, validate capabilities, compile candidates or execute a view.
//! Syntax acceptance must never be advertised as semantic admission.
//! [`Program`] adds bounded, reachable-formula admission and the initial
//! primitive evaluator port. Date/file/link/context/regex capabilities visibly
//! refuse in that partial profile. It is not a complete saved-view executor.
//! Display-only unavailable cells belong to the later result adapter, not
//! ordinary expression Error/Null values.
//!
//! Port source: `mdbase-rs/src/views/expression.rs`, revision
//! `4eacd9ea9e81f00c86af88e2225723c31c4068bc` (MIT; see `LICENSE.port`).
//! Literal values use Core's JSON model rather than serde. No new dependencies,
//! ambient clock, regex engine or process-global cache are introduced.

mod budget;
mod source_tags;
pub use source_tags::{BASES_TAG_CAPTURE_VERSION, capture_source_tags};
mod captured;
mod date_value;
mod discovery;
mod duration;
mod duration_value;
mod eval;
mod execution;
mod streaming;
pub use streaming::{
    IncrementalBasesBudget, MAX_INCREMENTAL_OUTPUT_BYTES, MAX_INCREMENTAL_ROWS,
    MAX_INCREMENTAL_SOURCE_BYTES, MAX_INCREMENTAL_STEPS,
};
mod file_bindings;
mod filter;
mod numeric;
mod ordering;
mod program;
mod properties;
mod raw;
mod syntax;
mod temporal;
mod value;
pub(crate) mod witness;

pub use budget::{
    EvaluationFailure, MAX_ALLOCATION_BYTES, MAX_EVALUATION_DEPTH, MAX_VALUE_DEPTH, MAX_WORK_STEPS,
    WorkBudget,
};
pub use captured::{
    CapturedFile, CapturedLink, CreationObservation, LinkResolution, MAX_CAPTURE_ITEMS,
    MAX_CAPTURE_TEXT_BYTES,
};
pub use date_value::EvaluatedDate;
pub use discovery::{
    BASES_CONTRACT, BaseFields, BaseView, DiscoveredBase, MAX_BASE_IMPLEMENTATIONS,
    MAX_DISCOVERED_VIEWS, discover_base_record,
};
pub use duration::{DurationValue, MAX_DURATION_COMPONENT, MAX_DURATION_SOURCE_BYTES};
pub use duration_value::EvaluatedDuration;
pub use eval::Bindings;
pub use execution::{
    AdmittedBasesView, BasesCandidate, BasesCandidateAtom, BasesCandidateCompare, BasesDisplayCell,
    BasesProjectedRow, BasesProjectionRequirements, FileTimeAvailability,
    MAX_BASES_PROJECTION_FIELD_BYTES, MAX_BASES_PROJECTION_FIELDS, MAX_VIEW_COLUMNS,
};
pub use file_bindings::CapturedFileBindings;
pub use filter::{AdmittedBasesFilter, FilterAdmissionFailure};
pub use numeric::round_number;
pub use ordering::{
    DateGroupMode, MAX_ORDERED_ROWS, MAX_TYPED_GROUPS, NullOrder, OrderingCapture, StringOrder,
    TypedGroup, TypedSortRow, compare_typed, order_incremental_typed_rows, order_typed_rows,
    partition_incremental_typed, partition_incremental_typed_refs, partition_typed,
};
pub use program::{MAX_FORMULAS, MAX_PROGRAM_NODES, MAX_PROGRAM_SOURCE_BYTES, Profile, Program};
pub use properties::{
    MAX_PROPERTY_METADATA, MAX_PROPERTY_METADATA_BYTES, MAX_PROPERTY_SELECTOR_BYTES,
    MAX_SORT_TERMS, PropertySelector, SortDirection, SortTerm, decode_sort,
    normalize_property_metadata,
};
pub use raw::{
    CapturedPropertyTypes, MAX_PROPERTY_TYPE_HINT_BYTES, MAX_PROPERTY_TYPE_HINTS,
    MAX_RAW_RECORD_BYTES, RawFrontmatter,
};
pub use syntax::{Expr, Expression, Member};
pub use temporal::{
    BasesTimezone, CapturedClock, DateValue, MAX_DATE_PATTERN_BYTES, MAX_DATE_SOURCE_BYTES,
};
pub use value::RuntimeValue;

use std::fmt;

/// Maximum UTF-8 bytes in one Bases expression, checked before tokenization.
/// This is independent of the CEL and earlier TS-frontend admission profiles.
pub const MAX_SOURCE_BYTES: usize = 4_096;
/// Maximum lexical tokens, excluding the single EOF sentinel.
pub const MAX_TOKENS: usize = 2_048;
/// Maximum expression nodes allocated while parsing one expression.
pub const MAX_AST_NODES: usize = 1_024;
/// Maximum resulting AST depth, including left-associative and postfix chains.
pub const MAX_AST_DEPTH: usize = 32;
/// Maximum recursive parser calls, including parentheses without AST nodes.
pub const MAX_PARSE_DEPTH: usize = 32;

/// A fixed refusal class, independent of source text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    /// Malformed syntax, with a fixed diagnostic identifier.
    InvalidSource(&'static str),
    /// A syntactic construct outside this port slice's admitted representation.
    UnsupportedConstruct(&'static str),
    /// A fixed source/token/node/tree/recursion limit was exceeded.
    BudgetExceeded(&'static str),
    /// A reachable formula dependency cycle.
    FormulaCycle,
}

impl ErrorKind {
    /// Proposed view refusal code; no wire/receipt change is made here.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSource(_) => "view_invalid_source",
            Self::UnsupportedConstruct(_) => "view_unsupported_construct",
            Self::BudgetExceeded(_) => "query_budget_exceeded",
            Self::FormulaCycle => "view_formula_cycle",
        }
    }

    /// Safe diagnostic/construct identifier, never a user identifier or literal.
    pub fn detail(self) -> &'static str {
        match self {
            Self::InvalidSource(detail)
            | Self::UnsupportedConstruct(detail)
            | Self::BudgetExceeded(detail) => detail,
            Self::FormulaCycle => "formula_cycle",
        }
    }
}

/// A parsing refusal with a UTF-8 byte offset suitable for a local source span.
/// Display and Debug contain no user expression, literal or property name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    /// Fixed refusal class and diagnostic identifier.
    pub kind: ErrorKind,
    /// Zero-based UTF-8 byte offset; zero for the pre-tokenization source limit.
    pub offset: u32,
}

impl Error {
    fn new(kind: ErrorKind, offset: usize) -> Self {
        Self {
            kind,
            // Every lexer/parser offset is within the already bounded source.
            offset: u32::try_from(offset).expect("bounded Bases source offset"),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {} at byte {}",
            self.kind.code(),
            self.kind.detail(),
            self.offset
        )
    }
}

impl std::error::Error for Error {}
