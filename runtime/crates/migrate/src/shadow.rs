//! Shadow verify (hosted shadow verification, H5 and H7): the new replica's state
//! is compared with the old rows until they match.
//!
//! [`Expected`] is the old system's state in comparable form: generation 0, plus the
//! legacy changes read since `S0`. [`verify`] compares it with a replica `Store` and
//! lists every [`Difference`]. Cutover (H9) requires an empty list at `S_final`.
//!
//! The comparison is on identity and content digests, `(id, path, sha256)`, which is
//! exactly what a migration must preserve. Derived state (indexes, metadata) is the
//! replica's and is not compared. A legacy document over the record cap is expected
//! as a file with the same ID, path and digest (`gen0::is_oversize`).

use std::collections::BTreeMap;

use mdbn_legacy::hosted::source::Change;
use mdbn_replica::store::{Page, Store};
use mdbn_wire::common::{Hash, Uuid};

use crate::gen0::Gen0;
use crate::{Error, Result, ids};

/// The old system's state, comparable.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Expected {
    /// Record ID → (path, revision).
    pub records: BTreeMap<Uuid, (String, Hash)>,
    /// File ID → (path, content digest).
    pub files: BTreeMap<Uuid, (String, Hash)>,
    /// Resource path → revision.
    pub resources: BTreeMap<String, Hash>,
    /// The legacy sequence this state is at.
    pub legacy_seq: i64,
}

impl Expected {
    /// Generation 0.
    pub fn from_gen0(g: &Gen0) -> Self {
        Self {
            records: g
                .records
                .iter()
                .map(|r| (r.id, (r.path.clone(), r.revision)))
                .collect(),
            files: g
                .files
                .iter()
                .map(|f| (f.id, (f.path.clone(), f.blob.plain_hash)))
                .collect(),
            resources: g
                .resources
                .iter()
                .map(|(p, t)| (p.clone(), mdbn_wire::hash::sha256(t.as_bytes())))
                .collect(),
            legacy_seq: g.legacy_head,
        }
    }

    /// Apply legacy changes read at `head`. Resource changes carry no content, so the
    /// caller passes the resources as they are at `head` whenever `changes` includes
    /// one. [`apply`](Self::apply) refuses to guess.
    pub fn apply(
        &mut self,
        head: i64,
        changes: &[Change],
        resources_at_head: Option<&[(String, Vec<u8>)]>,
    ) -> Result<()> {
        let mut resources_changed = false;
        for c in changes {
            match c {
                Change::Record {
                    record_id, after, ..
                } => {
                    let id = ids::uuid(record_id)?;
                    // A document over the record cap is a file in the new state
                    // (`gen0::is_oversize`); the ID is one entity either way.
                    self.records.remove(&id);
                    self.files.remove(&id);
                    if let Some(r) = after {
                        let entry = (r.path.clone(), ids::revision(&r.revision)?);
                        if crate::gen0::is_oversize(r) {
                            self.files.insert(id, entry);
                        } else {
                            self.records.insert(id, entry);
                        }
                    }
                }
                Change::File { file_id, after, .. } => {
                    let id = ids::uuid(file_id)?;
                    match after {
                        Some(f) => {
                            self.files
                                .insert(id, (f.path.clone(), ids::revision(&f.content_digest)?));
                        }
                        None => {
                            self.files.remove(&id);
                        }
                    }
                }
                Change::Resource { .. } => resources_changed = true,
            }
        }
        if resources_changed {
            let now = resources_at_head.ok_or_else(|| {
                Error::Invalid("resource changes without the resources at head".into())
            })?;
            self.resources = now
                .iter()
                .map(|(p, b)| (p.clone(), mdbn_wire::hash::sha256(b)))
                .collect();
        }
        self.legacy_seq = head;
        Ok(())
    }
}

/// One way the new state differs from the old.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Difference {
    /// In the old rows, not in the new state.
    MissingRecord(Uuid),
    /// In the new state, not in the old rows.
    ExtraRecord(Uuid),
    /// Same ID, different path.
    RecordPath(Uuid),
    /// Same ID, different content.
    RecordContent(Uuid),
    /// As for records.
    MissingFile(Uuid),
    /// As for records.
    ExtraFile(Uuid),
    /// As for records.
    FilePath(Uuid),
    /// As for records.
    FileContent(Uuid),
    /// A resource path missing in the new state.
    MissingResource(String),
    /// A resource path only in the new state.
    ExtraResource(String),
    /// Same resource path, different content.
    ResourceContent(String),
}

/// Compare `expected` with the confirmed state in `store`.
pub fn verify(expected: &Expected, store: &dyn Store) -> Result<Vec<Difference>> {
    let err = |e| Error::Log(format!("store: {e}"));
    let mut out = Vec::new();

    let mut actual = BTreeMap::new();
    let mut after = None;
    loop {
        let page = store.records(Page { after, limit: 1024 }).map_err(err)?;
        let Some(last) = page.last() else { break };
        after = Some(last.id);
        for r in page {
            actual.insert(r.id, (r.path, r.revision));
        }
    }
    diff(&expected.records, &actual, &mut out, |k| match k {
        Kind::Missing(id) => Difference::MissingRecord(id),
        Kind::Extra(id) => Difference::ExtraRecord(id),
        Kind::Path(id) => Difference::RecordPath(id),
        Kind::Content(id) => Difference::RecordContent(id),
    });

    let mut actual = BTreeMap::new();
    let mut after = None;
    loop {
        let page = store.files(Page { after, limit: 1024 }).map_err(err)?;
        let Some(last) = page.last() else { break };
        after = Some(last.id);
        for f in page {
            actual.insert(f.id, (f.path, f.content.plain_hash()));
        }
    }
    diff(&expected.files, &actual, &mut out, |k| match k {
        Kind::Missing(id) => Difference::MissingFile(id),
        Kind::Extra(id) => Difference::ExtraFile(id),
        Kind::Path(id) => Difference::FilePath(id),
        Kind::Content(id) => Difference::FileContent(id),
    });

    let actual: BTreeMap<String, Hash> = store
        .resources()
        .map_err(err)?
        .into_iter()
        .map(|(p, t)| (p, mdbn_wire::hash::sha256(t.as_bytes())))
        .collect();
    for (p, h) in &expected.resources {
        match actual.get(p) {
            None => out.push(Difference::MissingResource(p.clone())),
            Some(a) if a != h => out.push(Difference::ResourceContent(p.clone())),
            _ => {}
        }
    }
    for p in actual.keys() {
        if !expected.resources.contains_key(p) {
            out.push(Difference::ExtraResource(p.clone()));
        }
    }
    Ok(out)
}

enum Kind {
    Missing(Uuid),
    Extra(Uuid),
    Path(Uuid),
    Content(Uuid),
}

fn diff(
    expected: &BTreeMap<Uuid, (String, Hash)>,
    actual: &BTreeMap<Uuid, (String, Hash)>,
    out: &mut Vec<Difference>,
    make: impl Fn(Kind) -> Difference,
) {
    for (id, (path, hash)) in expected {
        match actual.get(id) {
            None => out.push(make(Kind::Missing(*id))),
            Some((p, h)) => {
                if p != path {
                    out.push(make(Kind::Path(*id)));
                }
                if h != hash {
                    out.push(make(Kind::Content(*id)));
                }
            }
        }
    }
    for id in actual.keys() {
        if !expected.contains_key(id) {
            out.push(make(Kind::Extra(*id)));
        }
    }
}
