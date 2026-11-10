//! Holds, conflicts and per-file sync choices, including holds kept by the local takeover.

use super::*;

impl Daemon {
    /// `collection.holds`: the replica's holds, content-free.
    pub(super) async fn holds(&self, id: &str) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::Hold;
        // Files held at the takeover list beside the replica's own holds, and
        // even while the collection does not serve.
        let id = &self.registered_collection(id).await?;
        if let Ok(rt) = self.runtime_of(id).await {
            self.reconcile_takeover_resolutions(&rt, id).await?;
        }
        let taken = crate::takeover::held::open(&self.takeover_paths().legacy, id)
            .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
        let mut out = match self.runtime_of(id).await {
            Ok(rt) => {
                let result = host_call(&rt, "list_holds", mdbn_wire::cbor::Cbor::Null).await?;
                let holds: Vec<Hold> = Wire::from_cbor(&result)
                    .map_err(|_| ControlError::internal("the replica's holds do not decode"))?;
                holds.iter().map(hold_summary).collect::<Vec<_>>()
            }
            Err(e) if taken.is_empty() => return Err(e),
            Err(_) => Vec::new(),
        };
        out.extend(taken.iter().map(takeover_hold_summary));
        Ok(json!(out))
    }

    /// `collection.conflicts`: the replica's unresolved conflicts, content-free.
    pub(super) async fn conflicts(&self, id: &str) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::entry::ConflictKind;
        let rt = self.runtime_of(id).await?;
        let bad = || ControlError::internal("the replica's conflicts do not decode");
        let Cbor::Array(rows) = host_call(&rt, "list_conflicts", Cbor::Map(vec![])).await? else {
            return Err(bad());
        };
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let Cbor::Map(m) = row else {
                return Err(bad());
            };
            let at = |k: u64| {
                m.iter()
                    .find(|(key, _)| *key == Cbor::Uint(k))
                    .map(|(_, v)| v)
                    .ok_or_else(bad)
            };
            let mutation = mdbn_wire::common::Uuid::from_cbor(at(0)?).map_err(|_| bad())?;
            let Cbor::Uint(seq) = at(1)? else {
                return Err(bad());
            };
            let conflict =
                mdbn_wire::attachment_runtime_v1::Conflict::from_cbor(at(2)?).map_err(|_| bad())?;
            // The path, while a record with this ID exists (files have none here).
            let path = host_call(
                &rt,
                "get",
                Cbor::Map(vec![(Cbor::Uint(0), conflict.id.to_cbor())]),
            )
            .await
            .ok()
            .and_then(|v| mdbn_wire::client::RecordView::from_cbor(&v).ok())
            .map(|r| r.path);
            out.push(ConflictSummary {
                id: secrets::uuid_string(&conflict.id.0),
                path,
                kind: match conflict.kind {
                    ConflictKind::Field => "field",
                    ConflictKind::Frontmatter => "frontmatter",
                    ConflictKind::Body => "body",
                    ConflictKind::Path => "path",
                    ConflictKind::Delete => "delete",
                    ConflictKind::File => "file",
                }
                .into(),
                field: conflict.field,
                mutation: secrets::uuid_string(&mutation.0),
                seq: *seq,
            });
        }
        Ok(json!(out))
    }

    /// Accept the existing merge result, using the SDK's ordinary dismissal op.
    pub(super) async fn dismiss_conflict(
        &self,
        p: crate::control::DismissConflict,
    ) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::{Receipt, SubmitParams, WaitFor};
        use mdbn_wire::common::B16;
        use mdbn_wire::intent::{ConflictDismiss, Op};
        let prefix = p.id.replace('-', "").to_ascii_lowercase();
        if prefix.is_empty() || prefix.len() > 32 || !prefix.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(ControlError::invalid(
                "invalid_id",
                "id must be a UUID or UUID prefix",
            ));
        }
        let rows: Vec<ConflictSummary> =
            serde_json::from_value(self.conflicts(&p.collection).await?)
                .map_err(|e| ControlError::internal(e.to_string()))?;
        let matches: Vec<_> = rows
            .iter()
            .filter(|c| c.id.replace('-', "").starts_with(&prefix))
            .collect();
        let Some(first) = matches.first() else {
            return Err(ControlError::not_found(
                "no unresolved conflict matches that ID",
            ));
        };
        if matches.iter().any(|c| c.id != first.id) {
            return Err(ControlError::invalid(
                "ambiguous_conflict",
                "ID prefix matches several records; use a longer ID",
            ));
        }
        let uuid = |s: &str| -> Result<B16, ControlError> {
            secrets::hex_decode(&s.replace('-', ""))
                .ok()
                .and_then(|b| b.try_into().ok())
                .map(B16)
                .ok_or_else(|| ControlError::internal("the replica returned an invalid UUID"))
        };
        let mut ops = Vec::new();
        for c in matches {
            let op = Op::ConflictDismiss(ConflictDismiss {
                mutation: uuid(&c.mutation)?,
                record: uuid(&c.id)?,
            });
            if !ops.contains(&op) {
                ops.push(op);
            }
        }
        let rt = self.runtime_of(&p.collection).await?;
        let submit = SubmitParams {
            ops,
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: Some(WaitFor::Confirmed),
            validation: None,
        };
        let result = host_call(&rt, "submit", submit.to_cbor()).await?;
        let receipts: Vec<Receipt> = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
        let receipt = receipts
            .first()
            .ok_or_else(|| ControlError::internal("no receipt"))?;
        use mdbn_wire::client::ReceiptState;
        Ok(json!(HoldResolved {
            mutation: secrets::uuid_string(&receipt.mutation.0),
            state: match receipt.state {
                ReceiptState::Pending => "pending",
                ReceiptState::Confirmed => "confirmed",
                ReceiptState::Rejected => "rejected",
                ReceiptState::Unknown => "unknown",
            }
            .into(),
        }))
    }

    /// The collection's inclusion policy, as `describe` reports it.
    pub(super) async fn sync_files(&self, id: &str) -> Result<SyncFiles, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::intent::FileInclusion;
        let rt = self.runtime_of(id).await?;
        let bad = || ControlError::internal("the replica's description does not decode");
        let Cbor::Map(m) = host_call(&rt, "describe", Cbor::Map(vec![])).await? else {
            return Err(bad());
        };
        let (_, inclusion) = m
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(3))
            .ok_or_else(bad)?;
        let f = FileInclusion::from_cbor(inclusion).map_err(|_| bad())?;
        Ok(SyncFiles {
            include: f.include.into_iter().map(file_class).collect(),
            exclude: f.exclude.unwrap_or_default(),
            max_size: f.max_size,
        })
    }

    /// Replace the inclusion policy with an ordinary `sync_settings` mutation.
    pub(super) async fn set_sync_files(&self, p: SetSyncFiles) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::{Receipt, ReceiptState, SubmitParams, WaitFor};
        use mdbn_wire::intent::{FileInclusion, MediaClass, Op, SyncSettings};
        let mut exclude = Vec::with_capacity(p.files.exclude.len());
        for folder in &p.files.exclude {
            let folder = folder.trim_matches('/');
            if folder.is_empty()
                || folder
                    .split('/')
                    .any(|seg| seg.is_empty() || seg == "." || seg == "..")
            {
                return Err(ControlError::invalid(
                    "invalid_folder",
                    format!("`{folder}` is not a folder inside the collection"),
                ));
            }
            if !exclude.iter().any(|f: &String| f == folder) {
                exclude.push(folder.to_string());
            }
        }
        let mut include: Vec<MediaClass> = Vec::new();
        for c in &p.files.include {
            let m = match c {
                crate::control::FileClass::Image => MediaClass::Image,
                crate::control::FileClass::Audio => MediaClass::Audio,
                crate::control::FileClass::Video => MediaClass::Video,
                crate::control::FileClass::Pdf => MediaClass::Pdf,
                crate::control::FileClass::Other => MediaClass::Other,
            };
            if !include.contains(&m) {
                include.push(m);
            }
        }
        let inclusion = FileInclusion {
            include,
            exclude: (!exclude.is_empty()).then_some(exclude),
            max_size: p.files.max_size,
        };
        let rt = self.runtime_of(&p.collection).await?;
        let submit = SubmitParams {
            ops: vec![Op::SyncSettings(SyncSettings { inclusion })],
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: Some(WaitFor::Confirmed),
            validation: None,
        };
        let result = host_call(&rt, "submit", submit.to_cbor()).await?;
        let receipts: Vec<Receipt> = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
        if receipts
            .first()
            .is_none_or(|r| r.state == ReceiptState::Rejected)
        {
            return Err(ControlError::internal(
                "the replica rejected the file settings",
            ));
        }
        Ok(json!(self.sync_files(&p.collection).await?))
    }

    /// Read back the takeover hold resolutions still in flight for `collection`:
    /// a confirmed one resolves its hold, a rejected one is dropped (the hold
    /// stays open), and a pending or unknown one is left to read back again.
    async fn reconcile_takeover_resolutions(
        &self,
        rt: &Arc<crate::runtime::Runtime>,
        collection: &str,
    ) -> Result<(), ControlError> {
        let paths = self.takeover_paths();
        let io = |e: std::io::Error| ControlError::internal(format!("takeover holds: {e}"));
        if crate::takeover::held::in_flight(&paths.legacy, collection)
            .map_err(io)?
            .is_empty()
        {
            return Ok(());
        }
        let _run = self.takeover.run.lock().await;
        let mut settled = false;
        for (path, r) in crate::takeover::held::in_flight(&paths.legacy, collection).map_err(io)? {
            let Some(outcome) = read_back(rt, r.mutation).await? else {
                continue;
            };
            settled |= crate::takeover::held::settle(
                &paths.record,
                &paths.legacy,
                collection,
                &path,
                outcome,
            )
            .map_err(io)?;
        }
        drop(_run);
        if settled {
            self.bump();
        }
        Ok(())
    }

    /// Resolve a file held at the takeover. Keep this computer's: the folder
    /// already has it. Take the other: the old engine's version (or its
    /// delete) is written as this device's edit. Keep both: the old version is
    /// added beside it as `<name> (old version).md`. The hold is cleared only
    /// once that edit is confirmed: a pending or unknown one leaves it open, and
    /// asking again (or listing the holds) reads the same mutation back.
    async fn resolve_takeover_hold(&self, p: &ResolveHold) -> Result<Value, ControlError> {
        use crate::takeover::held::{self, Outcome};
        use mdbn_wire::intent::{Create, Delete, DocVersion, Document, Op};
        let collection = self.registered_collection(&p.collection).await?;
        let io = |e: std::io::Error| ControlError::internal(format!("takeover holds: {e}"));
        let _run = self.takeover.run.lock().await;
        let paths = self.takeover_paths();
        let held = held::open(&paths.legacy, &collection)
            .map_err(io)?
            .into_iter()
            .find(|h| h.id == p.id)
            .ok_or_else(|| ControlError::not_found(format!("no hold {}", p.id)))?;
        let how = match p.how {
            HoldAction::KeepMine => "keep_mine",
            HoldAction::TakeTheirs => "take_theirs",
            HoldAction::KeepBoth => "keep_both",
            HoldAction::Delete => "delete",
        };
        let in_flight = held::resolving(&paths.legacy, &collection, &held.path).map_err(io)?;
        if let Some(r) = &in_flight {
            if r.how != how {
                return Err(ControlError::new(
                    "conflict",
                    "resolution_pending",
                    "this file is already being resolved another way; ask again once that settles",
                ));
            }
            // Read the earlier submission back; resubmit only if the replica
            // has no receipt for it.
            let rt = self.runtime_of(&collection).await?;
            if let Some(outcome) = read_back(&rt, r.mutation).await? {
                return self.settle_takeover_hold(
                    &paths,
                    &collection,
                    &held.path,
                    r.mutation,
                    outcome,
                    _run,
                );
            }
        }
        let identity = in_flight.unwrap_or_else(|| held::Resolution {
            how: how.into(),
            mutation: new_uuid_v7(),
            record: new_uuid_v7(),
        });
        let ops = match p.how {
            HoldAction::KeepMine => Vec::new(),
            HoldAction::Delete => {
                return Err(ControlError::invalid(
                    "unsupported",
                    "files held at the takeover are resolved with keep_mine, take_theirs or keep_both",
                ));
            }
            HoldAction::TakeTheirs | HoldAction::KeepBoth => {
                let text = match &held.intended {
                    None => None,
                    Some(b) => Some(
                        std::str::from_utf8(b)
                            .ok()
                            .filter(|_| is_markdown_path(&held.path))
                            .ok_or_else(|| {
                                ControlError::invalid(
                                    "binary",
                                    "this file is not a note; keep this computer's version \
                                     (`keep_mine`) and restore the other one by hand",
                                )
                            })?
                            .to_string(),
                    ),
                };
                let rt = self.runtime_of(&p.collection).await?;
                let current = record_at(&rt, &held.path).await?;
                match (p.how, text) {
                    // The other version is a delete: there is nothing to keep beside.
                    (HoldAction::KeepBoth, None) => Vec::new(),
                    (HoldAction::KeepBoth, Some(t)) => {
                        let root = self.entry_root(&p.collection).await?;
                        let mut target = None;
                        for c in crate::takeover::held::keep_both_paths(&held.path) {
                            if !root.join(&c).exists() && record_at(&rt, &c).await?.is_none() {
                                target = Some(c);
                                break;
                            }
                        }
                        let target = target.ok_or_else(|| {
                            ControlError::new(
                                "conflict",
                                "no_free_name",
                                "no free name for the old version",
                            )
                        })?;
                        vec![Op::Create(Create {
                            id: mdbn_wire::common::B16(identity.record),
                            path: Some(target),
                            type_name: None,
                            frontmatter: None,
                            body: None,
                            document: Some(mdbn_wire::common::Text::Inline(t)),
                        })]
                    }
                    (_, Some(t)) => match current {
                        Some(r) => vec![Op::Document(Document {
                            id: r.id,
                            base: r.document.map(|d| DocVersion {
                                path: r.path.clone(),
                                doc: mdbn_wire::common::Text::Inline(d),
                            }),
                            new: Some(DocVersion {
                                path: held.path.clone(),
                                doc: mdbn_wire::common::Text::Inline(t),
                            }),
                            if_revision: Some(r.revision),
                        })],
                        None => vec![Op::Create(Create {
                            id: mdbn_wire::common::B16(identity.record),
                            path: Some(held.path.clone()),
                            type_name: None,
                            frontmatter: None,
                            body: None,
                            document: Some(mdbn_wire::common::Text::Inline(t)),
                        })],
                    },
                    (_, None) => match current {
                        Some(r) => vec![Op::Delete(Delete {
                            id: r.id,
                            base_revision: Some(r.revision),
                            if_revision: None,
                        })],
                        None => Vec::new(),
                    },
                }
            }
        };
        if ops.is_empty() {
            return self.settle_takeover_hold(
                &paths,
                &collection,
                &held.path,
                [0u8; 16],
                Outcome::Confirmed,
                _run,
            );
        }
        // The identity is durable before anything is submitted, so a retry
        // after any outcome reuses it.
        let identity = match held::begin(&paths.legacy, &collection, &held.path, how, || {
            (identity.mutation, identity.record)
        })
        .map_err(io)?
        {
            Ok(r) => r,
            Err(_) => {
                return Err(ControlError::new(
                    "conflict",
                    "resolution_pending",
                    "this file is already being resolved another way; ask again once that settles",
                ));
            }
        };
        let rt = self.runtime_of(&collection).await?;
        let outcome = submit_as(&rt, ops, identity.mutation).await?;
        self.settle_takeover_hold(
            &paths,
            &collection,
            &held.path,
            identity.mutation,
            outcome,
            _run,
        )
    }

    /// Settle a takeover hold resolution by its outcome (see
    /// `takeover::held::settle`) and answer for it.
    fn settle_takeover_hold(
        &self,
        paths: &crate::takeover::Paths,
        collection: &str,
        path: &str,
        mutation: [u8; 16],
        outcome: crate::takeover::held::Outcome,
        run: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<Value, ControlError> {
        use crate::takeover::held::Outcome;
        let resolved =
            crate::takeover::held::settle(&paths.record, &paths.legacy, collection, path, outcome)
                .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
        drop(run);
        if resolved {
            self.bump();
        }
        let state = match outcome {
            Outcome::Confirmed => "confirmed",
            Outcome::Pending => "pending",
            Outcome::Unknown => "unknown",
            Outcome::Rejected => {
                return Err(ControlError::new(
                    "conflict",
                    "rejected",
                    "the change was rejected; the hold stays open",
                ));
            }
        };
        Ok(json!(HoldResolved {
            mutation: secrets::uuid_string(&mutation),
            state: state.into(),
        }))
    }

    /// `collection.resolve_hold`: resolve one hold as the hosting app (the user's
    /// own device; the SDK resolves with content on behalf of an app grant).
    pub(super) async fn resolve_hold(&self, p: ResolveHold) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::client::{Receipt, ReceiptState};
        if p.id.starts_with(crate::takeover::held::ID_PREFIX) {
            let out = self.resolve_takeover_hold(&p).await;
            if out.is_ok() {
                // The last held file resolved lets Private sync turn on.
                self.spawn_auto_private();
            }
            return out;
        }
        let id: [u8; 16] = secrets::hex_decode(&p.id.replace('-', ""))
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| ControlError::invalid("invalid_id", "id is not a UUID"))?;
        let how: u64 = match p.how {
            HoldAction::KeepMine => 0,
            HoldAction::TakeTheirs => 1,
            HoldAction::Delete => 3,
            HoldAction::KeepBoth => 4,
        };
        let rt = self.runtime_of(&p.collection).await?;
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Bytes(id.to_vec())),
            (Cbor::Uint(1), Cbor::Uint(how)),
        ]);
        let result = host_call(&rt, "resolve_hold", params).await?;
        let receipt: Receipt = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
        let state = match receipt.state {
            ReceiptState::Pending => "pending",
            ReceiptState::Confirmed => "confirmed",
            ReceiptState::Rejected => "rejected",
            ReceiptState::Unknown => "unknown",
        };
        Ok(json!(HoldResolved {
            mutation: secrets::uuid_string(&receipt.mutation.0),
            state: state.into(),
        }))
    }
}

/// A content-free projection of one hold.
pub(super) fn hold_summary(h: &mdbn_wire::client::Hold) -> HoldSummary {
    use mdbn_wire::client::HoldReason;
    use mdbn_wire::snapshot::TextOrBlob;
    let reason = match h.reason {
        HoldReason::Conflict => "conflict",
        HoldReason::UnknownProvenance => "unknown_provenance",
        HoldReason::DeletedElsewhere => "deleted_elsewhere",
        HoldReason::ReadOnly => "read_only",
        HoldReason::EditorBusy => "editor_busy",
        HoldReason::SuspectWrite => "suspect_write",
    };
    HoldSummary {
        id: secrets::uuid_string(&h.id.0),
        path: h.path.clone(),
        reason: reason.into(),
        since: h.since,
        saves: h.saves,
        has_theirs: h.theirs.is_some(),
        binary: matches!(h.mine, TextOrBlob::Blob(_) | TextOrBlob::Attachment(_)),
    }
}

fn takeover_hold_summary(h: &crate::takeover::held::Held) -> HoldSummary {
    HoldSummary {
        id: h.id.clone(),
        path: h.path.clone(),
        reason: if h.unsent {
            crate::takeover::mirror_import::HOLD_REASON
        } else {
            crate::takeover::held::REASON
        }
        .into(),
        since: h.since,
        saves: 0,
        has_theirs: true,
        // An unsent edit is always text (other files were recovered instead).
        binary: (!h.unsent && !is_markdown_path(&h.path))
            || h.intended
                .as_ref()
                .is_some_and(|b| std::str::from_utf8(b).is_err()),
    }
}

fn is_markdown_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
}

/// One client-API request on a collection's runtime as the hosting app: a
/// `SessionAuth::Host` session (the daemon is the host; no grant, so the mutation
/// is the user's own device's), one request, then the session closes. The
/// replica's problem becomes the control error (same codes, §9).
fn file_class(m: mdbn_wire::intent::MediaClass) -> crate::control::FileClass {
    use crate::control::FileClass;
    use mdbn_wire::intent::MediaClass;
    match m {
        MediaClass::Image => FileClass::Image,
        MediaClass::Audio => FileClass::Audio,
        MediaClass::Video => FileClass::Video,
        MediaClass::Pdf => FileClass::Pdf,
        MediaClass::Other => FileClass::Other,
    }
}
