//! A bounded whole-namespace path resolver, processed page by page.
//!
//! [`crate::preflight::resolve`] holds every path of a collection at once. The hosted
//! Worker cannot: a request hydrates at most 1,000 rows and 1 MiB
//! ([`crate::budget`]), and collection-wide maps are not exempt from the working-set
//! limit. [`Namespace`] makes **exactly the same decisions** as `resolve`, while
//! holding only one page: the set of claimed names lives in a host-provided
//! [`Claims`] spill (the Durable Object's SQLite in the Worker, a set in tests),
//! keyed by a domain-separated hash of the path key, so no path text is spilled.
//!
//! ## Order, and why it reproduces `resolve`
//!
//! `resolve` hands out names to claimants in one deterministic order: every
//! portable path first, in entity order (resources by path, then records by ID,
//! then files by ID), then every non-portable path in the same entity order, each
//! taking the first free name (` (n)` suffix on a path-key collision). The
//! streaming resolver walks the same order in two passes over the consistent read:
//!
//! 1. **Portable pass.** [`Namespace::resources`] (all resources in one bounded
//!    window, sorted here), then [`Namespace::records`] and [`Namespace::files`] pages
//!    in strictly ascending ID order (the legacy source's primary-key order). A
//!    portable path claims its name, or the first free suffixed name (reported as a
//!    `collision` rename). A non-portable path is **deferred**: returned to the host,
//!    which keeps it (identity and original path only) for the second pass.
//! 2. **Deferred pass.** [`Namespace::deferred`] takes the deferred entities back in
//!    entity order; each is renamed with [`crate::preflight::portable_name`] and
//!    takes the first free name.
//!
//! Out-of-order input is refused, never silently reordered. A name that cannot be
//! made portable is reported as unfixable; [`Namespace::finish`] then refuses the
//! collection (the host holds the complete list), exactly where `resolve` returns
//! the full report.
//!
//! Every output is per page: renames (to persist and report), deferred entities (to
//! keep for pass 2) and unfixable entities (to report). Nothing grows with the
//! collection except the spill and the counters.

use std::fmt;

use mdbn_core::paths::{check_path, path_key, suffixed};
use mdbn_wire::common::Hash;

use crate::budget::{MAX_HYDRATE_BYTES, MAX_HYDRATE_RECORDS};
use crate::preflight::{EntityKind, InvalidPath, PathEntity, Rename, inside_tool_folder};
use crate::rows::{FileRow, RecordRow, ResourceRow};
use crate::{Error, Result};

/// The spilled set of names already handed out in one resolve, keyed by
/// [`claim_key`]. Must start empty for each resolve (a new consistent read).
pub trait Claims {
    /// Whether `key` has been claimed.
    fn is_claimed(&mut self, key: &Hash) -> std::result::Result<bool, String>;
    /// Claim `key`. Never called for a key already claimed.
    fn claim(&mut self, key: &Hash) -> std::result::Result<(), String>;
}

/// An in-memory [`Claims`], for native callers and tests.
impl Claims for std::collections::BTreeSet<Hash> {
    fn is_claimed(&mut self, key: &Hash) -> std::result::Result<bool, String> {
        Ok(self.contains(key))
    }
    fn claim(&mut self, key: &Hash) -> std::result::Result<(), String> {
        self.insert(*key);
        Ok(())
    }
}

/// The spill key of `path`: a domain-separated hash of its path key (NFC, case
/// folded), so two paths collide exactly when `mdbn_core::paths::path_key` says so.
pub fn claim_key(path: &str) -> Hash {
    mdbn_wire::hash::h("mdbase/v1/migrate/path-claim", path_key(path).as_bytes())
}

/// What one page produced. Every vector is bounded by the page.
#[derive(Debug, Default)]
pub struct Step {
    /// Renames made by this page, in entity order. Persist (the import uses the new
    /// path) and report each one.
    pub renames: Vec<Rename>,
    /// Non-portable entities to hand back to [`Namespace::deferred`] in pass 2, in
    /// entity order. Identity and original path only.
    pub deferred: Vec<PathEntity>,
    /// Entities whose name cannot be made portable at all. Report each one; the
    /// collection cannot be imported ([`Namespace::finish`] refuses it).
    pub unfixable: Vec<InvalidPath>,
}

/// Totals of one resolve. Counts only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    /// Entities placed (kept or renamed).
    pub placed: u64,
    /// Of which renamed.
    pub renamed: u64,
    /// Entities deferred to pass 2.
    pub deferred: u64,
    /// Entities that cannot be made portable.
    pub unfixable: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Resources,
    Records,
    Files,
    Deferred,
}

/// The bounded, two-pass whole-namespace resolver. See the module docs.
pub struct Namespace {
    phase: Phase,
    /// The last entity seen in the current pass, for the order check.
    last: Option<PathEntity>,
    /// Deferred entities announced in pass 1 and not yet seen in pass 2.
    outstanding: u64,
    summary: Summary,
}

impl fmt::Debug for Namespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Namespace")
            .field("phase", &self.phase)
            .field("summary", &self.summary)
            .finish_non_exhaustive()
    }
}

impl Default for Namespace {
    fn default() -> Self {
        Self::new()
    }
}

impl Namespace {
    /// A resolver. Every call takes the same `claims` spill, empty at the start.
    pub fn new() -> Self {
        Self {
            phase: Phase::Resources,
            last: None,
            outstanding: 0,
            summary: Summary::default(),
        }
    }

    /// Totals so far.
    pub fn summary(&self) -> Summary {
        self.summary
    }

    /// Pass 1, first window: **every** resource of the read, in any order, at most
    /// one request's worth (1,000 rows, 1 MiB of paths). Call exactly once, first
    /// (with an empty slice if there are none).
    pub fn resources(&mut self, claims: &mut dyn Claims, rows: &[ResourceRow]) -> Result<Step> {
        self.enter(Phase::Resources, Phase::Resources)?;
        check_page(rows.len(), rows.iter().map(|r| r.path.len()).sum())?;
        let mut entities: Vec<PathEntity> = rows
            .iter()
            .map(|r| PathEntity {
                kind: EntityKind::Resource,
                id: None,
                path: r.path.clone(),
            })
            .collect();
        entities.sort();
        if entities.windows(2).any(|w| w[0] == w[1]) {
            return Err(Error::Invalid("duplicate resource path".into()));
        }
        let step = self.portable_pass(claims, entities)?;
        self.phase = Phase::Records;
        self.last = None;
        Ok(step)
    }

    /// Pass 1: one page of records, strictly ascending by ID, continuing any earlier
    /// record page.
    pub fn records(&mut self, claims: &mut dyn Claims, rows: &[RecordRow]) -> Result<Step> {
        self.enter(Phase::Records, Phase::Records)?;
        check_page(rows.len(), rows.iter().map(|r| r.path.len()).sum())?;
        let entities = rows
            .iter()
            .map(|r| PathEntity {
                kind: EntityKind::Record,
                id: Some(r.record_id.clone()),
                path: r.path.clone(),
            })
            .collect();
        self.portable_pass(claims, entities)
    }

    /// Pass 1: one page of files, strictly ascending by ID. Ends the record pages.
    pub fn files(&mut self, claims: &mut dyn Claims, rows: &[FileRow]) -> Result<Step> {
        if self.phase == Phase::Records {
            self.phase = Phase::Files;
        }
        self.enter(Phase::Files, Phase::Files)?;
        check_page(rows.len(), rows.iter().map(|r| r.path.len()).sum())?;
        let entities = rows
            .iter()
            .map(|r| PathEntity {
                kind: EntityKind::File,
                id: Some(r.file_id.clone()),
                path: r.path.clone(),
            })
            .collect();
        self.portable_pass(claims, entities)
    }

    /// Pass 2: one page of the entities deferred in pass 1, strictly ascending in
    /// entity order (kind, ID, path), continuing any earlier deferred page. Ends
    /// pass 1. Every deferred entity must come back exactly once.
    pub fn deferred(&mut self, claims: &mut dyn Claims, rows: &[PathEntity]) -> Result<Step> {
        if self.phase < Phase::Deferred {
            self.phase = Phase::Deferred;
            self.last = None;
        }
        self.enter(Phase::Deferred, Phase::Deferred)?;
        check_page(rows.len(), rows.iter().map(|r| r.path.len()).sum())?;
        let mut step = Step::default();
        for e in rows {
            self.ascending(e)?;
            let Err(violation) = check_path(&e.path) else {
                return Err(Error::Invalid(
                    "a portable path was handed back as deferred".into(),
                ));
            };
            if self.outstanding == 0 {
                return Err(Error::Invalid(
                    "more deferred entities than deferred".into(),
                ));
            }
            self.outstanding -= 1;
            let Some(candidate) = crate::preflight::portable_name(&e.path) else {
                self.unfixable(&mut step, e, violation);
                continue;
            };
            let to = Self::first_free(claims, &candidate)?;
            if let Err(v) = check_path(&to) {
                self.unfixable(&mut step, e, v);
                continue;
            }
            claims.claim(&claim_key(&to)).map_err(spill)?;
            self.summary.placed += 1;
            self.summary.renamed += 1;
            step.renames.push(Rename {
                entity: e.clone(),
                to,
                reason: violation.reason(),
                tool_folder: inside_tool_folder(&e.path),
            });
        }
        Ok(step)
    }

    /// End the resolve. Refuses if any entity was unfixable or a deferred entity
    /// never came back; otherwise the totals.
    pub fn finish(mut self) -> Result<Summary> {
        if self.phase < Phase::Deferred {
            self.phase = Phase::Deferred;
        }
        if self.outstanding != 0 {
            return Err(Error::Invalid(format!(
                "{} deferred entities were not resolved",
                self.outstanding
            )));
        }
        if self.summary.unfixable != 0 {
            return Err(Error::Invalid(format!(
                "{} paths cannot be made portable",
                self.summary.unfixable
            )));
        }
        Ok(self.summary)
    }

    fn enter(&mut self, from: Phase, to: Phase) -> Result<()> {
        if self.phase < from || self.phase > to {
            return Err(Error::Invalid(format!(
                "namespace pages out of order: {:?} after {:?}",
                to, self.phase
            )));
        }
        Ok(())
    }

    fn ascending(&mut self, e: &PathEntity) -> Result<()> {
        if self.last.as_ref().is_some_and(|last| last >= e) {
            return Err(Error::Invalid(
                "namespace rows are not strictly ascending".into(),
            ));
        }
        self.last = Some(e.clone());
        Ok(())
    }

    fn portable_pass(
        &mut self,
        claims: &mut dyn Claims,
        entities: Vec<PathEntity>,
    ) -> Result<Step> {
        let mut step = Step::default();
        for e in entities {
            self.ascending(&e)?;
            if check_path(&e.path).is_err() {
                self.outstanding += 1;
                self.summary.deferred += 1;
                step.deferred.push(e);
                continue;
            }
            let to = Self::first_free(claims, &e.path)?;
            if let Err(v) = check_path(&to) {
                self.unfixable(&mut step, &e, v);
                continue;
            }
            claims.claim(&claim_key(&to)).map_err(spill)?;
            self.summary.placed += 1;
            if to != e.path {
                self.summary.renamed += 1;
                step.renames.push(Rename {
                    tool_folder: inside_tool_folder(&e.path),
                    entity: e,
                    to,
                    reason: "collision",
                });
            }
        }
        Ok(step)
    }

    /// `mdbn_core::paths::allocate_path` against the spilled claims.
    fn first_free(claims: &mut dyn Claims, requested: &str) -> Result<String> {
        if !claims.is_claimed(&claim_key(requested)).map_err(spill)? {
            return Ok(requested.to_owned());
        }
        let mut n = 2u64;
        loop {
            let candidate = suffixed(requested, n);
            if !claims.is_claimed(&claim_key(&candidate)).map_err(spill)? {
                return Ok(candidate);
            }
            n += 1;
        }
    }

    fn unfixable(
        &mut self,
        step: &mut Step,
        e: &PathEntity,
        violation: mdbn_core::paths::PathViolation,
    ) {
        self.summary.unfixable += 1;
        step.unfixable.push(InvalidPath {
            entity: e.clone(),
            violation,
        });
    }
}

fn check_page(rows: usize, path_bytes: usize) -> Result<()> {
    if rows > MAX_HYDRATE_RECORDS || path_bytes > MAX_HYDRATE_BYTES {
        return Err(Error::Invalid(format!(
            "namespace page over budget: {rows} rows, {path_bytes} path bytes"
        )));
    }
    Ok(())
}

fn spill(e: String) -> Error {
    Error::Invalid(format!("namespace spill: {e}"))
}

#[cfg(test)]
#[path = "namespace_tests.rs"]
mod tests;
