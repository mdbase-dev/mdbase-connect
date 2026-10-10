//! Legacy path preflight over `mdbn-legacy` rows: the native adapter of
//! `mdbn_migrate_portable::preflight`, which holds the policy, the collision check and
//! the decided remediation (rename to a portable, unique name; report every rename;
//! never drop). Documents and object keys never enter the portable crate.

use mdbn_legacy::hosted::{FileMeta, Record};
use mdbn_migrate_portable::preflight as portable;
pub use mdbn_migrate_portable::preflight::{
    EntityKind, InvalidPath, PathCollision, PathEntity, PathReport, Rename, portable_name,
};
use mdbn_migrate_portable::rows::{FileRow, RecordRow, ResourceRow};

use crate::Result;

fn rows(
    resources: &[(String, Vec<u8>)],
    records: &[Record],
    files: &[FileMeta],
) -> (Vec<ResourceRow>, Vec<RecordRow>, Vec<FileRow>) {
    (
        resources
            .iter()
            .map(|(path, _)| ResourceRow { path: path.clone() })
            .collect(),
        records
            .iter()
            .map(|r| RecordRow {
                record_id: r.record_id.clone(),
                path: r.path.clone(),
            })
            .collect(),
        files
            .iter()
            .map(|f| FileRow {
                file_id: f.file_id.clone(),
                path: f.path.clone(),
            })
            .collect(),
    )
}

/// Inspect all paths without reading attachment objects or changing source rows.
///
/// Use on the H2 read **before H3 uploads**. `gen0::build` also enforces this gate
/// so callers cannot accidentally import unreviewed rows. `reseal_files` checks
/// its file subset before touching any object; only this full check can detect
/// record/resource/file cross-kind collisions. Empty collections are allowed.
pub fn inspect_paths(
    resources: &[(String, Vec<u8>)],
    records: &[Record],
    files: &[FileMeta],
) -> PathReport {
    let (r, c, f) = rows(resources, records, files);
    portable::inspect_paths(&r, &c, &f)
}

/// The legacy read with every path made portable and unique, and the renames that did
/// it. Content, IDs and digests are unchanged; only paths move.
///
/// **Proof of preflight.** Only [`resolve`] constructs this, after the full
/// cross-kind check over resources, records and files of one read, and the
/// per-collection rename step. `reseal::reseal_files` takes it, so no blob can be
/// uploaded for a read that skipped either.
#[derive(Clone, Debug)]
pub struct Resolved {
    resources: Vec<(String, Vec<u8>)>,
    records: Vec<Record>,
    files: Vec<FileMeta>,
    renames: Vec<Rename>,
}

impl Resolved {
    /// Resources, renamed where needed.
    pub fn resources(&self) -> &[(String, Vec<u8>)] {
        &self.resources
    }
    /// Records, renamed where needed.
    pub fn records(&self) -> &[Record] {
        &self.records
    }
    /// Files, renamed where needed (the R2 `object_key` is unchanged).
    pub fn files(&self) -> &[FileMeta] {
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

/// Make every path portable and unique, renaming rather than dropping
/// (`mdbn_migrate_portable::preflight::resolve`). If any path can't be made portable,
/// nothing is returned and the collection stops with the full report.
pub fn resolve(
    resources: &[(String, Vec<u8>)],
    records: &[Record],
    files: &[FileMeta],
) -> Result<Resolved> {
    let (r, c, f) = rows(resources, records, files);
    let out = portable::resolve(&r, &c, &f)?;
    Ok(Resolved {
        resources: resources
            .iter()
            .zip(out.resources())
            .map(|((_, bytes), r)| (r.path.clone(), bytes.clone()))
            .collect(),
        records: records
            .iter()
            .zip(out.records())
            .map(|(rec, r)| Record {
                path: r.path.clone(),
                ..rec.clone()
            })
            .collect(),
        files: files
            .iter()
            .zip(out.files())
            .map(|(file, f)| FileMeta {
                path: f.path.clone(),
                ..file.clone()
            })
            .collect(),
        renames: out.renames().to_vec(),
    })
}
