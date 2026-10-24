//! Portable view semantics, separate from the CEL replay language.
//!
//! Bases is ported from mdbase-rs, not translated into CEL. Syntax parsing and
//! a bounded primitive evaluator profile are available; neither is a full
//! saved-view plan or a claim of pinned whole-view parity. Date/file/link
//! capabilities, source models and replica adapters follow in later slices.
//! No filesystem, clock, global cache, store or wire dependency belongs here.

pub mod bases;
