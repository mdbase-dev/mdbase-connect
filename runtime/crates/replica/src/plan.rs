//! The seam between the replica and the core's semantics.
//!
//! The replica plans through [`Planner`], which defaults to [`CorePlanner`]
//! (`mdbn_core::plan`). It plans against `mdbn_core::state::StateView`
//! implementations the replica provides: [`StoreView`] over confirmed state in the
//! [`Store`], wrapped in `mdbn_core::state::Overlay` for the local view (pending
//! effects) and for the earlier items of an append batch.
//!
//! | Use | State | Stage |
//! |---|---|---|
//! | submit | local view | `Stage::Submit { level }` |
//! | append loop | head + earlier batch items | `Stage::Head` |
//! | rebase | new local view | `Stage::Head` |
//! | verify | confirmed state at the entry's position | `Stage::Head` |
//!
//! The seam is a trait so the replica's tests (and the simulator, until core
//! planning is complete) can run the append loop with a small planner.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::sync::Arc;

use mdbn_core::ids::{FileId, RecordId, Uuid as CUuid};
use mdbn_core::intent::{FileContent, FileInclusion, FileKind, Mutation};
use mdbn_core::links::LinkKey;
use mdbn_core::plan::{PlanOptions, Planned, Rejection};
use mdbn_core::query::indexed::{IndexFieldSpec, IndexKeyError, SortAtom};
use mdbn_core::query::{FieldRef, QueryRecord};
use mdbn_core::state::{PathHolder, StateView, StoredFile, StoredRecord, Tombstone};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value as CValue;
use sha2::{Digest, Sha256};

use crate::convert;
use crate::store::{Page, RecordMeta, RecordRow, Store, StoreError, TombstoneLast};
use crate::store_query::{
    QueryAtom, QueryField, QueryFieldValue, QueryGeneration, QueryIndexedRow,
};

/// Plans mutations. Implementations must be deterministic: equal inputs, equal outputs.
pub trait Planner {
    /// Plan `mutation` against `state`.
    #[allow(clippy::result_large_err)]
    fn plan(
        &self,
        mutation: &Mutation,
        state: &dyn StateView,
        opts: &PlanOptions,
    ) -> Result<Planned, Rejection>;
}

/// The core's planner.
#[derive(Debug, Clone, Copy, Default)]
pub struct CorePlanner;

impl Planner for CorePlanner {
    fn plan(
        &self,
        mutation: &Mutation,
        state: &dyn StateView,
        opts: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        mdbn_core::plan(mutation, state, opts)
    }
}

/// Prefix of an outgoing link index key in [`RecordMeta::links`].
pub const LINK_PREFIX: &str = "l:";
/// Prefix of a record's own target key in [`RecordMeta::links`].
pub const TARGET_PREFIX: &str = "t:";

/// The core's equality key for a value in a unique index.
pub fn value_key(v: &CValue) -> String {
    v.to_json()
}

/// Derive a record's index entries through the core.
pub fn record_meta(catalog: &Catalog, path: &str, doc: &str) -> RecordMeta {
    let parsed = mdbn_core::doc::Document::parse_at(path, doc);
    let fm = parsed.frontmatter();
    let membership = catalog.membership(path, fm);
    let mut links: Vec<String> = mdbn_core::links::index_keys(catalog, path, doc)
        .into_iter()
        .map(|k| format!("{LINK_PREFIX}{}", k.0))
        .collect();
    links.extend(
        mdbn_core::links::target_keys(catalog, path, Some(doc))
            .into_iter()
            .map(|k| format!("{TARGET_PREFIX}{}", k.0)),
    );
    links.sort();
    links.dedup();
    let mut unique = Vec::new();
    for t in catalog.types() {
        if !membership
            .types
            .iter()
            .any(|m| m.eq_ignore_ascii_case(&t.name))
        {
            continue;
        }
        for rule in &t.unique {
            for v in mdbn_core::types::select(fm, &rule.field) {
                if !v.is_null() {
                    unique.push((rule.field.clone(), value_key(v)));
                }
            }
        }
    }
    unique.sort();
    unique.dedup();
    RecordMeta {
        types: membership.types.clone(),
        effective: convert::wmap(fm),
        links,
        tags: Vec::new(),
        unique,
    }
}

/// Project a confirmed row through the captured catalog's index semantics.
///
/// Membership and persisted frontmatter are recomputed from the row's actual
/// path/document, not its potentially old `RecordMeta`. The core applies read
/// defaults and resolves temporal hints across all matched types. Unsupported
/// fields and oversized atoms fail explicitly, without a raw-value fallback.
///
/// The caller must preflight hydration, bind this catalog to the index generation,
/// and commit these atoms in the same transaction as the row. This pure helper
/// does not establish generation coverage, request budgets or authorization.
pub fn project_record_index_fields(
    catalog: &Catalog,
    row: &RecordRow,
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<Vec<(IndexFieldSpec, SortAtom)>, IndexKeyError> {
    Ok(project_record_fields(catalog, row, fields, max_key_bytes)?.fields)
}

struct RecordFieldProjection {
    types: Vec<String>,
    fields: Vec<(IndexFieldSpec, SortAtom)>,
}

fn project_record_fields(
    catalog: &Catalog,
    row: &RecordRow,
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<RecordFieldProjection, IndexKeyError> {
    let parsed = mdbn_core::doc::Document::parse_at(&row.path, &row.doc);
    let frontmatter = parsed.frontmatter();
    let membership = catalog.membership(&row.path, frontmatter);
    let fields = mdbn_core::query::indexed::project_index_fields(
        catalog,
        &QueryRecord {
            path: &row.path,
            types: &membership.types,
            frontmatter,
            body: None,
        },
        fields,
        max_key_bytes,
    )?;
    Ok(RecordFieldProjection {
        types: membership.types,
        fields,
    })
}

/// The projection algorithm identity, independent of log position and key codec.
/// Bump whenever membership/default/atom projection semantics change.
pub const QUERY_PROJECTION_VERSION: u64 = 1;

/// Convert the supported configured fields to neutral store identities, preserving
/// declared order. Duplicate or unsupported fields fail, never silently deduplicate.
pub fn query_index_fields(
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<Vec<QueryField>, IndexKeyError> {
    let mut seen = std::collections::BTreeSet::new();
    fields
        .iter()
        .map(|field| {
            let spec = IndexFieldSpec::effective_top_level(field).ok_or(IndexKeyError::Invalid)?;
            let field = QueryField {
                source: spec.source as u8,
                path_key: spec.path_key(max_key_bytes)?,
            };
            if !seen.insert(field.clone()) {
                return Err(IndexKeyError::Invalid);
            }
            Ok(field)
        })
        .collect()
}

/// Fingerprint exact catalog resources, SEM, declared fields, key codec and
/// projection algorithm. Head is captured separately: ordinary record writes
/// must not require reprojecting every row. Resource enumeration order is ignored;
/// duplicate resource paths are invalid. Never includes per-record temporal hints.
///
/// The caller supplies the SAME post-resource-effect resources/catalog as the Tx.
/// This hash is index identity, not a policy, durability or coverage attestation.
pub fn query_index_generation(
    resources: &[(String, String)],
    sem: mdbn_wire::common::Sem,
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<QueryGeneration, IndexKeyError> {
    let fields = query_index_fields(fields, max_key_bytes)?;
    let resources = canonical_query_resources(resources)?;
    query_generation_from_declarations(&resources, sem, &fields)
}

fn canonical_query_resources(
    resources: &[(String, String)],
) -> Result<BTreeMap<&str, &str>, IndexKeyError> {
    let mut sorted = BTreeMap::new();
    for (path, doc) in resources {
        if sorted.insert(path.as_str(), doc.as_str()).is_some() {
            return Err(IndexKeyError::Invalid);
        }
    }
    Ok(sorted)
}

fn query_generation_from_declarations(
    resources_by_path: &BTreeMap<&str, &str>,
    sem: mdbn_wire::common::Sem,
    fields: &[QueryField],
) -> Result<QueryGeneration, IndexKeyError> {
    let mut hash = Sha256::new();
    hash.update(b"mdbase/v1/query-index-generation\0");
    hash.update([mdbn_core::query::indexed::KEY_VERSION]);
    hash.update(QUERY_PROJECTION_VERSION.to_be_bytes());
    hash.update(sem.major.to_be_bytes());
    hash.update(sem.minor.to_be_bytes());
    hash.update(
        u64::try_from(resources_by_path.len())
            .map_err(|_| IndexKeyError::TooWide)?
            .to_be_bytes(),
    );
    for (path, doc) in resources_by_path {
        hash.update(
            u64::try_from(path.len())
                .map_err(|_| IndexKeyError::TooWide)?
                .to_be_bytes(),
        );
        hash.update(path.as_bytes());
        hash.update(
            u64::try_from(doc.len())
                .map_err(|_| IndexKeyError::TooWide)?
                .to_be_bytes(),
        );
        // Hash one resource at a time; never encode/copy a whole catalog payload.
        hash.update(mdbn_wire::hash::sha256(doc.as_bytes()).0);
    }
    hash.update(
        u64::try_from(fields.len())
            .map_err(|_| IndexKeyError::TooWide)?
            .to_be_bytes(),
    );
    for field in fields {
        hash.update([field.source]);
        hash.update(
            u64::try_from(field.path_key.len())
                .map_err(|_| IndexKeyError::TooWide)?
                .to_be_bytes(),
        );
        hash.update(&field.path_key);
    }
    Ok(hash.finalize().into())
}

/// A complete neutral row projection for the SAME record/index transaction.
/// Actual path/current types and every declared field are derived together from
/// one document parse; no source document is carried into the index projection.
pub fn project_record_query_index_row(
    catalog: &Catalog,
    row: &RecordRow,
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<QueryIndexedRow, IndexKeyError> {
    // Validate the declaration before parsing the record or allocating atoms.
    let declarations = query_index_fields(fields, max_key_bytes)?;
    project_query_row(catalog, row, fields, &declarations, max_key_bytes)
}

fn project_query_row(
    catalog: &Catalog,
    row: &RecordRow,
    fields: &[FieldRef],
    declarations: &[QueryField],
    max_key_bytes: usize,
) -> Result<QueryIndexedRow, IndexKeyError> {
    let projected = project_record_fields(catalog, row, fields, max_key_bytes)?;
    if projected.fields.len() != declarations.len() {
        return Err(IndexKeyError::Invalid);
    }
    let fields = projected
        .fields
        .into_iter()
        .zip(declarations.iter().cloned())
        .map(|((spec, atom), field)| QueryFieldValue {
            field,
            temporal_hint: spec.temporal as u8,
            atom: QueryAtom {
                kind: atom.kind() as u8,
                key: atom.key().to_vec(),
            },
        })
        .collect();
    Ok(QueryIndexedRow {
        id: row.id,
        path: row.path.clone(),
        types: projected.types,
        fields,
    })
}

/// Maximum number of configured metadata fields in the automatic index profile.
/// This limits selected specifications, NOT catalog-compilation/aggregate heap.
pub const MAX_DECLARED_QUERY_FIELDS: usize = 16;

/// Select a deterministic, explicitly bounded SUBSET of effective top-level fields.
/// Preferred fields are explicit host configuration, not inferred schema defaults;
/// they are never silently dropped. Remaining slots use compiled schema declarations
/// (`$ref`/`allOf` included), in canonical catalog-type/property order. Final output
/// is ordered by neutral source/path-key identity, matching backend state ordering.
///
/// Omitted fields are NOT supported by this index: the executor must reject their
/// use before hydration, never claim whole-schema coverage or use partial results.
/// Core's catalog/schema enumeration allocations still need separate qualification.
pub fn declared_query_index_fields(
    catalog: &Catalog,
    preferred: &[FieldRef],
    max_fields: usize,
    max_key_bytes: usize,
) -> Result<Vec<FieldRef>, IndexKeyError> {
    if !catalog.is_valid() {
        return Err(IndexKeyError::Invalid);
    }
    let cap = max_fields.min(MAX_DECLARED_QUERY_FIELDS);
    let declarations = query_index_fields(preferred, max_key_bytes)?;
    if declarations.len() > cap {
        return Err(IndexKeyError::TooWide);
    }
    let mut selected: BTreeMap<QueryField, FieldRef> = declarations
        .into_iter()
        .zip(preferred.iter().cloned())
        .collect();
    'types: for ty in catalog.types() {
        if selected.len() == cap {
            break;
        }
        for name in ty.schema.0.top_level_properties() {
            if selected.len() == cap {
                break 'types;
            }
            let field = FieldRef::Effective(vec![name]);
            let identity = query_index_fields(std::slice::from_ref(&field), max_key_bytes)?
                .pop()
                .ok_or(IndexKeyError::Invalid)?;
            selected.entry(identity).or_insert(field);
        }
    }
    Ok(selected.into_values().collect())
}

/// One indivisible, immutable catalog/spec/projection-generation capture.
///
/// Catalog compilation, declaration validation and resource fingerprinting happen
/// once. Rows then use exactly those captured defaults, memberships and fields;
/// callers cannot accidentally pair a catalog from one resource snapshot with a
/// generation from another. Resource enumeration is canonicalized for BOTH the
/// compiler and fingerprint. No source resources/documents are retained here.
///
/// This semantic capture does not prove index coverage, a current head, budgets,
/// authorization or durability. The caller still preflights hydration and commits
/// record/projection changes atomically, invalidating on projection failure.
#[derive(Debug)]
pub struct QueryProjectionContext {
    catalog: Arc<Catalog>,
    fields: Vec<FieldRef>,
    declarations: Vec<QueryField>,
    generation: QueryGeneration,
    max_key_bytes: usize,
}

impl QueryProjectionContext {
    /// Compile from the exact post-resource-effect snapshot. Invalid catalog
    /// configuration, duplicate resource paths and unsupported/duplicate fields
    /// fail explicitly. Core's type diagnostics remain available in `catalog()`;
    /// omitted invalid definitions never acquire invented fields/membership.
    pub fn capture(
        resources: &[(String, String)],
        sem: mdbn_wire::common::Sem,
        fields: &[FieldRef],
        max_key_bytes: usize,
    ) -> Result<Self, IndexKeyError> {
        Self::capture_selecting(resources, sem, max_key_bytes, |_| Ok(fields.to_vec()))
    }

    /// Compile the catalog ONCE and select its bounded declared-field profile.
    /// Preferred fields are caller configuration; unselected fields remain
    /// explicitly unsupported. No record hydration or index publication occurs.
    pub fn capture_declared(
        resources: &[(String, String)],
        sem: mdbn_wire::common::Sem,
        preferred: &[FieldRef],
        max_fields: usize,
        max_key_bytes: usize,
    ) -> Result<Self, IndexKeyError> {
        Self::capture_selecting(resources, sem, max_key_bytes, |catalog| {
            declared_query_index_fields(catalog, preferred, max_fields, max_key_bytes)
        })
    }

    fn capture_selecting(
        resources: &[(String, String)],
        sem: mdbn_wire::common::Sem,
        max_key_bytes: usize,
        select: impl FnOnce(&Catalog) -> Result<Vec<FieldRef>, IndexKeyError>,
    ) -> Result<Self, IndexKeyError> {
        let resources = canonical_query_resources(resources)?;
        let catalog = Catalog::load(resources.iter().map(|(path, doc)| (*path, *doc)));
        if !catalog.is_valid() {
            return Err(IndexKeyError::Invalid);
        }
        let fields = select(&catalog)?;
        let declarations = query_index_fields(&fields, max_key_bytes)?;
        let generation = query_generation_from_declarations(&resources, sem, &declarations)?;
        Ok(Self {
            catalog: Arc::new(catalog),
            fields,
            declarations,
            generation,
            max_key_bytes,
        })
    }

    /// The catalog compiled from this capture's exact resources.
    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// The semantic fingerprint, independent of record head or per-row hints.
    pub fn generation(&self) -> QueryGeneration {
        self.generation
    }

    /// Every configured neutral field, in declared order.
    pub fn fields(&self) -> &[QueryField] {
        &self.declarations
    }

    /// Exactly the configured Core references, in the same order as `fields()`.
    /// Callers need not reconstruct field identities from backend path bytes.
    pub fn field_refs(&self) -> &[FieldRef] {
        &self.fields
    }

    /// Project the actual record through the captured semantics. Does not read a
    /// Store or renew the caller's hydration budget. No catalog compilation,
    /// generation hashing or neutral declaration rebuilding takes place per row.
    pub fn project_row(&self, row: &RecordRow) -> Result<QueryIndexedRow, IndexKeyError> {
        project_query_row(
            &self.catalog,
            row,
            &self.fields,
            &self.declarations,
            self.max_key_bytes,
        )
    }
}

/// Confirmed state in a [`Store`], as a core `StateView`.
///
/// Store errors can't cross the core's infallible interface; the first one is kept
/// in [`StoreView::error`] and every later lookup answers "absent". Callers check
/// `error()` after planning and discard the plan if it is set.
pub struct StoreView<'a> {
    store: &'a dyn Store,
    catalog: Arc<Catalog>,
    error: RefCell<Option<StoreError>>,
    failed: Cell<bool>,
}

impl<'a> StoreView<'a> {
    /// A view over `store` with the catalog compiled from its resources.
    pub fn new(store: &'a dyn Store, catalog: Arc<Catalog>) -> StoreView<'a> {
        StoreView {
            store,
            catalog,
            error: RefCell::new(None),
            failed: Cell::new(false),
        }
    }

    /// Bounded exact source from the same authoritative resource table.
    /// Unlike the infallible StateView lookup, failures remain explicit here.
    pub(crate) fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> crate::store::StoreResult<Option<crate::store::BoundedResource>> {
        self.store.resource_bounded(path, copy_limit)
    }

    /// The first store error any lookup hit.
    pub fn error(&self) -> Option<StoreError> {
        self.error.borrow().clone()
    }

    fn ok<T: Default>(&self, r: Result<T, StoreError>) -> T {
        match r {
            Ok(v) => v,
            Err(e) => {
                if !self.failed.replace(true) {
                    *self.error.borrow_mut() = Some(e);
                }
                T::default()
            }
        }
    }
}

/// Compile the catalog from a store's resources.
pub fn load_catalog(store: &dyn Store) -> Result<Catalog, StoreError> {
    let rs = store.resources()?;
    Ok(Catalog::load(
        rs.iter().map(|(p, d)| (p.as_str(), d.as_str())),
    ))
}

impl StateView for StoreView<'_> {
    fn catalog(&self) -> Arc<Catalog> {
        self.catalog.clone()
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        let r = self.ok(self.store.record(&convert::wuuid(id)))?;
        Some(StoredRecord {
            id: *id,
            path: r.path,
            source: Arc::from(r.doc.as_str()),
        })
    }
    fn file(&self, id: &FileId) -> Option<StoredFile> {
        let f = self.ok(self.store.file(&convert::wuuid(id)))?;
        // The row's complete typed content, each arm to its own. A content
        // form this replica does not know is a store failure, never a blob.
        let content = match convert::file_content(&f.content) {
            Ok(c) => c,
            Err(e) => {
                self.ok(Err::<(), _>(StoreError::Corrupt(format!(
                    "file row {:?}: {e}",
                    f.id
                ))));
                return None;
            }
        };
        Some(StoredFile {
            id: *id,
            path: f.path,
            content,
            kind: convert::file_kind(f.kind),
        })
    }
    fn tombstone(&self, id: &CUuid) -> Option<Tombstone> {
        let t = self.ok(self.store.tombstone(&convert::wuuid(id)))?;
        Some(match t.last {
            TombstoneLast::Doc(d) => Tombstone::Record {
                path: t.path,
                doc: Arc::from(d.as_str()),
            },
            TombstoneLast::Blob(b) => Tombstone::File {
                path: t.path,
                content: FileContent::Blob(convert::blob(&b)),
                kind: FileKind::Ordinary,
            },
            TombstoneLast::Attachment(a) => Tombstone::File {
                path: t.path,
                content: FileContent::AttachmentV1(convert::attachment_content(&a)),
                kind: FileKind::Ordinary,
            },
            TombstoneLast::UnindexedMarkdown(p) => Tombstone::File {
                path: t.path,
                content: self.ok(convert::file_content(&p.content).map(Some).map_err(|e| {
                    StoreError::Corrupt(format!("unindexed tombstone content: {e}"))
                }))?,
                kind: FileKind::UnindexedOversizedMarkdown,
            },
        })
    }
    fn at_path_key(&self, path_key: &str) -> Option<PathHolder> {
        if let Some(id) = self.ok(self.store.record_at(path_key)) {
            return Some(PathHolder::Record(convert::uuid(&id)));
        }
        self.ok(self.store.file_at(path_key))
            .map(|id| PathHolder::File(convert::uuid(&id)))
    }
    fn alias(&self, path_key: &str) -> Option<RecordId> {
        self.ok(self.store.alias(path_key))
            .map(|id| convert::uuid(&id))
    }
    fn resource(&self, path: &str) -> Option<Arc<str>> {
        self.ok(self.store.resource(path))
            .map(|d| Arc::from(d.as_str()))
    }
    fn resource_paths(&self) -> Vec<String> {
        self.ok(self.store.resources())
            .into_iter()
            .map(|(p, _)| p)
            .collect()
    }
    fn settings(&self) -> FileInclusion {
        self.ok(self.store.settings())
            .map(|s| convert::inclusion(&s))
            .unwrap_or_default()
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let ks: Vec<String> = keys
            .iter()
            .map(|k| format!("{LINK_PREFIX}{}", k.0))
            .collect();
        self.ok(self.store.referrers(&ks))
            .iter()
            .map(convert::uuid)
            .collect()
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        let ks: Vec<String> = keys
            .iter()
            .map(|k| format!("{TARGET_PREFIX}{}", k.0))
            .collect();
        self.ok(self.store.referrers(&ks))
            .iter()
            .map(convert::uuid)
            .collect()
    }
    fn with_value(&self, field: &str, value: &CValue) -> Vec<RecordId> {
        self.ok(self.store.unique_holders(field, &value_key(value)))
            .iter()
            .map(convert::uuid)
            .collect()
    }
    fn record_ids(&self) -> Vec<RecordId> {
        let mut out = Vec::new();
        let mut after = None;
        loop {
            let page = self.ok(self.store.records(Page { after, limit: 1024 }));
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.id);
            out.extend(page.iter().map(|r| convert::uuid(&r.id)));
        }
        out
    }
}

/// Index of the pending queue by touched key, for rebasing only what changed.
///
/// Keys are `"i:<uuid hex>"` for records and files and `"r:<path>"` for resources.
#[derive(Debug, Clone, Default)]
pub struct TouchIndex {
    by_key: BTreeMap<String, std::collections::BTreeSet<u64>>,
}

impl TouchIndex {
    /// Record that pending row `order` touches `keys`.
    pub fn add(&mut self, order: u64, keys: &[String]) {
        for k in keys {
            self.by_key.entry(k.clone()).or_default().insert(order);
        }
    }

    /// Forget a pending row.
    pub fn remove(&mut self, order: u64, keys: &[String]) {
        for k in keys {
            if let Some(s) = self.by_key.get_mut(k) {
                s.remove(&order);
                if s.is_empty() {
                    self.by_key.remove(k);
                }
            }
        }
    }

    /// Pending rows touching any of `keys`, in capture order.
    pub fn affected<'k>(&self, keys: impl IntoIterator<Item = &'k String>) -> Vec<u64> {
        let mut out = std::collections::BTreeSet::new();
        for k in keys {
            if let Some(s) = self.by_key.get(k) {
                out.extend(s.iter().copied());
            }
        }
        out.into_iter().collect()
    }
}

/// The touch key of a record or file ID.
pub fn id_key(id: &mdbn_wire::common::Uuid) -> String {
    format!("i:{}", id.to_hex())
}

/// The touch key of a resource path.
pub fn resource_key(path: &str) -> String {
    format!("r:{path}")
}

/// Touch keys of a set of wire effects.
pub fn effect_keys(effects: &[mdbn_wire::entry::Effect]) -> Vec<String> {
    use mdbn_wire::entry::Effect as E;
    let mut out: Vec<String> = effects
        .iter()
        .map(|e| match e {
            E::PutRecord(p) => id_key(&p.id),
            E::RemoveRecord(p) => id_key(&p.id),
            E::PutFile(p) => id_key(&p.id),
            E::RemoveFile(p) => id_key(&p.id),
            E::PutResource(p) => resource_key(&p.path),
            E::RemoveResource(p) => resource_key(&p.path),
            E::PutSettings(_) => "s:".to_string(),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Touch keys a mutation names directly (IDs and resource paths in its ops).
pub fn mutation_keys(m: &mdbn_wire::intent::Mutation) -> Vec<String> {
    let mut out: Vec<String> = m.ops.iter().map(op_key).collect();
    out.sort();
    out.dedup();
    out
}

/// [`mutation_keys`] of a runtime-family mutation (a pending row): a
/// `file_attach` touches its File ID.
pub fn runtime_mutation_keys(m: &mdbn_wire::attachment_runtime_v1::Mutation) -> Vec<String> {
    use mdbn_wire::attachment_runtime_v1::Op as R;
    let mut out: Vec<String> = m
        .ops
        .iter()
        .map(|o| match o {
            R::Legacy(o) => op_key(o),
            R::FileAttach(f) => id_key(&f.id),
            R::UnindexedMarkdownPut(f) => id_key(&f.id),
            R::RecordToUnindexedMarkdown(f) => id_key(&f.id),
            R::UnindexedMarkdownToRecord(f) => id_key(&f.id),
            R::OrdinaryFileToRecord(f) => id_key(&f.id),
            R::OrdinaryAttachmentContinuation(f) => id_key(&f.id),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn op_key(o: &mdbn_wire::intent::Op) -> String {
    use mdbn_wire::intent::Op as O;
    match o {
        O::Create(c) => id_key(&c.id),
        O::Update(u) => id_key(&u.id),
        O::Document(d) => id_key(&d.id),
        O::Delete(d) => id_key(&d.id),
        O::Rename(r) => id_key(&r.id),
        O::ResourcePut(r) => resource_key(&r.path),
        O::ResourceDelete(r) => resource_key(&r.path),
        O::FilePut(f) => id_key(&f.id),
        O::FileDelete(f) => id_key(&f.id),
        O::FileMove(f) => id_key(&f.id),
        O::ConflictDismiss(c) => id_key(&c.record),
        O::SyncSettings(_) => "s:".to_string(),
    }
}
