//! Refused files: the disk keeps the bytes of a rejected change.
//!
//! Rejecting a pending change un-layers it, so the local view goes back to the
//! confirmed version. Publishing that would overwrite (or recreate, or delete)
//! the file the user just edited. Instead every record, file and resource a
//! rejected change touched is fenced: [`Replica::materialize`] publishes nothing
//! there, restart reconciliation leaves it alone, and the host shows a per-file
//! notice ([`Replica::refused_files`]).
//!
//! A fence ends when the user changes the file again: ingest releases it and
//! plans the new bytes from the local view. A confirmed change of a fenced
//! record from elsewhere becomes an ordinary conflict hold (mine: what the disk
//! shows; theirs: the new confirmed version). Persisted in
//! [`meta_keys::REFUSED`].

use std::collections::BTreeMap;

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{Hold, HoldReason, Problem};
use mdbn_wire::common::{B16, Text, Uuid};
use mdbn_wire::entry::Effect;
use mdbn_wire::intent::{Mutation, Op};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::TextOrBlob;

use super::Replica;
use super::disk::DiskKey;
use crate::store::{MetaPut, Store, StoreError, Tx, meta_keys};

/// One fenced file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RefusedFile {
    /// The record or file whose change was refused; `None` for a resource.
    pub(crate) id: Option<Uuid>,
    /// Where the disk keeps the refused bytes.
    pub(crate) path: String,
    /// Why the change was refused.
    pub(crate) problem: Problem,
    /// When (host clock).
    pub(crate) at: i64,
    /// A record's text as the disk shows it (empty: deleted), for a conflict
    /// hold. `None` for files and resources, which stay fenced instead.
    pub(crate) mine: Option<String>,
}

/// The fenced files, by path key.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Refused(BTreeMap<String, RefusedFile>);

fn key(path: &str) -> String {
    mdbn_core::paths::path_key(path)
}

impl Refused {
    /// Whether `id` or any of `paths` is fenced.
    pub(crate) fn fenced(&self, id: Option<B16>, paths: &[Option<&str>]) -> bool {
        paths.iter().flatten().any(|p| self.0.contains_key(&key(p)))
            || id.is_some_and(|i| self.0.values().any(|f| f.id == Some(i)))
    }

    /// Fence `files`, replacing earlier entries at the same paths.
    pub(crate) fn add(&mut self, files: Vec<RefusedFile>) {
        for f in files {
            self.0.insert(key(&f.path), f);
        }
    }

    /// Drop the entries for `id` or any of `paths`, returning them.
    pub(crate) fn remove(&mut self, id: Option<B16>, paths: &[Option<&str>]) -> Vec<RefusedFile> {
        let keys: Vec<String> = paths.iter().flatten().map(|p| key(p)).collect();
        let (gone, rest) = std::mem::take(&mut self.0)
            .into_iter()
            .partition(|(k, f)| keys.contains(k) || (id.is_some() && f.id == id));
        self.0 = rest;
        gone.into_values().collect()
    }

    pub(crate) fn meta(&self) -> MetaPut {
        (
            meta_keys::REFUSED.into(),
            (!self.0.is_empty()).then(|| encode(self)),
        )
    }
}

fn encode(refused: &Refused) -> Vec<u8> {
    let entries = refused
        .0
        .values()
        .map(|f| {
            Cbor::Array(vec![
                Cbor::Text(f.path.clone()),
                f.id.map_or(Cbor::Null, |i| Cbor::Bytes(i.0.to_vec())),
                f.problem.to_cbor(),
                Cbor::int(f.at),
                f.mine.clone().map_or(Cbor::Null, Cbor::Text),
            ])
        })
        .collect();
    cbor::encode(&Cbor::Array(entries)).unwrap_or_default()
}

/// The persisted fence (absent: empty).
pub(crate) fn decode(bytes: Option<&[u8]>) -> Result<Refused, &'static str> {
    let mut out = Refused::default();
    let Some(bytes) = bytes else {
        return Ok(out);
    };
    let Ok(Cbor::Array(entries)) = cbor::decode(bytes) else {
        return Err("not an array");
    };
    for e in entries {
        let Cbor::Array(e) = e else {
            return Err("entry");
        };
        let [Cbor::Text(path), id, problem, at, mine] = e.as_slice() else {
            return Err("entry");
        };
        let id = match id {
            Cbor::Null => None,
            Cbor::Bytes(b) => Some(B16(b.as_slice().try_into().map_err(|_| "id")?)),
            _ => return Err("id"),
        };
        let at = match at {
            Cbor::Uint(v) => i64::try_from(*v).map_err(|_| "at")?,
            Cbor::Nint(v) => -1 - i64::try_from(*v).map_err(|_| "at")?,
            _ => return Err("at"),
        };
        let mine = match mine {
            Cbor::Null => None,
            Cbor::Text(t) => Some(t.clone()),
            _ => return Err("mine"),
        };
        out.add(vec![RefusedFile {
            id,
            path: path.clone(),
            problem: Problem::from_cbor(problem).map_err(|_| "problem")?,
            at,
            mine,
        }]);
    }
    Ok(out)
}

/// What a change touches on disk: (ID, path, is a record), from its effects
/// and, for what is not layered (attachments, unplanned edits), its operations.
fn targets(mutation: &rt::Mutation, effects: &[Effect]) -> Vec<(Option<B16>, String, bool)> {
    let mut out = Vec::new();
    for e in effects {
        match e {
            Effect::PutRecord(p) => out.push((Some(p.id), p.path.clone(), true)),
            Effect::RemoveRecord(p) => out.push((Some(p.id), p.path.clone(), true)),
            Effect::PutFile(p) => out.push((Some(p.id), p.path.clone(), false)),
            Effect::RemoveFile(p) => out.push((Some(p.id), p.path.clone(), false)),
            Effect::PutResource(p) => out.push((None, p.path.clone(), false)),
            Effect::RemoveResource(p) => out.push((None, p.path.clone(), false)),
            _ => {}
        }
    }
    for op in &mutation.ops {
        match op {
            rt::Op::Legacy(Op::Document(d)) => {
                if let Some(v) = d.new.as_ref().or(d.base.as_ref()) {
                    out.push((Some(d.id), v.path.clone(), true));
                }
            }
            rt::Op::Legacy(Op::ResourcePut(r)) => out.push((None, r.path.clone(), false)),
            rt::Op::Legacy(Op::ResourceDelete(r)) => out.push((None, r.path.clone(), false)),
            rt::Op::Legacy(Op::FilePut(f)) => out.push((Some(f.id), f.path.clone(), false)),
            rt::Op::FileAttach(f) => out.push((Some(f.id), f.path.clone(), false)),
            rt::Op::OrdinaryAttachmentContinuation(f) => {
                out.push((Some(f.id), f.path.clone(), false));
            }
            _ => {}
        }
    }
    out
}

impl<S: Store> Replica<S> {
    /// Files whose change was rejected, kept as the user left them on disk,
    /// with why. Each clears when the file is changed again.
    pub fn refused_files(&self) -> impl ExactSizeIterator<Item = (&str, &Problem)> {
        self.refused
            .0
            .values()
            .map(|f| (f.path.as_str(), &f.problem))
    }

    /// The fence entries for rejected pending rows, read before they are
    /// un-layered: a record's text is what the local view (so the disk) shows.
    pub(crate) fn refused_rows(
        &self,
        rejected: &[(Uuid, Option<Uuid>, Problem)],
    ) -> Result<Vec<RefusedFile>, StoreError> {
        let mut out = Vec::new();
        if !self.store.has_files() {
            return Ok(out);
        }
        for (id, _, problem) in rejected {
            let Some(row) = self.store.pending_get(id)? else {
                continue;
            };
            out.extend(self.refused_targets(&row.mutation, &row.effects, problem));
        }
        Ok(out)
    }

    pub(crate) fn refused_targets(
        &self,
        mutation: &rt::Mutation,
        effects: &[Effect],
        problem: &Problem,
    ) -> Vec<RefusedFile> {
        let mut out: Vec<RefusedFile> = Vec::new();
        for (id, path, record) in targets(mutation, effects) {
            let shown = match id {
                Some(i) if record => self.local_view_doc(&DiskKey::Record(i)),
                _ => None,
            };
            let path = shown.as_ref().map_or(path, |(p, _)| p.clone());
            if out.iter().any(|f| f.id == id && key(&f.path) == key(&path)) {
                continue;
            }
            out.push(RefusedFile {
                id,
                path,
                problem: problem.clone(),
                at: self.now(),
                mine: record.then(|| shown.map(|(_, d)| d).unwrap_or_default()),
            });
        }
        out
    }

    /// The fence entries for an external edit refused before it was queued:
    /// the disk shows its new bytes (none: deleted).
    pub(crate) fn refused_edit(&self, m: &Mutation, problem: &Problem) -> Vec<RefusedFile> {
        m.ops
            .iter()
            .filter_map(|op| {
                let Op::Document(d) = op else {
                    return None;
                };
                let v = d.new.as_ref().or(d.base.as_ref())?;
                let mine = match &d.new {
                    Some(n) => match &n.doc {
                        Text::Inline(t) => t.clone(),
                        _ => return None,
                    },
                    None => String::new(),
                };
                Some(RefusedFile {
                    id: Some(d.id),
                    path: v.path.clone(),
                    problem: problem.clone(),
                    at: self.now(),
                    mine: Some(mine),
                })
            })
            .collect()
    }

    /// The user changed (or moved) a refused file: lift its fence so ingest
    /// takes the new bytes normally. Returns the lifted entries.
    pub(crate) fn release_refused(
        &mut self,
        id: Option<B16>,
        paths: &[Option<&str>],
    ) -> Result<Vec<RefusedFile>, StoreError> {
        if !self.refused.fenced(id, paths) {
            return Ok(Vec::new());
        }
        let mut rest = self.refused.clone();
        let lifted = rest.remove(id, paths);
        self.store.commit(Tx {
            meta: vec![rest.meta()],
            ..Tx::default()
        })?;
        self.refused = rest;
        self.status_dirty = true;
        Ok(lifted)
    }

    /// Apply of a confirmed entry touching fenced records, in its transaction:
    /// an own external edit of the record supersedes the fence; anything else
    /// becomes a conflict hold so the user's bytes are never published over.
    /// Files and resources stay fenced. Returns the fence to keep after commit.
    pub(crate) fn prepare_refused_holds(
        &self,
        effects: &[Effect],
        own_external: bool,
        tx: &mut Tx,
    ) -> Result<Option<Refused>, StoreError> {
        let mut rest = self.refused.clone();
        for e in effects {
            let (id, path) = match e {
                Effect::PutRecord(p) => (p.id, &p.path),
                Effect::RemoveRecord(p) => (p.id, &p.path),
                _ => continue,
            };
            let Some(f) = rest
                .0
                .values()
                .find(|f| f.id == Some(id) || key(&f.path) == key(path))
                .cloned()
            else {
                continue;
            };
            let Some(mine) = f.mine.clone() else {
                continue;
            };
            rest.remove(f.id, &[Some(&f.path)]);
            if own_external
                || self.store.hold(&id)?.is_some()
                || tx.holds_put.iter().any(|h| h.id == id)
            {
                continue;
            }
            let theirs = if let Some(r) = tx.records_put.iter().rev().find(|r| r.id == id) {
                Some(TextOrBlob::Text(r.doc.clone()))
            } else if tx.records_del.contains(&id) {
                None
            } else {
                self.store.record(&id)?.map(|r| TextOrBlob::Text(r.doc))
            };
            tx.holds_put.push(Hold {
                id,
                path: f.path.clone(),
                reason: HoldReason::Conflict,
                since: self.now(),
                base: self.store.record(&id)?.map(|r| TextOrBlob::Text(r.doc)),
                mine: TextOrBlob::Text(mine),
                theirs,
                saves: 1,
            });
        }
        if rest == self.refused {
            return Ok(None);
        }
        tx.meta.push(rest.meta());
        Ok(Some(rest))
    }
}
