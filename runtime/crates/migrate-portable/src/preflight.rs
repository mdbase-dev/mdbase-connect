//! Legacy path preflight, before sealing or generation-0 import, and the decided
//! remediation: [`resolve`] renames every non-portable or colliding path to a portable,
//! unique one and reports each rename (decided 2026-10-04; never drop silently).
//!
//! [`inspect_paths`] itself never renames, normalizes or omits anything. It reports every
//! rejected path and every case-fold/NFC collision together, using the same policy as
//! the replica. Reports contain names for deliberate local review; their `Debug` and error
//! `Display` expose counts only. [`resolve`] is the only place paths change, and it changes
//! only the new system's copy: old rows are never written.

use std::collections::BTreeMap;
use std::fmt;

use mdbn_core::paths::{PathViolation, check_path, path_key};

use crate::rows::{FileRow, RecordRow, ResourceRow};
use crate::{Error, Result};

/// The kind of legacy entity whose path is being checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntityKind {
    /// A configuration, type, contract or other resource.
    Resource,
    /// A Markdown record.
    Record,
    /// A live attachment.
    File,
}

impl EntityKind {
    /// The kind as a report word.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resource => "resource",
            Self::Record => "record",
            Self::File => "file",
        }
    }
}

/// Identifies a row without copying its document, object key or attachment bytes.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PathEntity {
    /// Namespace of the source row.
    pub kind: EntityKind,
    /// Legacy record/file ID; resources are identified by path and have no ID.
    pub id: Option<String>,
    /// Original collection-relative name, never rewritten by preflight.
    pub path: String,
}

impl fmt::Debug for PathEntity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PathEntity")
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("path", &"[redacted]")
            .finish()
    }
}

/// A source row rejected by the portable path policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidPath {
    /// The original row identity and name.
    pub entity: PathEntity,
    /// The canonical core policy's reason; no duplicated migration-specific rule.
    pub violation: PathViolation,
}

/// All rows claiming one normalized path (including exact duplicate paths).
#[derive(Clone, PartialEq, Eq)]
pub struct PathCollision {
    /// Core NFC/case-folded comparison key, for explicit local review only.
    pub path_key: String,
    /// Every claimant, deterministically ordered; none has been chosen or dropped.
    pub entities: Vec<PathEntity>,
}

impl fmt::Debug for PathCollision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PathCollision")
            .field("entities", &self.entities.len())
            .finish_non_exhaustive()
    }
}

/// Complete path diagnostics for one consistent legacy collection read.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct PathReport {
    /// Every non-portable or excluded path, in deterministic entity order.
    pub invalid: Vec<InvalidPath>,
    /// Every colliding comparison key, in key order, across all three kinds.
    pub collisions: Vec<PathCollision>,
}

impl PathReport {
    /// Whether the rows can proceed without path remediation.
    pub fn is_clear(&self) -> bool {
        self.invalid.is_empty() && self.collisions.is_empty()
    }

    /// Stop migration without discarding the detailed report if remediation is needed.
    pub fn ensure_clear(self) -> Result<()> {
        if self.is_clear() {
            Ok(())
        } else {
            Err(Error::Paths(self))
        }
    }
}

impl fmt::Debug for PathReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PathReport")
            .field("invalid", &self.invalid.len())
            .field("collisions", &self.collisions.len())
            .finish()
    }
}

fn entities(
    resources: &[ResourceRow],
    records: &[RecordRow],
    files: &[FileRow],
) -> Vec<PathEntity> {
    let mut entities = Vec::with_capacity(resources.len() + records.len() + files.len());
    entities.extend(resources.iter().map(|r| PathEntity {
        kind: EntityKind::Resource,
        id: None,
        path: r.path.clone(),
    }));
    entities.extend(records.iter().map(|r| PathEntity {
        kind: EntityKind::Record,
        id: Some(r.record_id.clone()),
        path: r.path.clone(),
    }));
    entities.extend(files.iter().map(|f| PathEntity {
        kind: EntityKind::File,
        id: Some(f.file_id.clone()),
        path: f.path.clone(),
    }));
    entities.sort();
    entities
}

/// Inspect all paths without reading attachment objects or changing source rows.
///
/// Use on the H2 read **before H3 uploads**. Only this full check over all three kinds
/// can detect record/resource/file cross-kind collisions. Empty collections are allowed.
pub fn inspect_paths(
    resources: &[ResourceRow],
    records: &[RecordRow],
    files: &[FileRow],
) -> PathReport {
    let mut report = PathReport::default();
    let mut by_key: BTreeMap<String, Vec<PathEntity>> = BTreeMap::new();
    for entity in entities(resources, records, files) {
        if let Err(violation) = check_path(&entity.path) {
            report.invalid.push(InvalidPath {
                entity: entity.clone(),
                violation,
            });
        }
        // Invalid rows still participate: report all ambiguities, not just the
        // subset that happens to satisfy the independent portable-path check.
        by_key
            .entry(path_key(&entity.path))
            .or_default()
            .push(entity);
    }
    report.collisions = by_key
        .into_iter()
        .filter(|(_, entities)| entities.len() > 1)
        .map(|(path_key, entities)| PathCollision { path_key, entities })
        .collect();
    report
}

// ---------------------------------------------------------------------------
// Renames (decided 2026-10-04: rename to a portable name, report every rename,
// never drop).
// ---------------------------------------------------------------------------

/// One rename the migration makes. Every one is reported.
#[derive(Clone, PartialEq, Eq)]
pub struct Rename {
    /// The entity.
    pub entity: PathEntity,
    /// The new, portable, collision-free path.
    pub to: String,
    /// Why: the core policy's reason code, or `"collision"`.
    pub reason: &'static str,
    /// The original path is inside a known tool/configuration directory.
    /// Report separately: keeping these bytes does not make the tool use the renamed
    /// directory. This is a warning, never permission to omit content or weaken policy.
    pub tool_folder: bool,
}

impl fmt::Debug for Rename {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rename")
            .field("entity", &self.entity)
            .field("reason", &self.reason)
            .field("tool_folder", &self.tool_folder)
            .finish_non_exhaustive()
    }
}

/// The legacy read with every path made portable and unique, and the renames that did
/// it. IDs are unchanged; only paths move. Rows keep their input order.
///
/// **Proof of preflight.** Only [`resolve`] constructs this, after the full
/// cross-kind check over resources, records and files of one read, and the
/// per-collection rename step.
#[derive(Clone, Debug)]
pub struct Resolved {
    resources: Vec<ResourceRow>,
    records: Vec<RecordRow>,
    files: Vec<FileRow>,
    renames: Vec<Rename>,
}

impl Resolved {
    /// Resources, renamed where needed, in input order.
    pub fn resources(&self) -> &[ResourceRow] {
        &self.resources
    }
    /// Records, renamed where needed, in input order.
    pub fn records(&self) -> &[RecordRow] {
        &self.records
    }
    /// Files, renamed where needed, in input order.
    pub fn files(&self) -> &[FileRow] {
        &self.files
    }
    /// Every rename, in entity order. Must be reported per collection.
    pub fn renames(&self) -> &[Rename] {
        &self.renames
    }
    /// Renames needing a separate tool/configuration warning in the collection report.
    /// Includes resources, records and files, in the same deterministic entity order.
    /// All entries also remain in [`Self::renames`]; no source content is excluded.
    pub fn tool_folder_renames(&self) -> impl Iterator<Item = &Rename> {
        self.renames.iter().filter(|rename| rename.tool_folder)
    }
}

// A diagnostic hint only, independent of the canonical portable-path policy. Match
// full directory components, not substrings or the final file name. Backslashes
// are legacy separators here; they still fail the unchanged core path check.
pub(crate) fn inside_tool_folder(path: &str) -> bool {
    let mut segments = path.split(['/', '\\']).peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_some()
            && [
                ".obsidian",
                ".git",
                ".hg",
                ".svn",
                ".vscode",
                ".idea",
                "node_modules",
            ]
            .iter()
            .any(|name| segment.eq_ignore_ascii_case(name))
        {
            return true;
        }
    }
    false
}

/// A portable form of `path`, segment by segment, or `None` if none can be made (for
/// example, an empty path). The result still goes through `check_path`.
pub fn portable_name(path: &str) -> Option<String> {
    use mdbn_core::paths::MAX_SEGMENT_BYTES;
    let mut out = Vec::new();
    for seg in path.replace('\\', "/").split('/') {
        let mut s: String = seg
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
                c if c.is_control() => '_',
                // Zero-width and other ignorables (HFS+): visible stand-in.
                '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}'
                | '\u{feff}' => '_',
                '~' => '-',
                c => c,
            })
            .collect();
        if s.is_empty() || s == "." || s == ".." {
            s = s.replace('.', "_");
            if s.is_empty() {
                s.push('_');
            }
        }
        // Hidden, private: `.obsidian` → `_obsidian`.
        if let Some(rest) = s.strip_prefix('.') {
            s = format!("_{rest}");
        }
        // Trailing dots and spaces, which Windows strips.
        while s.ends_with('.') || s.ends_with(' ') {
            s.pop();
            s.push('_');
            if !(s.ends_with('.') || s.ends_with(' ')) {
                break;
            }
        }
        if s.eq_ignore_ascii_case("node_modules") {
            s.push('_');
        }
        if mdbn_core::paths::check_path(&s) == Err(PathViolation::ReservedName) {
            match s.find('.') {
                Some(dot) => s.insert(dot, '_'),
                None => s.push('_'),
            }
        }
        if s.len() > MAX_SEGMENT_BYTES {
            let ext = s
                .rfind('.')
                .map(|d| s[d..].to_owned())
                .filter(|e| e.len() < 32);
            let keep = MAX_SEGMENT_BYTES - ext.as_ref().map_or(0, String::len) - 8;
            let mut cut = keep;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            s = format!("{}{}", &s[..cut], ext.unwrap_or_default());
        }
        out.push(s);
    }
    let joined = out.join("/");
    check_path(&joined).ok().map(|()| joined)
}

/// Make every path portable and unique, renaming rather than dropping.
///
/// - **Policy:** a path the core policy refuses is renamed with [`portable_name`].
/// - **Collisions:** paths equal under NFC and case folding keep one claimant: the first
///   in (resource, record, file; ID) order whose path was already portable. The others
///   get a ` (n)` suffix (`mdbn_core::paths::allocate_path`).
/// - **Failure:** if any path can't be made portable, nothing is returned and the
///   collection stops with the full report. Nothing is ever dropped silently.
pub fn resolve(
    resources: &[ResourceRow],
    records: &[RecordRow],
    files: &[FileRow],
) -> Result<Resolved> {
    use mdbn_core::paths::allocate_path;
    // Claimants in the deterministic order of `inspect_paths`, valid paths first so
    // that a portable original keeps its name over a renamed one.
    let report = inspect_paths(resources, records, files);
    let invalid: BTreeMap<PathEntity, PathViolation> = report
        .invalid
        .iter()
        .map(|i| (i.entity.clone(), i.violation.clone()))
        .collect();
    let mut claimants = entities(resources, records, files);
    claimants.sort_by_key(|e| invalid.contains_key(e));

    let mut used: Vec<String> = Vec::new();
    let mut new_path: BTreeMap<PathEntity, String> = BTreeMap::new();
    let mut renames = Vec::new();
    let mut unfixable = PathReport::default();
    for e in claimants {
        let (candidate, reason) = match invalid.get(&e) {
            None => (e.path.clone(), None),
            Some(v) => match portable_name(&e.path) {
                Some(p) => (p, Some(v.reason())),
                None => {
                    unfixable.invalid.push(InvalidPath {
                        entity: e.clone(),
                        violation: v.clone(),
                    });
                    continue;
                }
            },
        };
        let to = allocate_path(&candidate, used.iter().map(String::as_str));
        if check_path(&to).is_err() {
            unfixable.invalid.push(InvalidPath {
                entity: e.clone(),
                violation: check_path(&to).unwrap_err(),
            });
            continue;
        }
        let reason = match (reason, to != candidate) {
            (Some(r), _) => Some(r),
            (None, true) => Some("collision"),
            (None, false) => None,
        };
        if let Some(reason) = reason {
            renames.push(Rename {
                entity: e.clone(),
                to: to.clone(),
                reason,
                tool_folder: inside_tool_folder(&e.path),
            });
        }
        used.push(to.clone());
        new_path.insert(e, to);
    }
    unfixable.ensure_clear()?;
    renames.sort_by(|a, b| a.entity.cmp(&b.entity));

    let path_of = |kind, id: Option<&String>, path: &String| {
        new_path[&PathEntity {
            kind,
            id: id.cloned(),
            path: path.clone(),
        }]
            .clone()
    };
    let out = Resolved {
        resources: resources
            .iter()
            .map(|r| ResourceRow {
                path: path_of(EntityKind::Resource, None, &r.path),
            })
            .collect(),
        records: records
            .iter()
            .map(|r| RecordRow {
                record_id: r.record_id.clone(),
                path: path_of(EntityKind::Record, Some(&r.record_id), &r.path),
            })
            .collect(),
        files: files
            .iter()
            .map(|f| FileRow {
                file_id: f.file_id.clone(),
                path: path_of(EntityKind::File, Some(&f.file_id), &f.path),
            })
            .collect(),
        renames,
    };
    // The invariant every importer must hold before sealing or installing.
    inspect_paths(&out.resources, &out.records, &out.files).ensure_clear()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
    const R2: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const F1: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";

    fn rec(id: &str, path: &str) -> RecordRow {
        RecordRow {
            record_id: id.into(),
            path: path.into(),
        }
    }

    #[test]
    fn renames_report_everything_and_keep_order() {
        let resources = vec![ResourceRow {
            path: ".obsidian/config.json".into(),
        }];
        let records = vec![rec(R1, "notes/why?.md"), rec(R2, "NOTES/WHY_.MD")];
        let files = vec![FileRow {
            file_id: F1.into(),
            path: "att/ok.png".into(),
        }];
        let report = inspect_paths(&resources, &records, &files);
        assert_eq!(report.invalid.len(), 2);
        assert!(report.collisions.is_empty());
        let out = resolve(&resources, &records, &files).unwrap();
        assert_eq!(out.records()[0].record_id, R1);
        assert_eq!(
            out.records()[1].path,
            "NOTES/WHY_.MD",
            "a portable original keeps its name"
        );
        assert_eq!(
            out.records()[0].path,
            "notes/why_ (2).md",
            "the renamed one collides and gets a suffix"
        );
        assert_eq!(out.resources()[0].path, "_obsidian/config.json");
        assert_eq!(out.renames().len(), 2);
        assert_eq!(out.tool_folder_renames().count(), 1);
        assert!(inspect_paths(out.resources(), out.records(), out.files()).is_clear());
        assert!(
            !format!("{report:?}").contains("why"),
            "Debug never prints names"
        );
    }

    #[test]
    fn unfixable_paths_stop_with_the_full_report() {
        let too_long = format!("{}x.png", "a/".repeat(600));
        let files = vec![FileRow {
            file_id: F1.into(),
            path: too_long,
        }];
        assert!(matches!(resolve(&[], &[], &files), Err(Error::Paths(_))));
        assert!(resolve(&[], &[], &[]).is_ok());
    }
}
