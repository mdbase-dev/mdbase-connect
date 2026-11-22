//! Holds, conflicts and per-file sync choices.

use super::*;

impl Daemon {
    /// `collection.holds`: the replica's holds, content-free.
    pub(super) async fn holds(&self, id: &str) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::Hold;
        let id = &self.registered_collection(id).await?;
        let rt = self.runtime_of(id).await?;
        let result = host_call(&rt, "list_holds", mdbn_wire::cbor::Cbor::Null).await?;
        let holds: Vec<Hold> = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's holds do not decode"))?;
        let out: Vec<_> = holds.iter().map(hold_summary).collect();
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

    /// `collection.resolve_hold`: resolve one hold as the hosting app (the user's
    /// own device; the SDK resolves with content on behalf of an app grant).
    pub(super) async fn resolve_hold(&self, p: ResolveHold) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::client::{Receipt, ReceiptState};
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
