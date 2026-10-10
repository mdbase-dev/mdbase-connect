//! The local view: confirmed state plus this replica's pending effects.
//!
//! `mdbn_core::state::Overlay` borrows its base, so it can't outlive one planning
//! call. The local view must persist across calls (submits must not re-apply every
//! pending row, which is what made the prototype slow down linearly at 10k pending),
//! so the replica keeps an owned [`Layer`] and reads it through [`LayerView`]. The
//! semantics mirror core's `Overlay` exactly.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use mdbn_core::ids::{FileId, Hash, RecordId, Uuid};
use mdbn_core::intent::{FileContent, FileInclusion, FileKind};
use mdbn_core::links::{self, LinkKey};
use mdbn_core::paths::path_key;
use mdbn_core::plan::Effect;
use mdbn_core::state::{PathHolder, StateView, StoredFile, StoredRecord, Tombstone};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value;

/// Changes layered over a base view. `None` entries are removals.
#[derive(Debug, Clone, Default)]
pub struct Layer {
    records: BTreeMap<RecordId, Option<StoredRecord>>,
    files: BTreeMap<FileId, Option<StoredFile>>,
    tombstones: BTreeMap<Uuid, Option<Tombstone>>,
    by_path: BTreeMap<String, Option<PathHolder>>,
    aliases: BTreeMap<String, RecordId>,
    resources: BTreeMap<String, Option<Arc<str>>>,
    settings: Option<FileInclusion>,
    catalog: Option<Arc<Catalog>>,
}

impl Layer {
    /// Whether nothing is layered.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
            && self.files.is_empty()
            && self.resources.is_empty()
            && self.settings.is_none()
            && self.aliases.is_empty()
            && self.tombstones.is_empty()
    }

    /// Records and files this layer overrides (pending in the local view).
    pub fn touched_ids(&self) -> BTreeSet<Uuid> {
        self.records
            .keys()
            .chain(self.files.keys())
            .copied()
            .collect()
    }

    /// Whether the layer knows `id` as a file (put or removed).
    pub fn file_known(&self, id: &Uuid) -> bool {
        self.files.contains_key(id)
    }

    /// Whether a resource path is overridden by pending local effects.
    pub(crate) fn resource_known(&self, path: &str) -> bool {
        self.resources.contains_key(path)
    }

    /// Any pending resource put or deletion prevents a confirmed inventory.
    pub(crate) fn resources_pending(&self) -> bool {
        !self.resources.is_empty()
    }

    /// Whether `id` is overridden by the layer.
    pub fn touches(&self, id: &Uuid) -> bool {
        self.records.contains_key(id) || self.files.contains_key(id)
    }

    /// The layered catalog, if resources changed in the layer.
    pub fn catalog(&self) -> Option<Arc<Catalog>> {
        self.catalog.clone()
    }

    fn view<'a>(&'a self, base: &'a dyn StateView) -> LayerView<'a> {
        LayerView { base, layer: self }
    }

    fn free_path(&mut self, base: &dyn StateView, path: &str, holder: PathHolder) {
        let k = path_key(path);
        if self.view(base).at_path_key(&k) == Some(holder) {
            self.by_path.insert(k, None);
        }
    }

    /// Apply one effect.
    pub fn apply_effect(&mut self, base: &dyn StateView, effect: &Effect) {
        match effect {
            Effect::PutRecord { id, path, doc } => {
                self.put_record_source(base, *id, path, doc);
            }
            Effect::RemoveRecord { id, .. } => {
                if let Some(old) = self.view(base).record(id) {
                    self.free_path(base, &old.path, PathHolder::Record(*id));
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
                self.put_file_content(base, *id, path, FileContent::Blob(*blob));
            }
            Effect::PutAttachmentFile { id, path, content } => {
                self.put_file_content(base, *id, path, FileContent::AttachmentV1(*content));
            }
            Effect::PutUnindexedMarkdown { id, path, content } => {
                // An Op15 transition drops the live record without a record tombstone.
                self.drop_record_holder(base, id);
                self.put_file_kind(
                    base,
                    *id,
                    path,
                    *content,
                    FileKind::UnindexedOversizedMarkdown,
                );
            }
            Effect::ReindexUnindexedMarkdown { id, path, doc }
            | Effect::ReindexOrdinaryFile { id, path, doc } => {
                // Reindex transitions drop the live file without a file tombstone.
                self.drop_file_holder(base, id);
                self.put_record_source(base, *id, path, doc);
            }
            Effect::RemoveFile { id, .. } => {
                if let Some(old) = self.view(base).file(id) {
                    self.free_path(base, &old.path, PathHolder::File(*id));
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
                self.recompile(base);
            }
            Effect::RemoveResource { path } => {
                self.resources.insert(path.clone(), None);
                self.recompile(base);
            }
            Effect::PutSettings(s) => self.settings = Some(s.clone()),
        }
    }

    /// Put a record's source at a path.
    fn put_record_source(&mut self, base: &dyn StateView, id: RecordId, path: &str, doc: &str) {
        if let Some(old) = self.view(base).record(&id) {
            self.free_path(base, &old.path, PathHolder::Record(id));
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

    /// Put an ordinary file with its explicit content, whichever arm it is.
    fn put_file_content(
        &mut self,
        base: &dyn StateView,
        id: FileId,
        path: &str,
        content: FileContent,
    ) {
        self.put_file_kind(base, id, path, content, FileKind::Ordinary);
    }

    /// Put a file of an explicit kind with its explicit content.
    fn put_file_kind(
        &mut self,
        base: &dyn StateView,
        id: FileId,
        path: &str,
        content: FileContent,
        kind: FileKind,
    ) {
        if let Some(old) = self.view(base).file(&id) {
            self.free_path(base, &old.path, PathHolder::File(id));
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

    /// Drop a live record on a record -> file transition: no record tombstone.
    fn drop_record_holder(&mut self, base: &dyn StateView, id: &Uuid) {
        if let Some(old) = self.view(base).record(id) {
            self.free_path(base, &old.path, PathHolder::Record(*id));
            self.records.insert(*id, None);
        }
    }

    /// Drop a live file on a file -> record transition: no file tombstone.
    fn drop_file_holder(&mut self, base: &dyn StateView, id: &Uuid) {
        if let Some(old) = self.view(base).file(id) {
            self.free_path(base, &old.path, PathHolder::File(*id));
            self.files.insert(*id, None);
        }
    }

    /// Apply an alias.
    pub fn apply_alias(&mut self, path: &str, id: RecordId) {
        self.aliases.insert(path_key(path), id);
    }

    fn recompile(&mut self, base: &dyn StateView) {
        let v = self.view(base);
        let sources: Vec<(String, Arc<str>)> = v
            .resource_paths()
            .into_iter()
            .filter_map(|p| v.resource(&p).map(|s| (p, s)))
            .collect();
        self.catalog = Some(Arc::new(Catalog::load(
            sources.iter().map(|(p, s)| (p.as_str(), &**s)),
        )));
    }

    fn layer_records(&self) -> impl Iterator<Item = &StoredRecord> {
        self.records.values().flatten()
    }

    fn merge_ids(&self, base: Vec<RecordId>, hit: impl Fn(&StoredRecord) -> bool) -> Vec<RecordId> {
        let mut out: BTreeSet<RecordId> = base
            .into_iter()
            .filter(|id| !self.records.contains_key(id))
            .collect();
        out.extend(self.layer_records().filter(|r| hit(r)).map(|r| r.id));
        out.into_iter().collect()
    }
}

/// A [`Layer`] read over a base.
pub struct LayerView<'a> {
    /// The base (confirmed state).
    pub base: &'a dyn StateView,
    /// The layer.
    pub layer: &'a Layer,
}

impl StateView for LayerView<'_> {
    fn catalog(&self) -> Arc<Catalog> {
        match &self.layer.catalog {
            Some(c) => Arc::clone(c),
            None => self.base.catalog(),
        }
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        match self.layer.records.get(id) {
            Some(r) => r.clone(),
            None => self.base.record(id),
        }
    }
    fn file(&self, id: &FileId) -> Option<StoredFile> {
        match self.layer.files.get(id) {
            Some(f) => f.clone(),
            None => self.base.file(id),
        }
    }
    fn tombstone(&self, id: &Uuid) -> Option<Tombstone> {
        match self.layer.tombstones.get(id) {
            Some(t) => t.clone(),
            None => self.base.tombstone(id),
        }
    }
    fn at_path_key(&self, key: &str) -> Option<PathHolder> {
        if let Some(h) = self.layer.by_path.get(key) {
            return *h;
        }
        let holder = self.base.at_path_key(key)?;
        let still = match holder {
            PathHolder::Record(id) => match self.layer.records.get(&id) {
                Some(Some(r)) => path_key(&r.path) == key,
                Some(None) => false,
                None => true,
            },
            PathHolder::File(id) => match self.layer.files.get(&id) {
                Some(Some(f)) => path_key(&f.path) == key,
                Some(None) => false,
                None => true,
            },
        };
        still.then_some(holder)
    }
    fn alias(&self, key: &str) -> Option<RecordId> {
        self.layer
            .aliases
            .get(key)
            .copied()
            .or_else(|| self.base.alias(key))
    }
    fn resource(&self, path: &str) -> Option<Arc<str>> {
        match self.layer.resources.get(path) {
            Some(r) => r.clone(),
            None => self.base.resource(path),
        }
    }
    fn resource_paths(&self) -> Vec<String> {
        let mut set: BTreeSet<String> = self.base.resource_paths().into_iter().collect();
        for (p, r) in &self.layer.resources {
            if r.is_some() {
                set.insert(p.clone());
            } else {
                set.remove(p);
            }
        }
        set.into_iter().collect()
    }
    fn settings(&self) -> FileInclusion {
        self.layer
            .settings
            .clone()
            .unwrap_or_else(|| self.base.settings())
    }
    fn retained_body(&self, digest: &Hash) -> Option<String> {
        self.base.retained_body(digest)
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.layer.merge_ids(self.base.referrers(keys), |r| {
            let own = links::index_keys(&cat, &r.path, &r.source);
            keys.iter().any(|k| own.contains(k))
        })
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let cat = self.catalog();
        self.layer.merge_ids(self.base.link_targets(keys), |r| {
            let own = links::target_keys(&cat, &r.path, Some(&r.source));
            keys.iter().any(|k| own.contains(k))
        })
    }
    fn with_value(&self, field: &str, value: &Value) -> Vec<RecordId> {
        self.layer
            .merge_ids(self.base.with_value(field, value), |r| {
                mdbn_core::doc::Document::parse_at(&r.path, &*r.source)
                    .frontmatter()
                    .get(field)
                    .is_some_and(|v| v == value)
            })
    }
    fn record_ids(&self) -> Vec<RecordId> {
        self.layer.merge_ids(self.base.record_ids(), |_| true)
    }
}
