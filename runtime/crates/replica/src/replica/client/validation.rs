//! Current-record diagnostics from Core, using the ordinary authorized local view.
use super::super::Replica;
use crate::api::{ApiResult, ErrorCode, RecordValidation, SessionId, Target};
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
        targets: Option<Vec<Target>>,
    ) -> ApiResult<Vec<RecordValidation>> {
        self.require(session, crate::policy::capability::READ)?;
        if targets.as_ref().is_some_and(|v| v.len() > RECORDS) {
            return Err(budget());
        }
        if targets.as_ref().is_some_and(|v| {
            v.iter()
                .any(|t| matches!(t, Target::Path(p) if p.is_empty() || p.len() > 4096))
        }) {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "validation_selection",
                "Validation paths must be nonempty and at most 4096 UTF-8 bytes.",
            ));
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
        let ids = match targets {
            Some(targets) => {
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
                ids
            }
            None => bounded.ids()?,
        };
        let mut rows = Vec::new();
        let mut output = 9usize; // Conservative outer-array header allowance.
        let mut nodes = 1usize;
        let mut total_issues = 0usize;
        for id in ids {
            let record = bounded.record(&id);
            if let Some(error) = view.error() {
                return Err(store_err(error));
            }
            bounded.check()?;
            let record =
                record.ok_or_else(|| ErrorCode::NotFound.err("No such validation record."))?;
            if record.id != id {
                return Err(store_err(crate::store::StoreError::Corrupt(
                    "validation record identity mismatch".into(),
                )));
            }
            let mut issues = mdbn_core::validate::validate_record_at(
                &catalog,
                &record.path,
                &record.source,
                Some(&clock),
            );
            issues.extend(mdbn_core::validate::cross_record_issues(&bounded, id));
            if let Some(error) = view.error() {
                return Err(store_err(error));
            }
            bounded.check()?;
            let issues =
                mdbn_core::validate::apply_level(issues, catalog.settings().validation, true);
            total_issues = total_issues.saturating_add(issues.len());
            if total_issues > CALLS {
                return Err(budget());
            }
            let row = RecordValidation {
                id: convert::wuuid(&id),
                path: record.path,
                revision: mdbn_wire::hash::sha256(record.source.as_bytes()),
                issues,
            };
            // Serialized output accounting, not a measured peak-heap claim.
            let value = row.to_cbor();
            measure_nodes(&value, &mut nodes)?;
            output =
                output.saturating_add(mdbn_wire::cbor::encode(&value).map_err(|_| budget())?.len());
            if output > OUTPUT_BYTES {
                return Err(budget());
            }
            rows.push(row);
        }
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        bounded.check()?;
        self.require(session, crate::policy::capability::READ)?;
        Ok(rows)
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
