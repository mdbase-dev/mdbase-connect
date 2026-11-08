//! Refused files: the disk keeps the bytes of a rejected change ([`fences`]).
//!
//! Rejecting a pending change un-layers it, so the local view goes back to the
//! confirmed version. Publishing that would overwrite (or recreate, or delete)
//! what the user just wrote. Instead every record and file a rejected change
//! targets is fenced: [`Replica::materialize`] and attachment fetch
//! publish nothing there, restart reconciliation leaves it alone, and the host
//! shows a per-file notice ([`Replica::refused_files`]).
//!
//! A fence ends when the user's next disk edit there is captured, in the
//! capture's own commit; a record edit is then planned from the version the
//! refused change was based on, so anything confirmed since (a snapshot or a
//! rollback included) merges or conflicts instead of being overwritten. A
//! confirmed entry applied to a fenced record becomes an ordinary conflict
//! hold (mine: what the disk shows; theirs: the new confirmed version).
//! Persisted in [`meta_keys::REFUSED`].

use std::collections::BTreeMap;

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{Hold, HoldReason, Problem};
use mdbn_wire::common::{B16, Text, Uuid};
use mdbn_wire::entry::Effect;
use mdbn_wire::intent::{Create, Delete, DocVersion, Op, Rename, Source, Update};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::TextOrBlob;

use super::Replica;
use crate::store::{MetaPut, Store, StoreError, Tx, meta_keys};

/// Whether a rejected row's files keep their bytes on disk (fenced) rather
/// than going back to the confirmed version: the user's own disk edits, and
/// on a store with files an app's write refused for the change itself (too
/// large, invalid, unencodable, a stale setup review), whose typed content the
/// app may not keep. Access and revocation rejections, and conflicts, revert.
pub(crate) fn fences(source: Source, problem: &Problem, has_files: bool) -> bool {
    let item = matches!(
        problem.code.as_str(),
        "too_large" | "invalid_request" | "invalid_record"
    ) || problem.reason.as_deref() == Some("setup_changed");
    source == Source::External || has_files && item
}

/// Whether the log's refusal of one change (`too_large`) rejects it. An app's
/// write on a store without files stays pending and the append stops instead,
/// so its content is not lost: these wait on the SDK keeping the app's draft
/// on a late rejection.
pub(crate) fn rejects_log_refusal(source: Source, has_files: bool) -> bool {
    source == Source::External || has_files
}

/// One fenced file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RefusedFile {
    /// The record or file whose change was refused.
    pub(crate) id: Option<Uuid>,
    /// Where the disk keeps the refused bytes.
    pub(crate) path: String,
    /// Why the change was refused.
    pub(crate) problem: Problem,
    /// When (host clock).
    pub(crate) at: i64,
    /// A record's text as the disk shows it (empty: deleted), for a conflict
    /// hold. `None` for files, which stay fenced instead.
    pub(crate) mine: Option<String>,
    /// The record version the refused edit was based on (none: a create).
    pub(crate) base: Option<DocVersion>,
    /// The refused change deleted the file.
    pub(crate) deleted: bool,
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
        self.get(id, paths).is_some()
    }

    /// The entry for `id`, else for the first fenced of `paths`.
    pub(crate) fn get(&self, id: Option<B16>, paths: &[Option<&str>]) -> Option<&RefusedFile> {
        id.and_then(|i| self.0.values().find(|f| f.id == Some(i)))
            .or_else(|| paths.iter().flatten().find_map(|p| self.0.get(&key(p))))
    }

    /// Fence `files`, replacing earlier entries at the same paths.
    pub(crate) fn add(&mut self, files: Vec<RefusedFile>) {
        for f in files {
            self.0.insert(key(&f.path), f);
        }
    }

    /// Drop the entries for any of `ids` or `paths`. Returns whether any was.
    fn remove(&mut self, ids: &[Option<B16>], paths: &[&str]) -> bool {
        let n = self.0.len();
        self.0.retain(|k, f| {
            let named = paths.iter().any(|p| key(p) == *k);
            !(named || f.id.is_some() && ids.contains(&f.id))
        });
        self.0.len() != n
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
                f.base.as_ref().map_or(Cbor::Null, Wire::to_cbor),
                Cbor::Bool(f.deleted),
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
        let [
            Cbor::Text(path),
            id,
            problem,
            at,
            mine,
            base,
            Cbor::Bool(deleted),
        ] = e.as_slice()
        else {
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
        let base = match base {
            Cbor::Null => None,
            b => Some(DocVersion::from_cbor(b).map_err(|_| "base")?),
        };
        out.add(vec![RefusedFile {
            id,
            path: path.clone(),
            problem: Problem::from_cbor(problem).map_err(|_| "problem")?,
            at,
            mine,
            base,
            deleted: *deleted,
        }]);
    }
    Ok(out)
}

/// One record or file a change targets.
struct Target {
    id: Uuid,
    path: String,
    mine: Option<String>,
    base: Option<DocVersion>,
    deleted: bool,
}

fn inline(t: &Text) -> Option<String> {
    match t {
        Text::Inline(s) => Some(s.clone()),
        Text::Index(_) => None,
    }
}

impl<S: Store> Replica<S> {
    /// Files whose change was rejected, kept as the user left them, with
    /// why and whether the edit was a delete. Each clears when the user's next
    /// change there is captured.
    pub fn refused_files(&self) -> impl ExactSizeIterator<Item = (&str, &Problem, bool)> {
        self.refused
            .0
            .values()
            .map(|f| (f.path.as_str(), &f.problem, f.deleted))
    }

    /// The fence entries for rejected pending rows ([`fences`]).
    pub(crate) fn refused_rows(
        &self,
        rejected: &[(Uuid, Option<Uuid>, Problem)],
    ) -> Result<Vec<RefusedFile>, StoreError> {
        let mut out = Vec::new();
        if !self.store.has_files() && !self.store.materializes_attachments() {
            return Ok(out);
        }
        for (id, _, problem) in rejected {
            let Some(row) = self.store.pending_get(id)? else {
                continue;
            };
            if fences(row.mutation.source, problem, self.store.has_files()) {
                out.extend(self.refused_targets(&row.mutation, &row.effects, problem)?);
            }
        }
        Ok(out)
    }

    /// What a change targets, from its operations alone (never files a
    /// planner rewrote along with it). An app's record write is found in its
    /// planned `effects`, based on the confirmed record.
    fn targets(&self, m: &rt::Mutation, effects: &[Effect]) -> Result<Vec<Target>, StoreError> {
        let file = |id: Uuid, path: &str| Target {
            id,
            path: path.to_string(),
            mine: None,
            base: None,
            deleted: false,
        };
        let mut out = Vec::new();
        for op in &m.ops {
            match op {
                rt::Op::Legacy(Op::Document(d)) => {
                    let Some(v) = d.new.as_ref().or(d.base.as_ref()) else {
                        continue;
                    };
                    out.push(Target {
                        mine: match &d.new {
                            Some(n) => inline(&n.doc),
                            None => Some(String::new()),
                        },
                        base: d.base.clone(),
                        deleted: d.new.is_none(),
                        ..file(d.id, &v.path)
                    });
                }
                rt::Op::Legacy(
                    Op::Create(Create { id, .. })
                    | Op::Update(Update { id, .. })
                    | Op::Delete(Delete { id, .. })
                    | Op::Rename(Rename { id, .. }),
                ) => {
                    let Some((path, mine, deleted)) = effects.iter().rev().find_map(|e| match e {
                        Effect::PutRecord(p) if p.id == *id => {
                            Some((&p.path, inline(&p.doc), false))
                        }
                        Effect::RemoveRecord(r) if r.id == *id => {
                            Some((&r.path, Some(String::new()), true))
                        }
                        _ => None,
                    }) else {
                        continue;
                    };
                    out.push(Target {
                        mine,
                        base: self.store.record(id)?.map(|r| DocVersion {
                            path: r.path,
                            doc: Text::Inline(r.doc),
                        }),
                        deleted,
                        ..file(*id, path)
                    });
                }
                rt::Op::Legacy(Op::FilePut(f)) => out.push(file(f.id, &f.path)),
                rt::Op::Legacy(Op::FileMove(f)) => out.push(file(f.id, &f.to)),
                rt::Op::Legacy(Op::FileDelete(f)) => {
                    if let Some(row) = self.store.file(&f.id)? {
                        out.push(Target {
                            deleted: true,
                            ..file(f.id, &row.path)
                        });
                    }
                }
                rt::Op::FileAttach(f) => out.push(file(f.id, &f.path)),
                rt::Op::OrdinaryAttachmentContinuation(f) => out.push(file(f.id, &f.path)),
                rt::Op::UnindexedMarkdownPut(f) => out.push(file(f.id, &f.path)),
                rt::Op::RecordToUnindexedMarkdown(f) => out.push(file(f.id, &f.path)),
                rt::Op::UnindexedMarkdownToRecord(f) => out.push(file(f.id, &f.path)),
                rt::Op::OrdinaryFileToRecord(f) => out.push(file(f.id, &f.path)),
                // Resources and settings are not fenced.
                rt::Op::Legacy(_) => {}
            }
        }
        Ok(out)
    }

    /// The fence entries for a refused change.
    pub(crate) fn refused_targets(
        &self,
        m: &rt::Mutation,
        effects: &[Effect],
        problem: &Problem,
    ) -> Result<Vec<RefusedFile>, StoreError> {
        Ok(self
            .targets(m, effects)?
            .into_iter()
            .map(|t| RefusedFile {
                id: Some(t.id),
                path: t.path,
                problem: problem.clone(),
                at: self.now(),
                mine: t.mine,
                base: t.base,
                deleted: t.deleted,
            })
            .collect())
    }

    /// A captured disk edit ends the fence of what it targets, in the capture's
    /// commit. Returns the fence to keep once `tx` commits.
    pub(crate) fn release_refused(
        &self,
        m: &rt::Mutation,
        tx: &mut Tx,
    ) -> Result<Option<Refused>, StoreError> {
        if m.source != Source::External || self.refused.0.is_empty() {
            return Ok(None);
        }
        let mut ids = Vec::new();
        let mut paths = Vec::new();
        for op in &m.ops {
            if let rt::Op::Legacy(Op::Document(d)) = op {
                // A move or delete names the record's other path as its base.
                if let Some(b) = &d.base {
                    paths.push(b.path.clone());
                }
            }
        }
        for t in self.targets(m, &[])? {
            ids.push(Some(t.id));
            paths.push(t.path);
        }
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        let mut rest = self.refused.clone();
        if !rest.remove(&ids, &paths) {
            return Ok(None);
        }
        tx.meta.push(rest.meta());
        Ok(Some(rest))
    }

    /// Keep the fence `release_refused` left, once its transaction committed.
    pub(crate) fn refused_released(&mut self, rest: Option<Refused>) {
        if let Some(rest) = rest {
            self.refused = rest;
            self.status_dirty = true;
        }
    }

    /// The user's file kept the local view after all (a revert): its fence
    /// ends with the acknowledgement.
    pub(crate) fn ack_releasing(
        &mut self,
        token: crate::store::ObservationId,
        id: Option<B16>,
        path: &str,
    ) -> Result<(), StoreError> {
        let mut rest = self.refused.clone();
        let mut tx = Tx {
            ack_observations: vec![token],
            ..Tx::default()
        };
        let released = rest.remove(&[id], &[path]);
        if released {
            tx.meta.push(rest.meta());
        }
        self.store.commit(tx)?;
        self.refused_released(released.then_some(rest));
        Ok(())
    }

    /// Apply of a confirmed entry touching fenced records, in its transaction:
    /// an own external edit of the record supersedes the fence; anything else
    /// becomes a conflict hold so the user's bytes are never published over.
    /// Matched by record ID only. Files stay fenced. Returns the fence to keep
    /// after commit.
    pub(crate) fn prepare_refused_holds(
        &self,
        effects: &[Effect],
        own_external: bool,
        tx: &mut Tx,
    ) -> Result<Option<Refused>, StoreError> {
        let mut rest = self.refused.clone();
        for e in effects {
            let id = match e {
                Effect::PutRecord(p) => p.id,
                Effect::RemoveRecord(p) => p.id,
                _ => continue,
            };
            let Some(f) = rest.0.values().find(|f| f.id == Some(id)).cloned() else {
                continue;
            };
            let Some(mine) = f.mine.clone() else {
                continue;
            };
            rest.remove(&[f.id], &[]);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ErrorCode;

    /// Who keeps a rejected change's bytes: a disk edit always; an app's write
    /// only on a store with files and only for the change itself.
    #[test]
    fn which_rejections_are_fenced() {
        let mut revoked = ErrorCode::Forbidden.problem("revoked");
        revoked.reason = Some("revoked_after_loss".into());
        let too_large = ErrorCode::TooLarge.problem_with_reason("item_bytes", "too large");
        let setup = ErrorCode::Conflict.problem_with_reason("setup_changed", "review again");
        for (source, problem, files, fenced) in [
            (Source::External, &revoked, true, true),
            (Source::External, &too_large, true, true),
            (Source::Api, &too_large, true, true),
            (
                Source::Api,
                &ErrorCode::InvalidRequest.problem("bad"),
                true,
                true,
            ),
            (Source::Api, &setup, true, true),
            (Source::Api, &too_large, false, false),
            (Source::Api, &revoked, true, false),
            (
                Source::Api,
                &ErrorCode::Unauthenticated.problem("no session"),
                true,
                false,
            ),
            (
                Source::Api,
                &ErrorCode::Forbidden.problem("no capability"),
                true,
                false,
            ),
            (
                Source::Api,
                &ErrorCode::Conflict.problem("path taken"),
                true,
                false,
            ),
        ] {
            assert_eq!(
                fences(source, problem, files),
                fenced,
                "{source:?} {problem:?} {files}"
            );
        }
        assert!(rejects_log_refusal(Source::External, false));
        assert!(rejects_log_refusal(Source::Api, true));
        assert!(!rejects_log_refusal(Source::Api, false));
    }
}
