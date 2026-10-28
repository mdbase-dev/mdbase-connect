//! Current-record diagnostics from Core, using the ordinary authorized local view.
use super::super::Replica;
use crate::api::{ApiResult, ErrorCode, RecordValidation, SessionId, Target, Validate};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::replica::submit::store_err;
use crate::store::{Page, Store};
use mdbn_core::ids::{FileId, RecordId, Uuid};
use mdbn_core::intent::{FileInclusion, OpClock};
use mdbn_core::links::LinkKey;
use mdbn_core::state::{PathHolder, StateView, StoredFile, StoredRecord, Tombstone};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value;
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::sync::Arc;

const RECORDS: usize = 1000;
const CALLS: usize = 4096;
const SOURCE_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_NODES: usize = 65536;
const OUTPUT_DEPTH: usize = 32;
fn budget() -> crate::api::ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "validation_budget",
        "Current-record validation exceeds its bounded work or output budget.",
    )
}

fn measure_nodes(value: &mdbn_wire::cbor::Cbor, nodes: &mut usize) -> ApiResult<()> {
    use mdbn_wire::cbor::Cbor;
    let mut stack = vec![(value, 1usize)];
    while let Some((v, depth)) = stack.pop() {
        *nodes = nodes.saturating_add(1);
        if *nodes > OUTPUT_NODES || depth > OUTPUT_DEPTH {
            return Err(budget());
        }
        match v {
            Cbor::Array(a) => {
                if a.len() > OUTPUT_NODES {
                    return Err(budget());
                }
                stack.extend(a.iter().map(|v| (v, depth + 1)));
            }
            Cbor::Map(m) => {
                if m.len() > OUTPUT_NODES / 2 {
                    return Err(budget());
                }
                stack.extend(m.iter().flat_map(|(k, v)| [(k, depth + 1), (v, depth + 1)]));
            }
            _ => {}
        }
    }
    Ok(())
}

impl<S: Store> Replica<S> {
    pub(super) fn validate_current(
        &self,
        session: SessionId,
        scope: Validate,
    ) -> ApiResult<Vec<RecordValidation>> {
        self.require(session, crate::policy::capability::READ)?;
        if let Validate::Targets(targets) = &scope {
            if targets.len() > RECORDS {
                return Err(budget());
            }
            if targets
                .iter()
                .any(|t| matches!(t, Target::Path(p) if p.is_empty() || p.len() > 4096))
            {
                return Err(ErrorCode::InvalidRequest.err_with_reason(
                    "validation_selection",
                    "Validation paths must be nonempty and at most 4096 UTF-8 bytes.",
                ));
            }
        }
        if self.layer.touched_count() > RECORDS {
            return Err(budget());
        }
        let overlay_bytes = self
            .layer
            .record_changes()
            .filter_map(|(_, r)| r.as_ref())
            .try_fold(0usize, |n, r| {
                let n = n
                    .saturating_add(r.source.len())
                    .saturating_add(r.path.len());
                if n > SOURCE_BYTES {
                    Err(budget())
                } else {
                    Ok(n)
                }
            })?;
        let view = StoreView::new(&self.store, self.catalog.clone());
        let local = LayerView {
            base: &view,
            layer: &self.layer,
        };
        let catalog = local.catalog();
        if catalog.types().len() > RECORDS {
            return Err(budget());
        }
        if !catalog.is_valid() {
            return Err(
                ErrorCode::CollectionInvalid.err("The current validation catalog is invalid.")
            );
        }
        let tz = self
            .session(session)?
            .tz
            .clone()
            .or_else(|| catalog.settings().timezone.clone())
            .unwrap_or_else(|| self.host.zones.default_zone());
        let instant_ms = self.now();
        let local_date = self.host.zones.local_date(instant_ms, &tz).ok_or_else(|| {
            ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", "Validation needs a known time zone.")
        })?;
        let clock = OpClock {
            instant_ms,
            tz,
            local_date,
        };
        let bounded = ValidationView {
            base: &local,
            replica: self,
            session,
            calls: Cell::new(0),
            bytes: Cell::new(overlay_bytes),
            overlay_bytes,
            exceeded: Cell::new(false),
            inventory: RefCell::new(None),
            failure: RefCell::new(None),
        };
        let mut rows = Rows::default();
        let mut page_full = false;
        let check = |id: RecordId, rows: &mut Rows| -> ApiResult<()> {
            let row = self.validation_row(&bounded, &view, &catalog, &clock, id)?;
            rows.push(row)
        };
        match scope {
            Validate::Targets(targets) => {
                let mut ids = Vec::with_capacity(targets.len());
                for target in &targets {
                    let id = self.resolve_target(&bounded, target);
                    if let Some(error) = view.error() {
                        return Err(store_err(error));
                    }
                    bounded.check()?;
                    ids.push(convert::uuid(&id.ok_or_else(|| {
                        ErrorCode::NotFound.err("No such validation record.")
                    })?));
                }
                for id in ids {
                    check(id, &mut rows)?;
                }
            }
            Validate::All => {
                for id in bounded.ids()? {
                    check(id, &mut rows)?;
                }
            }
            Validate::Page { after } => {
                // A page ends where the budget would be exceeded: the row being
                // checked is dropped whole and starts the next page.
                let mut ids = bounded.page_ids(after.as_ref().map(convert::uuid));
                while rows.len() < RECORDS {
                    let mark = rows.mark();
                    let checked = match ids.next(&bounded) {
                        None => break,
                        Some(Ok(id)) => check(id, &mut rows),
                        Some(Err(e)) => Err(e),
                    };
                    match checked {
                        Ok(()) => {}
                        Err(e) if !rows.is_empty() && is_budget(&e) && view.error().is_none() => {
                            rows.reset(mark);
                            page_full = true;
                            break;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        if let Some(error) = bounded.failure.borrow_mut().take() {
            return Err(error);
        }
        if !page_full {
            bounded.check()?;
        }
        self.require(session, crate::policy::capability::READ)?;
        Ok(rows.rows)
    }

    /// One record's diagnostics, metered by `bounded`.
    fn validation_row(
        &self,
        bounded: &ValidationView<'_, S>,
        view: &StoreView<'_>,
        catalog: &Catalog,
        clock: &OpClock,
        id: RecordId,
    ) -> ApiResult<RecordValidation> {
        let record = bounded.record(&id);
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        bounded.check()?;
        let record = record.ok_or_else(|| ErrorCode::NotFound.err("No such validation record."))?;
        if record.id != id {
            return Err(store_err(crate::store::StoreError::Corrupt(
                "validation record identity mismatch".into(),
            )));
        }
        let mut issues = mdbn_core::validate::validate_record_at(
            catalog,
            &record.path,
            &record.source,
            Some(clock),
        );
        issues.extend(mdbn_core::validate::cross_record_issues(bounded, id));
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        bounded.check()?;
        let issues = mdbn_core::validate::apply_level(issues, catalog.settings().validation, true);
        Ok(RecordValidation {
            id: convert::wuuid(&id),
            path: record.path,
            revision: mdbn_wire::hash::sha256(record.source.as_bytes()),
            issues,
        })
    }
}

fn is_budget(e: &crate::api::ApiError) -> bool {
    e.code() == Some(ErrorCode::TooLarge) && e.0.reason.as_deref() == Some("validation_budget")
}

/// Result rows with the output accounting: serialized size, CBOR nodes and
/// issue count, not a measured peak-heap claim.
struct Rows {
    rows: Vec<RecordValidation>,
    output: usize,
    nodes: usize,
    issues: usize,
}

impl Default for Rows {
    fn default() -> Self {
        Rows {
            rows: Vec::new(),
            output: 9, // Conservative outer-array header allowance.
            nodes: 1,
            issues: 0,
        }
    }
}

impl Rows {
    fn push(&mut self, row: RecordValidation) -> ApiResult<()> {
        self.issues = self.issues.saturating_add(row.issues.len());
        if self.issues > CALLS {
            return Err(budget());
        }
        let value = row.to_cbor();
        measure_nodes(&value, &mut self.nodes)?;
        self.output = self
            .output
            .saturating_add(mdbn_wire::cbor::encode(&value).map_err(|_| budget())?.len());
        if self.output > OUTPUT_BYTES {
            return Err(budget());
        }
        self.rows.push(row);
        Ok(())
    }
    fn len(&self) -> usize {
        self.rows.len()
    }
    fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    fn mark(&self) -> (usize, usize, usize) {
        (self.output, self.nodes, self.issues)
    }
    fn reset(&mut self, (output, nodes, issues): (usize, usize, usize)) {
        (self.output, self.nodes, self.issues) = (output, nodes, issues);
    }
}

/// Core's non-fallible StateView records a refusal, just as StoreView records
/// I/O faults. The caller always checks it before publishing any diagnostics.
struct ValidationView<'a, S: Store> {
    base: &'a dyn StateView,
    replica: &'a Replica<S>,
    session: SessionId,
    calls: Cell<usize>,
    bytes: Cell<usize>,
    overlay_bytes: usize,
    exceeded: Cell<bool>,
    inventory: RefCell<Option<Vec<RecordId>>>,
    failure: RefCell<Option<crate::api::ApiError>>,
}
impl<S: Store> ValidationView<'_, S> {
    fn check(&self) -> ApiResult<()> {
        if let Some(error) = self.failure.borrow_mut().take() {
            return Err(error);
        }
        if self.exceeded.get() {
            return Err(budget());
        }
        Ok(())
    }
    fn charge(&self, calls: usize, bytes: usize) -> bool {
        self.calls.set(self.calls.get().saturating_add(calls));
        self.bytes.set(self.bytes.get().saturating_add(bytes));
        if self.calls.get() > CALLS || self.bytes.get() > SOURCE_BYTES {
            self.exceeded.set(true);
        }
        !self.exceeded.get()
    }
    fn list(&self, ids: Vec<RecordId>) -> Vec<RecordId> {
        if self.charge(ids.len(), ids.len().saturating_mul(16)) {
            ids
        } else {
            vec![]
        }
    }
    fn ids(&self) -> ApiResult<Vec<RecordId>> {
        if let Some(ids) = self.inventory.borrow().as_ref() {
            return Ok(ids.clone());
        }
        let mut ids = BTreeSet::new();
        let mut after = None;
        loop {
            let page = self
                .replica
                .store
                .records(Page { after, limit: 128 })
                .map_err(store_err)?;
            if page.len() > 128 {
                return Err(budget());
            }
            let Some(last) = page.last() else {
                break;
            };
            if after.is_some_and(|a| last.id <= a) {
                return Err(ErrorCode::Internal.err("Validation inventory did not advance."));
            }
            for row in page {
                if after.is_some_and(|a| row.id <= a) {
                    return Err(
                        ErrorCode::Internal.err("Validation inventory is not strictly ordered.")
                    );
                }
                after = Some(row.id);
                if !self.charge(1, row.doc.len()) {
                    return Err(budget());
                }
                if !self.replica.layer.touches(&convert::uuid(&row.id)) {
                    ids.insert(convert::uuid(&row.id));
                }
                if ids.len() > RECORDS {
                    return Err(budget());
                }
            }
        }
        if self.replica.layer.touched_count() > RECORDS {
            return Err(budget());
        }
        for id in self.replica.layer.touched_ids() {
            if self.record(&id).is_some() {
                ids.insert(id);
            }
            if ids.len() > RECORDS {
                return Err(budget());
            }
        }
        self.check()?;
        let ids: Vec<_> = ids.into_iter().collect();
        self.inventory.replace(Some(ids.clone()));
        Ok(ids)
    }
}
/// Current record IDs after a cursor, in ID order: confirmed rows the local
/// view leaves alone, merged with the records it changes or adds. Fetched a few
/// rows at a time so a page reads little more than it checks.
struct PageIds {
    after: Option<RecordId>,
    touched: Vec<RecordId>,
    ready: std::collections::VecDeque<RecordId>,
    done: bool,
}

const PAGE_FETCH: u32 = 32;

impl<S: Store> ValidationView<'_, S> {
    fn page_ids(&self, after: Option<RecordId>) -> PageIds {
        PageIds {
            after,
            touched: self
                .replica
                .layer
                .touched_ids()
                .into_iter()
                .filter(|id| after.is_none_or(|a| *id > a))
                .collect(),
            ready: Default::default(),
            done: false,
        }
    }
}

impl PageIds {
    fn next<S: Store>(&mut self, view: &ValidationView<'_, S>) -> Option<ApiResult<RecordId>> {
        while self.ready.is_empty() && !self.done {
            if let Err(e) = self.fill(view) {
                self.done = true;
                return Some(Err(e));
            }
        }
        self.ready.pop_front().map(Ok)
    }

    fn fill<S: Store>(&mut self, view: &ValidationView<'_, S>) -> ApiResult<()> {
        let page = view
            .replica
            .store
            .records(Page {
                after: self.after.as_ref().map(convert::wuuid),
                limit: PAGE_FETCH,
            })
            .map_err(store_err)?;
        if page.len() > PAGE_FETCH as usize {
            return Err(budget());
        }
        let last = page.last().map(|r| convert::uuid(&r.id));
        if let (Some(a), Some(l)) = (self.after, last)
            && l <= a
        {
            return Err(ErrorCode::Internal.err("Validation inventory did not advance."));
        }
        self.done = page.len() < PAGE_FETCH as usize;
        let mut ids = BTreeSet::new();
        for row in page {
            if !view.charge(1, row.doc.len()) {
                return Err(budget());
            }
            let id = convert::uuid(&row.id);
            if !view.replica.layer.touches(&id) {
                ids.insert(id);
            }
        }
        // Local changes up to this fetch's last confirmed row (all of the rest
        // once the store has none left), when the local view holds a record.
        let split = match (self.done, last) {
            (false, Some(l)) => self.touched.partition_point(|id| *id <= l),
            _ => self.touched.len(),
        };
        for id in self.touched.drain(..split) {
            if view.base.record(&id).is_some() {
                ids.insert(id);
            }
        }
        self.after = last.or(self.after);
        self.ready.extend(ids);
        Ok(())
    }
}

impl<S: Store> StateView for ValidationView<'_, S> {
    fn catalog(&self) -> Arc<Catalog> {
        self.base.catalog()
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        if self.exceeded.get() {
            return None;
        }
        let record = self.base.record(id)?;
        if record.source.len() > 1024 * 1024 || record.path.len() > 4096 {
            self.exceeded.set(true);
            return None;
        }
        self.charge(1, record.source.len().saturating_add(record.path.len()))
            .then_some(record)
    }
    fn file(&self, id: &FileId) -> Option<StoredFile> {
        if !self.charge(1, 0) {
            return None;
        }
        let file = self.base.file(id)?;
        self.replica
            .file_visible(self.session, &file.path)
            .then_some(file)
    }
    fn tombstone(&self, id: &Uuid) -> Option<Tombstone> {
        self.charge(1, 0).then(|| self.base.tombstone(id)).flatten()
    }
    fn at_path_key(&self, path: &str) -> Option<PathHolder> {
        if !self.charge(1, path.len()) {
            return None;
        }
        let holder = self.base.at_path_key(path)?;
        match holder {
            PathHolder::File(id) => self.file(&id).map(|_| holder),
            _ => Some(holder),
        }
    }
    fn alias(&self, path: &str) -> Option<RecordId> {
        self.charge(1, path.len())
            .then(|| self.base.alias(path))
            .flatten()
    }
    fn resource(&self, path: &str) -> Option<Arc<str>> {
        if !self.charge(1, path.len()) {
            return None;
        }
        let resource = self.base.resource(path)?;
        self.charge(0, resource.len()).then_some(resource)
    }
    fn resource_paths(&self) -> Vec<String> {
        let paths = self.base.resource_paths();
        if self.charge(paths.len(), paths.iter().map(String::len).sum()) {
            paths
        } else {
            vec![]
        }
    }
    fn settings(&self) -> FileInclusion {
        self.base.settings()
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        if !self.charge(1 + self.replica.layer.touched_count(), self.overlay_bytes) {
            return vec![];
        }
        self.list(self.base.referrers(keys))
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        if !self.charge(1 + self.replica.layer.touched_count(), self.overlay_bytes) {
            return vec![];
        }
        self.list(self.base.link_targets(keys))
    }
    fn with_value(&self, field: &str, value: &Value) -> Vec<RecordId> {
        if !self.charge(1 + self.replica.layer.touched_count(), self.overlay_bytes) {
            return vec![];
        }
        self.list(self.base.with_value(field, value))
    }
    fn record_ids(&self) -> Vec<RecordId> {
        // Preserve the first real Store/budget refusal across further Core rules.
        if self.exceeded.get() {
            return vec![];
        }
        match self.ids() {
            Ok(ids) => ids,
            Err(error) => {
                self.failure.replace(Some(error));
                self.exceeded.set(true);
                vec![]
            }
        }
    }
}
