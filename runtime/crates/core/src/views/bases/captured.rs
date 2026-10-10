//! Bounded captured file/link primitives ported from mdbase-rs expression.rs.
//! No filesystem, guessed resolution, ambient stat/clock or display-unavailable
//! expression value. Captures are data, not read/execute authority.

use super::{BasesTimezone, DateValue, EvaluationFailure, WorkBudget};

/// Maximum bytes in each captured path, link target, alias, tag or folder.
pub const MAX_CAPTURE_TEXT_BYTES: usize = 4096;
/// Maximum items admitted to a captured tag predicate.
pub const MAX_CAPTURE_ITEMS: usize = 4096;

/// Captured link resolution. Unavailable is not the same as a known broken link.
#[derive(Clone, Copy, Debug)]
pub enum LinkResolution<'a> {
    /// This query lacks a captured resolver result.
    Unavailable,
    /// Resolver was consulted in the captured namespace and found no target.
    Unresolved,
    /// Exact path in that captured namespace; not a new authorization grant.
    Resolved(&'a str),
}

/// Typed target/display/resolution retained until explicit rendering.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedLink {
    path: String,
    display: Option<String>,
    resolved: Option<Option<String>>,
    external: bool,
}
impl CapturedLink {
    /// Capture already-extracted target/alias, preserving exact bytes and order.
    /// Used for frontmatter/body link descriptors, not Markdown extraction.
    pub fn from_parts(
        path: &str,
        display: Option<&str>,
        resolution: LinkResolution<'_>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        text(path, budget)?;
        if let Some(display) = display {
            text(display, budget)?;
        }
        let resolved = match resolution {
            LinkResolution::Unavailable => None,
            LinkResolution::Unresolved => Some(None),
            LinkResolution::Resolved(path) => {
                file_path(path, budget)?;
                Some(Some(path.to_owned()))
            }
        };
        charge(budget, 1, 128)?;
        Ok(Self {
            path: path.to_owned(),
            display: display.map(str::to_owned),
            resolved,
            external: external(path),
        })
    }

    /// Legacy link() target syntax: optional !/[[...]] wrapper and first pipe.
    /// A separately supplied display overrides a parsed alias. This is not a
    /// full Markdown link parser or a resolver.
    pub fn parse(
        source: &str,
        display: Option<&str>,
        resolution: LinkResolution<'_>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        text(source, budget)?;
        if source.trim_matches(|c: char| c.is_ascii_whitespace()) != source.trim() {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("link_unicode_trim"),
            );
        }
        let value = source.trim().strip_prefix('!').unwrap_or(source.trim());
        if value.trim_matches(|c: char| c.is_ascii_whitespace()) != value.trim() {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("link_unicode_trim"),
            );
        }
        let value = value.trim();
        let value = value
            .strip_prefix("[[")
            .and_then(|value| value.strip_suffix("]]"))
            .unwrap_or(value);
        let (target, parsed_display) = value
            .split_once('|')
            .map(|(p, d)| (p, Some(d)))
            .unwrap_or((value, None));
        Self::from_parts(target, display.or(parsed_display), resolution, budget)
    }
    /// Raw target used by the public Core/plain boundary and string methods.
    pub fn path(&self) -> &str {
        &self.path
    }
    /// Extracted/explicit alias, never inferred from a local filesystem.
    pub fn display(&self) -> Option<&str> {
        self.display.as_deref()
    }
    /// Legacy ASCII URI-scheme recognition; no network access.
    pub fn is_external(&self) -> bool {
        self.external
    }
    /// Exact resolver result; unavailable refuses out-of-band, broken is None.
    pub fn resolved_path(
        &self,
        budget: &mut WorkBudget,
    ) -> Result<Option<&str>, EvaluationFailure> {
        charge(budget, 1, 0)?;
        match &self.resolved {
            None => fail(
                budget,
                EvaluationFailure::MetadataUnavailable("link_resolution"),
            ),
            Some(path) => Ok(path.as_deref()),
        }
    }
    /// Ported plain_string(Link), distinct from raw-target to_plain(Link).
    pub fn render(&self, budget: &mut WorkBudget) -> Result<String, EvaluationFailure> {
        let len = self
            .path
            .len()
            .saturating_add(self.display.as_ref().map_or(0, |s| s.len() + 1))
            .saturating_add(4);
        charge(
            budget,
            1,
            u64::try_from(len).unwrap_or(u64::MAX).saturating_mul(6),
        )?;
        Ok(if self.external {
            self.path.clone()
        } else if let Some(display) = &self.display {
            format!("[[{}|{display}]]", self.path)
        } else {
            format!("[[{}]]", self.path)
        })
    }
    /// Captured equivalent of the port's direct Link/Link identity comparison.
    /// Broken links retain target identity (minus subpath), not plausible files.
    pub fn equals(&self, rhs: &Self, budget: &mut WorkBudget) -> Result<bool, EvaluationFailure> {
        let a = self
            .resolved_path(budget)?
            .unwrap_or_else(|| base(&self.path));
        let b = rhs
            .resolved_path(budget)?
            .unwrap_or_else(|| base(&rhs.path));
        Ok(a == b)
    }
    /// Ported hasLink matching: exact raw target first (even broken), then exact
    /// captured resolved paths; no guessed case/path/extension resolution.
    pub fn matches(&self, rhs: &Self, budget: &mut WorkBudget) -> Result<bool, EvaluationFailure> {
        charge(budget, 1, 0)?;
        if self.path == rhs.path {
            return Ok(true);
        }
        let a = self.resolved_path(budget)?;
        let b = rhs.resolved_path(budget)?;
        Ok(matches!((a,b), (Some(a),Some(b)) if a==b))
    }
}

/// Documented cross-device creation observation, never Unix status-change time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreationObservation {
    /// Timestamp of the record's first create-log entry, milliseconds.
    FirstCreateLog(i64),
    /// Original filesystem birthtime carried on the import, milliseconds.
    ImportedBirth(i64),
}

/// Immutable captured file identity and optional facts. Raw properties/tags and
/// link namespace live in the subsequent row adapter, not an effective overlay.
#[derive(Clone, Debug)]
pub struct CapturedFile {
    path: String,
    name: String,
    basename: String,
    folder: String,
    ext: String,
    size: Option<u64>,
    created: Option<CreationObservation>,
    modified: Option<i64>,
}
impl CapturedFile {
    /// Capture collection-relative identity plus explicitly observed facts.
    pub fn new(
        path: &str,
        size: Option<u64>,
        created: Option<CreationObservation>,
        modified: Option<i64>,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        file_path(path, budget)?;
        if size.is_some_and(|n| n > 9_007_199_254_740_991) {
            return fail(
                budget,
                EvaluationFailure::UnsupportedConstruct("file_size_precision"),
            );
        }
        charge(
            budget,
            1,
            u64::try_from(path.len())
                .unwrap_or(u64::MAX)
                .saturating_mul(5)
                .saturating_add(256),
        )?;
        let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
        let (basename, ext) = name.rsplit_once('.').unwrap_or((name, ""));
        Ok(Self {
            path: path.into(),
            name: name.into(),
            basename: basename.into(),
            folder: folder.into(),
            ext: ext.into(),
            size,
            created,
            modified,
        })
    }
    /// As-written captured collection path.
    pub fn path(&self) -> &str {
        &self.path
    }
    /// Filename including extension (not Bases file.name).
    pub fn filename(&self) -> &str {
        &self.name
    }
    /// Bases file.name and file.basename both return this basename.
    pub fn basename(&self) -> &str {
        &self.basename
    }
    /// Captured parent folder, empty for a root file.
    pub fn folder(&self) -> &str {
        &self.folder
    }
    /// Last extension without a dot, empty when absent.
    pub fn extension(&self) -> &str {
        &self.ext
    }
    /// Exact binary64-safe observed byte size; no absent-stat zero fallback.
    pub fn size(&self, budget: &mut WorkBudget) -> Result<u64, EvaluationFailure> {
        charge(budget, 1, 0)?;
        self.size.ok_or_else(|| {
            let e = EvaluationFailure::MetadataUnavailable("file_size");
            budget.fail(e);
            e
        })
    }
    /// Creation timestamp under a captured zone; no status-change/epoch fallback.
    pub fn created(
        &self,
        zone: BasesTimezone,
        budget: &mut WorkBudget,
    ) -> Result<DateValue, EvaluationFailure> {
        let ms = match self.created {
            Some(
                CreationObservation::FirstCreateLog(ms) | CreationObservation::ImportedBirth(ms),
            ) => ms,
            None => return fail(budget, EvaluationFailure::MetadataUnavailable("file_ctime")),
        };
        DateValue::from_millis(ms, false, zone, budget)
    }
    /// Captured mtime, unavailable where not observed.
    pub fn modified(
        &self,
        zone: BasesTimezone,
        budget: &mut WorkBudget,
    ) -> Result<DateValue, EvaluationFailure> {
        let Some(ms) = self.modified else {
            return fail(budget, EvaluationFailure::MetadataUnavailable("file_mtime"));
        };
        DateValue::from_millis(ms, false, zone, budget)
    }
    /// File.asLink preserves this exact path and an explicit optional display.
    pub fn as_link(
        &self,
        display: Option<&str>,
        budget: &mut WorkBudget,
    ) -> Result<CapturedLink, EvaluationFailure> {
        CapturedLink::from_parts(
            &self.path,
            display,
            LinkResolution::Resolved(&self.path),
            budget,
        )
    }
    /// Ported folder predicate, including slash-boundary and root semantics.
    pub fn in_folder(
        &self,
        folder: &str,
        budget: &mut WorkBudget,
    ) -> Result<bool, EvaluationFailure> {
        text(folder, budget)?;
        let folder = folder.trim_end_matches('/');
        Ok(self.folder == folder
            || self
                .folder
                .strip_prefix(folder)
                .is_some_and(|s| s.starts_with('/')))
    }
    /// Ported tag predicate over explicitly captured tags. No body extraction.
    pub fn has_tag(
        tags: &[String],
        needles: &[String],
        budget: &mut WorkBudget,
    ) -> Result<bool, EvaluationFailure> {
        charge(budget, 1, 0)?;
        if tags.len() > MAX_CAPTURE_ITEMS || needles.len() > MAX_CAPTURE_ITEMS {
            return fail(budget, EvaluationFailure::BudgetExceeded("capture_items"));
        }
        for needle in needles {
            text(needle, budget)?;
            let needle = needle.trim_start_matches('#');
            for tag in tags {
                text(tag, budget)?;
                let tag = tag.trim_start_matches('#');
                if tag == needle || tag.strip_prefix(needle).is_some_and(|s| s.starts_with('/')) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

fn base(path: &str) -> &str {
    path.split_once('#').map_or(path, |(p, _)| p)
}
fn external(path: &str) -> bool {
    let Some((scheme, _)) = path.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|c| c.is_ascii_alphabetic())
        && bytes.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
}
fn file_path(path: &str, budget: &mut WorkBudget) -> Result<(), EvaluationFailure> {
    text(path, budget)?;
    if crate::paths::check_path(path).is_err() {
        return fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("captured_file_path"),
        );
    }
    Ok(())
}
fn text(value: &str, budget: &mut WorkBudget) -> Result<(), EvaluationFailure> {
    if value.len() > MAX_CAPTURE_TEXT_BYTES {
        return fail(
            budget,
            EvaluationFailure::BudgetExceeded("capture_text_bytes"),
        );
    }
    charge(
        budget,
        1,
        u64::try_from(value.len())
            .unwrap_or(u64::MAX)
            .saturating_mul(6),
    )
}
fn charge(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("failed capture meter"))
    }
}
fn fail<T>(budget: &mut WorkBudget, failure: EvaluationFailure) -> Result<T, EvaluationFailure> {
    budget.fail(failure);
    Err(budget.failure().expect("sticky capture failure"))
}

#[cfg(test)]
mod tests;
