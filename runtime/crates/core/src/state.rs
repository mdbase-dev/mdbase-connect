//! The collection state the planner and the query layer read.
//!
//! [`StateView`] is the read interface. The replica implements it over its
//! `Store` (with real indexes); this module provides two implementations:
//! - [`MemState`]: a complete in-memory state. Used by tests, the conformance
//!   runner and the simulator, and as the reference for store implementations.
//! - [`Overlay`]: planned results layered over any base view. The writer plans
//!   a batch against `Overlay(head)`; the origin builds its local view as
//!   `Overlay(confirmed)` with its pending mutations' results.
//!
//! **Contract for implementors.** Every method answers for the *same* position;
//! lists are returned sorted (by ID, or as documented) so callers never see
//! store iteration order. Path lookups take a **path key**
//! ([`crate::paths::path_key`]).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::ids::{FileId, Hash, RecordId, Uuid};
use crate::intent::{FileContent, FileInclusion, FileKind};
use crate::links::{self, LinkKey};
use crate::paths::path_key;
use crate::plan::{Effect, Planned};
use crate::types::Catalog;
use crate::value::Value;

/// A live record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecord {
    /// Record ID.
    pub id: RecordId,
    /// Current path, as written.
    pub path: String,
    /// Exact document bytes.
    pub source: Arc<str>,
}

/// A live non-record file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    /// File ID.
    pub id: FileId,
    /// Current path.
    pub path: String,
    /// Explicit legacy blob or critical attachment content.
    pub content: FileContent,
    /// Ordinary, or unindexed oversized Markdown at a record-extension path.
    pub kind: FileKind,
}

/// The last version of a deleted record or file (`snapshot.md` §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tombstone {
    /// A deleted record.
    Record {
        /// Last path.
        path: String,
        /// Last document.
        doc: Arc<str>,
    },
    /// A deleted file.
    File {
        /// Last path.
        path: String,
        /// Complete last content, including an attachment descriptor when applicable.
        content: FileContent,
        /// The kind the file had.
        kind: FileKind,
    },
}

/// What holds a path key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathHolder {
    /// A live record.
    Record(RecordId),
    /// A live file.
    File(FileId),
}

/// Read access to collection state at one position.
pub trait StateView {
    /// The catalog compiled from the resources at this position.
    fn catalog(&self) -> Arc<Catalog>;
    /// A live record.
    fn record(&self, id: &RecordId) -> Option<StoredRecord>;
    /// A live file.
    fn file(&self, id: &FileId) -> Option<StoredFile>;
    /// The tombstone of a deleted record or file, if retained.
    fn tombstone(&self, id: &Uuid) -> Option<Tombstone>;
    /// The live record or file holding `path_key`.
    fn at_path_key(&self, path_key: &str) -> Option<PathHolder>;
    /// The record an old path key refers to (D9 aliases).
    fn alias(&self, path_key: &str) -> Option<RecordId>;
    /// A resource's exact source.
    fn resource(&self, path: &str) -> Option<Arc<str>>;
    /// Every resource path, sorted bytewise.
    fn resource_paths(&self) -> Vec<String>;
    /// The file inclusion policy.
    fn settings(&self) -> FileInclusion;
    /// A body this replica retains with SHA-256 `digest`, for body merges whose
    /// mutation carries no `body_base_text`. Default: none retained.
    fn retained_body(&self, digest: &Hash) -> Option<String> {
        let _ = digest;
        None
    }
    /// Records that may link to any of `keys` (link index; see
    /// [`links::index_keys`]). Sorted by ID. Over-approximation is allowed.
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId>;
    /// Records with one of `keys` among their [`links::target_keys`]
    /// (resolution by filename or configured ID). Sorted by ID.
    /// Over-approximation is allowed.
    ///
    /// Both link indexes depend on the catalog (`settings.id_field`, record
    /// extensions, declared link fields): a store re-derives them when a
    /// resource write changes the catalog.
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId>;
    /// Records whose persisted top-level `field` equals `value` (spec 12A
    /// equality). Sorted by ID. Used for `unique` rules.
    fn with_value(&self, field: &str, value: &Value) -> Vec<RecordId>;
    /// Every live record ID, sorted.
    fn record_ids(&self) -> Vec<RecordId>;
}

/// A complete in-memory state.
#[derive(Debug, Clone)]
pub struct MemState {
    records: BTreeMap<RecordId, StoredRecord>,
    files: BTreeMap<FileId, StoredFile>,
    tombstones: BTreeMap<Uuid, Tombstone>,
    by_path: BTreeMap<String, PathHolder>,
    aliases: BTreeMap<String, RecordId>,
    resources: BTreeMap<String, Arc<str>>,
    settings: FileInclusion,
    catalog: Arc<Catalog>,
}

impl Default for MemState {
    fn default() -> Self {
        MemState::new()
    }
}

impl MemState {
    /// An empty collection.
    pub fn new() -> MemState {
        MemState {
            records: BTreeMap::new(),
            files: BTreeMap::new(),
            tombstones: BTreeMap::new(),
            by_path: BTreeMap::new(),
            aliases: BTreeMap::new(),
            resources: BTreeMap::new(),
            settings: FileInclusion::default(),
            catalog: Arc::new(Catalog::empty()),
        }
    }

    /// Apply one effect (no semantics, `log-entry.md` §2.1).
    pub fn apply_effect(&mut self, effect: &Effect) {
        match effect {
            Effect::PutRecord { id, path, doc } => {
                self.put_record_source(*id, path, doc);
            }
            Effect::RemoveRecord { id, .. } => {
                if let Some(old) = self.records.remove(id) {
                    let k = path_key(&old.path);
                    if self.by_path.get(&k) == Some(&PathHolder::Record(*id)) {
                        self.by_path.remove(&k);
                    }
                    self.tombstones.insert(
                        *id,
                        Tombstone::Record {
                            path: old.path,
                            doc: old.source,
                        },
                    );
                }
            }
            Effect::PutFile { id, path, blob } => {
                self.put_file_content(*id, path, FileContent::Blob(*blob));
            }
            Effect::PutAttachmentFile { id, path, content } => {
                self.put_file_content(*id, path, FileContent::AttachmentV1(*content));
            }
            Effect::PutUnindexedMarkdown { id, path, content } => {
                self.drop_record_holder(id);
                self.put_file_kind(*id, path, *content, FileKind::UnindexedOversizedMarkdown);
            }
            Effect::ReindexUnindexedMarkdown { id, path, doc }
            | Effect::ReindexOrdinaryFile { id, path, doc } => {
                self.drop_file_holder(id);
                self.put_record_source(*id, path, doc);
            }
            Effect::RemoveFile { id, .. } => {
                if let Some(old) = self.files.remove(id) {
                    let k = path_key(&old.path);
                    if self.by_path.get(&k) == Some(&PathHolder::File(*id)) {
                        self.by_path.remove(&k);
                    }
                    self.tombstones.insert(
                        *id,
                        Tombstone::File {
                            path: old.path,
                            content: old.content,
                            kind: old.kind,
                        },
                    );
                }
            }
            Effect::PutResource { path, doc } => {
                self.resources.insert(path.clone(), Arc::from(doc.as_str()));
                self.recompile();
            }
            Effect::RemoveResource { path } => {
                self.resources.remove(path);
                self.recompile();
            }
            Effect::PutSettings(s) => self.settings = s.clone(),
        }
    }

    /// Apply a planned result: its effects in order, then its aliases.
    pub fn apply(&mut self, planned: &Planned) {
        for e in &planned.effects {
            self.apply_effect(e);
        }
        for a in &planned.aliases {
            self.aliases.insert(path_key(&a.path), a.id);
        }
    }

    /// Insert a record directly (fixtures, adoption).
    pub fn insert_record(&mut self, id: RecordId, path: &str, source: &str) {
        self.apply_effect(&Effect::PutRecord {
            id,
            path: path.to_owned(),
            doc: source.to_owned(),
        });
    }

    /// Insert a resource directly (fixtures, adoption).
    pub fn insert_resource(&mut self, path: &str, source: &str) {
        self.apply_effect(&Effect::PutResource {
            path: path.to_owned(),
            doc: source.to_owned(),
        });
    }

    fn put_file_content(&mut self, id: FileId, path: &str, content: FileContent) {
        self.put_file_kind(id, path, content, FileKind::Ordinary);
    }

    fn put_file_kind(&mut self, id: FileId, path: &str, content: FileContent, kind: FileKind) {
        if let Some(old) = self.files.get(&id) {
            let key = path_key(&old.path);
            if self.by_path.get(&key) == Some(&PathHolder::File(id)) {
                self.by_path.remove(&key);
            }
        }
        self.tombstones.remove(&id);
        self.by_path.insert(path_key(path), PathHolder::File(id));
        self.files.insert(
            id,
            StoredFile {
                id,
                path: path.to_owned(),
                content,
                kind,
            },
        );
    }

    fn put_record_source(&mut self, id: RecordId, path: &str, doc: &str) {
        if let Some(old) = self.records.get(&id) {
            let k = path_key(&old.path);
            if self.by_path.get(&k) == Some(&PathHolder::Record(id)) {
                self.by_path.remove(&k);
            }
        }
        self.tombstones.remove(&id);
        self.by_path.insert(path_key(path), PathHolder::Record(id));
        self.records.insert(
            id,
            StoredRecord {
                id,
                path: path.to_owned(),
                source: Arc::from(doc),
            },
        );
    }

    /// Drop a live record on a record -> file transition: no record tombstone.
    fn drop_record_holder(&mut self, id: &Uuid) {
        if let Some(old) = self.records.remove(id) {
            let k = path_key(&old.path);
            if self.by_path.get(&k) == Some(&PathHolder::Record(*id)) {
                self.by_path.remove(&k);
            }
        }
    }

    /// Drop a live file on a file -> record transition: no file tombstone.
    fn drop_file_holder(&mut self, id: &Uuid) {
        if let Some(old) = self.files.remove(id) {
            let k = path_key(&old.path);
            if self.by_path.get(&k) == Some(&PathHolder::File(*id)) {
                self.by_path.remove(&k);
            }
        }
    }

    fn recompile(&mut self) {
        self.catalog = Arc::new(Catalog::load(
            self.resources.iter().map(|(p, s)| (p.as_str(), &**s)),
        ));
    }
}

impl StateView for MemState {
    fn catalog(&self) -> Arc<Catalog> {
        Arc::clone(&self.catalog)
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        self.records.get(id).cloned()
    }
    fn file(&self, id: &FileId) -> Option<StoredFile> {
        self.files.get(id).cloned()
    }
    fn tombstone(&self, id: &Uuid) -> Option<Tombstone> {
        self.tombstones.get(id).cloned()
    }
    fn at_path_key(&self, key: &str) -> Option<PathHolder> {
        self.by_path.get(key).copied()
    }
    fn alias(&self, key: &str) -> Option<RecordId> {
        self.aliases.get(key).copied()
    }
    fn resource(&self, path: &str) -> Option<Arc<str>> {
        self.resources.get(path).cloned()
    }
    fn resource_paths(&self) -> Vec<String> {
        self.resources.keys().cloned().collect()
    }
    fn settings(&self) -> FileInclusion {
        self.settings.clone()
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.records
            .values()
            .filter(|r| {
                let own = links::index_keys(&cat, &r.path, &r.source);
                keys.iter().any(|k| own.contains(k))
            })
            .map(|r| r.id)
            .collect()
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.records
            .values()
            .filter(|r| {
                let own = links::target_keys(&cat, &r.path, Some(&r.source));
                keys.iter().any(|k| own.contains(k))
            })
            .map(|r| r.id)
            .collect()
    }
    fn with_value(&self, field: &str, value: &Value) -> Vec<RecordId> {
        self.records
            .values()
            .filter(|r| {
                crate::doc::Document::parse_at(&r.path, &*r.source)
                    .frontmatter()
                    .get(field)
                    .is_some_and(|v| v == value)
            })
            .map(|r| r.id)
            .collect()
    }
    fn record_ids(&self) -> Vec<RecordId> {
        self.records.keys().copied().collect()
    }
}

/// Planned results layered over a base view, without copying the base.
pub struct Overlay<'a> {
    base: &'a dyn StateView,
    records: BTreeMap<RecordId, Option<StoredRecord>>,
    files: BTreeMap<FileId, Option<StoredFile>>,
    tombstones: BTreeMap<Uuid, Option<Tombstone>>,
    /// Path keys changed in the layer: `None` = freed.
    by_path: BTreeMap<String, Option<PathHolder>>,
    aliases: BTreeMap<String, RecordId>,
    resources: BTreeMap<String, Option<Arc<str>>>,
    settings: Option<FileInclusion>,
    catalog: Option<Arc<Catalog>>,
}

impl<'a> Overlay<'a> {
    /// An empty layer over `base`.
    pub fn new(base: &'a dyn StateView) -> Overlay<'a> {
        Overlay {
            base,
            records: BTreeMap::new(),
            files: BTreeMap::new(),
            tombstones: BTreeMap::new(),
            by_path: BTreeMap::new(),
            aliases: BTreeMap::new(),
            resources: BTreeMap::new(),
            settings: None,
            catalog: None,
        }
    }

    /// Whether nothing has been layered.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
            && self.files.is_empty()
            && self.resources.is_empty()
            && self.settings.is_none()
            && self.aliases.is_empty()
    }

    /// Apply a planned result: effects in order, then aliases.
    pub fn apply(&mut self, planned: &Planned) {
        for e in &planned.effects {
            self.apply_effect(e);
        }
        for a in &planned.aliases {
            self.aliases.insert(path_key(&a.path), a.id);
        }
    }

    fn free_path(&mut self, path: &str, holder: PathHolder) {
        let k = path_key(path);
        if self.at_path_key(&k) == Some(holder) {
            self.by_path.insert(k, None);
        }
    }

    /// Apply one effect.
    pub fn apply_effect(&mut self, effect: &Effect) {
        match effect {
            Effect::PutRecord { id, path, doc } => {
                self.put_record_source(*id, path, doc);
            }
            Effect::RemoveRecord { id, .. } => {
                if let Some(old) = self.record(id) {
                    self.free_path(&old.path, PathHolder::Record(*id));
                    self.tombstones.insert(
                        *id,
                        Some(Tombstone::Record {
                            path: old.path,
                            doc: old.source,
                        }),
                    );
                }
                self.records.insert(*id, None);
            }
            Effect::PutFile { id, path, blob } => {
                self.put_file_content(*id, path, FileContent::Blob(*blob));
            }
            Effect::PutAttachmentFile { id, path, content } => {
                self.put_file_content(*id, path, FileContent::AttachmentV1(*content));
            }
            Effect::PutUnindexedMarkdown { id, path, content } => {
                self.drop_record_holder(id);
                self.put_file_kind(*id, path, *content, FileKind::UnindexedOversizedMarkdown);
            }
            Effect::ReindexUnindexedMarkdown { id, path, doc }
            | Effect::ReindexOrdinaryFile { id, path, doc } => {
                self.drop_file_holder(id);
                self.put_record_source(*id, path, doc);
            }
            Effect::RemoveFile { id, .. } => {
                if let Some(old) = self.file(id) {
                    self.free_path(&old.path, PathHolder::File(*id));
                    self.tombstones.insert(
                        *id,
                        Some(Tombstone::File {
                            path: old.path,
                            content: old.content,
                            kind: old.kind,
                        }),
                    );
                }
                self.files.insert(*id, None);
            }
            Effect::PutResource { path, doc } => {
                self.resources
                    .insert(path.clone(), Some(Arc::from(doc.as_str())));
                self.recompile();
            }
            Effect::RemoveResource { path } => {
                self.resources.insert(path.clone(), None);
                self.recompile();
            }
            Effect::PutSettings(s) => self.settings = Some(s.clone()),
        }
    }

    fn put_file_content(&mut self, id: FileId, path: &str, content: FileContent) {
        self.put_file_kind(id, path, content, FileKind::Ordinary);
    }

    fn put_file_kind(&mut self, id: FileId, path: &str, content: FileContent, kind: FileKind) {
        if let Some(old) = self.file(&id) {
            self.free_path(&old.path, PathHolder::File(id));
        }
        self.tombstones.insert(id, None);
        self.by_path
            .insert(path_key(path), Some(PathHolder::File(id)));
        self.files.insert(
            id,
            Some(StoredFile {
                id,
                path: path.to_owned(),
                content,
                kind,
            }),
        );
    }

    fn put_record_source(&mut self, id: RecordId, path: &str, doc: &str) {
        if let Some(old) = self.record(&id) {
            self.free_path(&old.path, PathHolder::Record(id));
        }
        self.tombstones.insert(id, None);
        self.by_path
            .insert(path_key(path), Some(PathHolder::Record(id)));
        self.records.insert(
            id,
            Some(StoredRecord {
                id,
                path: path.to_owned(),
                source: Arc::from(doc),
            }),
        );
    }

    /// Drop a live record on a record -> file transition: no record tombstone.
    fn drop_record_holder(&mut self, id: &Uuid) {
        if let Some(old) = self.record(id) {
            self.free_path(&old.path, PathHolder::Record(*id));
            self.records.insert(*id, None);
        }
    }

    /// Drop a live file on a file -> record transition: no file tombstone.
    fn drop_file_holder(&mut self, id: &Uuid) {
        if let Some(old) = self.file(id) {
            self.free_path(&old.path, PathHolder::File(*id));
            self.files.insert(*id, None);
        }
    }

    fn recompile(&mut self) {
        let paths = self.resource_paths();
        let sources: Vec<(String, Arc<str>)> = paths
            .into_iter()
            .filter_map(|p| self.resource(&p).map(|s| (p, s)))
            .collect();
        self.catalog = Some(Arc::new(Catalog::load(
            sources.iter().map(|(p, s)| (p.as_str(), &**s)),
        )));
    }

    /// Records changed in the layer (live ones), sorted by ID.
    fn layer_records(&self) -> impl Iterator<Item = &StoredRecord> {
        self.records.values().flatten()
    }

    /// Base IDs filtered of those the layer overrides, merged with layer hits.
    fn merge_ids(
        &self,
        base: Vec<RecordId>,
        layer_hit: impl Fn(&StoredRecord) -> bool,
    ) -> Vec<RecordId> {
        let mut out: BTreeSet<RecordId> = base
            .into_iter()
            .filter(|id| !self.records.contains_key(id))
            .collect();
        out.extend(self.layer_records().filter(|r| layer_hit(r)).map(|r| r.id));
        out.into_iter().collect()
    }
}

impl StateView for Overlay<'_> {
    fn catalog(&self) -> Arc<Catalog> {
        match &self.catalog {
            Some(c) => Arc::clone(c),
            None => self.base.catalog(),
        }
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        match self.records.get(id) {
            Some(r) => r.clone(),
            None => self.base.record(id),
        }
    }
    fn file(&self, id: &FileId) -> Option<StoredFile> {
        match self.files.get(id) {
            Some(f) => f.clone(),
            None => self.base.file(id),
        }
    }
    fn tombstone(&self, id: &Uuid) -> Option<Tombstone> {
        match self.tombstones.get(id) {
            Some(t) => t.clone(),
            None => self.base.tombstone(id),
        }
    }
    fn at_path_key(&self, key: &str) -> Option<PathHolder> {
        if let Some(h) = self.by_path.get(key) {
            return *h;
        }
        // A base holder the layer moved or removed no longer holds the key.
        let holder = self.base.at_path_key(key)?;
        let still = match holder {
            PathHolder::Record(id) => match self.records.get(&id) {
                Some(Some(r)) => path_key(&r.path) == key,
                Some(None) => false,
                None => true,
            },
            PathHolder::File(id) => match self.files.get(&id) {
                Some(Some(f)) => path_key(&f.path) == key,
                Some(None) => false,
                None => true,
            },
        };
        still.then_some(holder)
    }
    fn alias(&self, key: &str) -> Option<RecordId> {
        self.aliases
            .get(key)
            .copied()
            .or_else(|| self.base.alias(key))
    }
    fn resource(&self, path: &str) -> Option<Arc<str>> {
        match self.resources.get(path) {
            Some(r) => r.clone(),
            None => self.base.resource(path),
        }
    }
    fn resource_paths(&self) -> Vec<String> {
        let mut set: BTreeSet<String> = self.base.resource_paths().into_iter().collect();
        for (p, r) in &self.resources {
            if r.is_some() {
                set.insert(p.clone());
            } else {
                set.remove(p);
            }
        }
        set.into_iter().collect()
    }
    fn settings(&self) -> FileInclusion {
        self.settings
            .clone()
            .unwrap_or_else(|| self.base.settings())
    }
    fn retained_body(&self, digest: &Hash) -> Option<String> {
        self.base.retained_body(digest)
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.merge_ids(self.base.referrers(keys), |r| {
            let own = links::index_keys(&cat, &r.path, &r.source);
            keys.iter().any(|k| own.contains(k))
        })
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.merge_ids(self.base.link_targets(keys), |r| {
            let own = links::target_keys(&cat, &r.path, Some(&r.source));
            keys.iter().any(|k| own.contains(k))
        })
    }
    fn with_value(&self, field: &str, value: &Value) -> Vec<RecordId> {
        self.merge_ids(self.base.with_value(field, value), |r| {
            crate::doc::Document::parse_at(&r.path, &*r.source)
                .frontmatter()
                .get(field)
                .is_some_and(|v| v == value)
        })
    }
    fn record_ids(&self) -> Vec<RecordId> {
        self.merge_ids(self.base.record_ids(), |_| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> Uuid {
        let mut b = [0u8; 16];
        b[15] = n;
        Uuid(b)
    }

    #[test]
    fn overlay_moves_free_the_old_path_key() {
        let mut base = MemState::new();
        base.insert_record(id(1), "a.md", "x");
        let mut ov = Overlay::new(&base);
        assert_eq!(ov.at_path_key("a.md"), Some(PathHolder::Record(id(1))));
        ov.apply_effect(&Effect::PutRecord {
            id: id(1),
            path: "B.md".into(),
            doc: "y".into(),
        });
        assert_eq!(ov.at_path_key("a.md"), None);
        assert_eq!(ov.at_path_key("b.md"), Some(PathHolder::Record(id(1))));
        ov.apply_effect(&Effect::RemoveRecord {
            id: id(1),
            path: "B.md".into(),
        });
        assert_eq!(ov.at_path_key("b.md"), None);
        assert!(matches!(
            ov.tombstone(&id(1)),
            Some(Tombstone::Record { ref path, .. }) if path == "B.md"
        ));
        assert!(ov.record_ids().is_empty());
        // The base is untouched.
        assert_eq!(base.record_ids(), vec![id(1)]);
    }

    #[test]
    fn mem_state_resurrects_from_tombstone() {
        let mut s = MemState::new();
        s.insert_record(id(1), "a.md", "x");
        s.apply_effect(&Effect::RemoveRecord {
            id: id(1),
            path: "a.md".into(),
        });
        assert!(s.record(&id(1)).is_none());
        assert!(s.tombstone(&id(1)).is_some());
        s.insert_record(id(1), "a.md", "y");
        assert!(s.tombstone(&id(1)).is_none());
        assert_eq!(s.at_path_key("a.md"), Some(PathHolder::Record(id(1))));
    }
}
