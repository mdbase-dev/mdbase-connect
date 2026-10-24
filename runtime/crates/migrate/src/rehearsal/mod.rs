//! The LAB rehearsal harness (migration rehearsal, release gate 2).
//!
//! - [`shape`]: deterministic **synthetic, real-shaped** collections. The record mix,
//!   document sizes and task properties follow Connect's hosted-storage benchmark
//!   fixtures (`docs/benchmarks/hosted-storage-model/fixtures/*/fixture-manifest.json`,
//!   which are themselves "deterministic synthetic content only; never derived from
//!   production data"). Attachments include multi-part (> 8 MiB) files. **No production
//!   data, and nothing from a developer's own vaults.**
//! - [`ledger`]: the write ledger. Every scenario driver appends one row per write it
//!   was told succeeded (acknowledged), and one per local edit that must survive
//!   (un-uploaded mirror edits).
//! - [`oracle`]: the gate-2 check. Every acknowledged write is visible, superseded by a
//!   later acknowledged write, or kept in a hold or conflict. Every must-survive edit
//!   is present somewhere. **Gate 2 is green only on zero violations.**
//!
//! Scenario runbooks (R1–R10) drive LAB through the `mdbase-lab` skill and its
//! `mdbase-env lab` front door only. The harness here never talks to LAB itself:
//! drivers do, and they record into the ledger.
//!
//! Synthetic writers use dedicated frontmatter fields `rh_<writer>_<n>: "<value>"`, so
//! "the latest acknowledged value" is well defined per (record, field), and the oracle
//! can read the final state from plain files.

pub mod ledger;
pub mod oracle;
pub mod shape;
