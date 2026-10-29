//! Coherent, bounded filesystem resource bootstrap, before ordinary documents.
use std::collections::{BTreeMap, BTreeSet};

use mdbn_core::types::{Catalog, definition_schema_refs};
use mdbn_core::validate::Severity;
use mdbn_wire::client::ReceiptState;
use mdbn_wire::common::Text;
use mdbn_wire::intent::{Op, ResourceDelete, ResourcePut, Source};

use super::{DiskKey, Replica, Shown, rev};
use crate::store::{Observation, Observed, Provenance, ResourcePathPage, Store, StoreError};

const INVENTORY: usize = 1024;
const OPERATIONS: usize = 64;
const BYTES: usize = 8 * 1024 * 1024;
const DOCUMENT: usize = 1024 * 1024;
const WORK: usize = 65536;

fn checked_insert(map: &mut BTreeMap<String, String>, path: &str, doc: &str) -> bool {
    if path.len() > 4096
        || doc.len() > DOCUMENT
        || map.len() >= INVENTORY && !map.contains_key(path)
    {
        return false;
    }
    let bytes = map.values().map(String::len).sum::<usize>();
    if bytes
        .saturating_sub(map.get(path).map_or(0, String::len))
        .saturating_add(doc.len())
        > BYTES
    {
        return false;
    }
    map.insert(path.to_owned(), doc.to_owned());
    true
}

fn apply(map: &mut BTreeMap<String, String>, o: &Observation) -> bool {
    if o.provenance != Provenance::Normal || mdbn_core::paths::check_path(&o.path).is_err() {
        return false;
    }
    if let Some(from) = &o.moved_from {
        if mdbn_core::paths::check_path(from).is_err() {
            return false;
        }
        map.remove(from);
    }
    match &o.now {
        Some(Observed::Text(doc)) => checked_insert(map, &o.path, doc),
        None => {
            map.remove(&o.path);
            true
        }
        Some(Observed::Attachment { .. }) => false,
    }
}

impl<S: Store> Replica<S> {
    /// Known local paths involved in the last deferred resource ingestion.
    /// Diagnostic only: this does not identify each path as a cause.
    pub fn resource_ingest_paths(&self) -> Vec<String> {
        self.resource_ingest_paths.iter().cloned().collect()
    }

    /// None means deferred: no observation in this round was acknowledged.
    pub(super) async fn ingest_resource_set(
        &mut self,
        mut observations: Vec<Observation>,
    ) -> Result<Option<Vec<Observation>>, StoreError> {
        self.check_apply_store_health()?;
        self.resource_ingest_paths.clear();
        let current = self.layer.catalog().unwrap_or_else(|| self.catalog.clone());
        if !observations.iter().any(|o| {
            current.is_resource_path(&o.path)
                || o.moved_from
                    .as_ref()
                    .is_some_and(|p| current.is_resource_path(p))
        }) {
            return Ok(Some(observations));
        }
        self.resource_ingest_paths
            .extend(observations.iter().flat_map(|o| {
                std::iter::once(&o.path)
                    .chain(o.moved_from.iter())
                    .filter(|path| current.is_resource_path(path))
                    .cloned()
            }));
        if observations.len() > WORK {
            return Ok(None);
        }
        self.store
            .defer_disk_observations(&observations.iter().map(|o| o.token).collect::<Vec<_>>())?;
        let mut sources = BTreeMap::new();
        let mut after = None::<String>;
        // A short page is not EOF; insist on an empty page and strict progress.
        loop {
            let paths = self.store.resource_paths_page(ResourcePathPage {
                after: after.as_deref(),
                prefix: None,
                limit: 64,
            })?;
            if paths.is_empty() {
                break;
            }
            for path in paths {
                self.resource_ingest_paths.insert(path.clone());
                if after.as_ref().is_some_and(|p| path <= *p)
                    || path.len() > 4096
                    || sources.len() >= INVENTORY
                {
                    return Ok(None);
                }
                let Some(doc) = self.store.resource_bounded(&path, DOCUMENT)? else {
                    return Err(StoreError::Corrupt(
                        "resource inventory source missing".into(),
                    ));
                };
                let Some(text) = doc.text else {
                    return Ok(None);
                };
                if doc.size != text.len() as u64 || !checked_insert(&mut sources, &path, &text) {
                    return Ok(None);
                }
                after = Some(path);
            }
        }
        let mut touched = 0;
        for (path, value) in self.layer.resource_changes() {
            self.resource_ingest_paths.insert(path.to_owned());
            touched += 1;
            if touched > INVENTORY {
                return Ok(None);
            }
            if let Some(doc) = value {
                if !checked_insert(&mut sources, path, doc) {
                    return Ok(None);
                }
            } else {
                sources.remove(path);
            }
        }
        // Configuration defines the folders; never guess a publisher path.
        for o in &mut observations {
            if [
                mdbn_core::types::CONFIG_PATH,
                mdbn_core::types::LOCK_PATH,
                mdbn_core::types::PROVISION_LOCK_PATH,
            ]
            .contains(&o.path.as_str())
            {
                self.resource_ingest_paths.insert(o.path.clone());
                if o.now.is_some() {
                    let Some(text) = self
                        .store
                        .resource_observation_text_async(o, DOCUMENT)
                        .await?
                    else {
                        return Ok(None);
                    };
                    self.check_apply_store_health()?;
                    o.now = Some(Observed::Text(text));
                }
                if !apply(&mut sources, o) {
                    return Ok(None);
                }
            }
        }
        let configured = Catalog::load(sources.iter().map(|(p, d)| (p.as_str(), d.as_str())));
        for o in &mut observations {
            if current.is_resource_path(&o.path)
                || configured.is_resource_path(&o.path)
                || o.moved_from
                    .as_ref()
                    .is_some_and(|p| current.is_resource_path(p))
            {
                self.resource_ingest_paths.insert(o.path.clone());
                if o.now.is_some() {
                    let Some(text) = self
                        .store
                        .resource_observation_text_async(o, DOCUMENT)
                        .await?
                    else {
                        return Ok(None);
                    };
                    self.check_apply_store_health()?;
                    o.now = Some(Observed::Text(text));
                }
                if !apply(&mut sources, o) {
                    return Ok(None);
                }
            }
        }
        // Raw references are only candidate discovery. The final compiled
        // catalog, not these declarations, decides resource classification.
        let mut targets = BTreeSet::new();
        for (path, doc) in &sources {
            self.resource_ingest_paths.insert(path.clone());
            let Ok(refs) = definition_schema_refs(path, doc) else {
                return Ok(None);
            };
            for target in refs {
                if target.len() > 4096 || targets.len() == INVENTORY {
                    return Ok(None);
                }
                targets.insert(target);
            }
        }
        let mut work = 0usize;
        for target in targets {
            self.resource_ingest_paths.insert(target.clone());
            let mut found = None;
            for (index, o) in observations.iter().enumerate() {
                work += 1;
                if work > WORK {
                    return Ok(None);
                }
                if o.path == target {
                    if found.is_some() {
                        return Ok(None);
                    }
                    found = Some(index);
                }
            }
            if let Some(index) = found {
                let o = &mut observations[index];
                if o.now.is_some() {
                    let Some(text) = self
                        .store
                        .resource_observation_text_async(o, DOCUMENT)
                        .await?
                    else {
                        return Ok(None);
                    };
                    self.check_apply_store_health()?;
                    o.now = Some(Observed::Text(text));
                }
                if !apply(&mut sources, o) {
                    return Ok(None);
                }
            }
        }
        let staged = Catalog::load(sources.iter().map(|(p, d)| (p.as_str(), d.as_str())));
        if !staged.is_valid()
            || staged
                .issues()
                .iter()
                .any(|i| i.severity == Severity::Error)
        {
            return Ok(None);
        }
        let mut selected = Vec::new();
        let mut rest = Vec::new();
        let mut seen = BTreeSet::new();
        let mut ops = Vec::new();
        for o in observations {
            if current.is_resource_path(&o.path)
                || staged.is_resource_path(&o.path)
                || o.moved_from
                    .as_ref()
                    .is_some_and(|p| current.is_resource_path(p))
            {
                if !seen.insert(mdbn_core::paths::path_key(&o.path)) {
                    return Ok(None);
                }
                if let Some(from) = &o.moved_from {
                    if !current.is_resource_path(from)
                        || !seen.insert(mdbn_core::paths::path_key(from))
                    {
                        return Ok(None);
                    }
                    ops.push(Op::ResourceDelete(ResourceDelete {
                        path: from.clone(),
                        base_revision: None,
                    }));
                }
                ops.push(match &o.now {
                    Some(Observed::Text(doc)) => Op::ResourcePut(ResourcePut {
                        path: o.path.clone(),
                        doc: Text::Inline(doc.clone()),
                        base_revision: None,
                        must_not_exist: None,
                    }),
                    None => Op::ResourceDelete(ResourceDelete {
                        path: o.path.clone(),
                        base_revision: None,
                    }),
                    Some(Observed::Attachment { .. }) => return Ok(None),
                });
                if ops.len() > OPERATIONS {
                    return Ok(None);
                }
                selected.push(o);
            } else {
                rest.push(o);
            }
        }
        if selected.is_empty() {
            return Ok(Some(rest));
        }
        self.check_apply_store_health()?;
        if !self
            .store
            .resource_observation_batch_complete_async(&selected)
            .await?
        {
            return Ok(None);
        }
        self.check_apply_store_health()?;
        for o in &selected {
            if !self.store.resource_observation_current_async(o).await? {
                return Ok(None);
            }
            self.check_apply_store_health()?;
        }
        let mut previous = BTreeMap::new();
        for o in &selected {
            let key = DiskKey::Resource(o.path.clone());
            previous
                .entry(key.clone())
                .or_insert_with(|| self.before.get(&key).cloned());
            if let Some(from) = &o.moved_from {
                let key = DiskKey::Resource(from.clone());
                previous
                    .entry(key.clone())
                    .or_insert_with(|| self.before.get(&key).cloned());
            }
            self.before.insert(
                DiskKey::Resource(o.path.clone()),
                match &o.now {
                    Some(Observed::Text(doc)) => Some(Shown {
                        path: o.path.clone(),
                        rev: rev(doc),
                    }),
                    _ => None,
                },
            );
            if let Some(from) = &o.moved_from {
                self.before.insert(DiskKey::Resource(from.clone()), None);
            }
        }
        let tokens = selected.iter().map(|o| o.token).collect::<Vec<_>>();
        let mutation = self.capture(ops, Source::Api);
        let receipt = self.queue_resource_observations(mutation, tokens.clone())?;
        if receipt.state != ReceiptState::Pending && receipt.state != ReceiptState::Confirmed {
            self.store
                .resource_observation_refused(&tokens, receipt.mutation)?;
            for (key, shown) in previous {
                if let Some(shown) = shown {
                    self.before.insert(key, shown);
                } else {
                    self.before.remove(&key);
                }
            }
            return Ok(None);
        }
        self.pump();
        self.check_apply_store_health()?;
        Ok(Some(rest))
    }
}
