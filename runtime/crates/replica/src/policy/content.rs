//! Content items: `entry` and `base` checks, and what applying them records.

use super::*;

impl PolicyState {
    // ------------------------------------------------------------ content items

    /// V1 and V2 for an `entry`, from the clear header (`log-entry.md` §4.3).
    pub fn check_entry_header(&self, item: &Item, env: &Env<'_>) -> Verdict {
        if item.kind != ItemKind::Entry {
            return Err(void("kind", "not an entry"));
        }
        let signer = self.check_device_signature(item, env)?;
        if !self.device_can_write(&signer) {
            return Err(void("V1", "signer may not write content"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }

    /// V5 and V6 for an opened `entry` signed by `signer`. `ctx` resolves path keys
    /// and current file paths at `p − 1` for the `file_folders` check.
    pub fn check_entry_payload(
        &self,
        payload: &EntryPayload,
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        let ops: Vec<AnyOp<'_>> = payload.mutation.ops.iter().map(AnyOp::Legacy).collect();
        self.check_payload_ops(
            payload.sem.major,
            payload.mutation.on_behalf,
            payload.mutation.source,
            &ops,
            signer,
            ctx,
        )
    }

    /// [`Self::check_entry_payload`] for a runtime-family entry (`intent.md`
    /// §3.11): a `file_attach` needs exactly what a `file_put` of the same File
    /// needs (create or edit, and `file_folders`).
    pub fn check_runtime_entry_payload(
        &self,
        payload: &mdbn_wire::attachment_runtime_v1::EntryPayload,
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        use mdbn_wire::attachment_runtime_v1::Op as R;
        let native = |o: &R| {
            matches!(
                o,
                R::UnindexedMarkdownPut(_)
                    | R::RecordToUnindexedMarkdown(_)
                    | R::UnindexedMarkdownToRecord(_)
                    | R::OrdinaryFileToRecord(_)
            )
        };
        let native_body = payload.mutation.ops.iter().any(native)
            || payload.effects.iter().any(|e| {
                matches!(
                    e,
                    mdbn_wire::attachment_runtime_v1::Effect::PutUnindexedMarkdown(_)
                        | mdbn_wire::attachment_runtime_v1::Effect::ReindexUnindexedMarkdown(_)
                        | mdbn_wire::attachment_runtime_v1::Effect::ReindexOrdinaryFile(_)
                )
            })
            || payload.conflicts.iter().flatten().any(|c| {
                [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(|v| {
                        matches!(
                            v,
                            mdbn_wire::attachment_runtime_v1::ConflictValue::UnindexedMarkdown(_)
                        )
                    })
            });
        if payload
            .mutation
            .ops
            .iter()
            .any(|op| matches!(op, R::OrdinaryFileToRecord(_)))
            && payload.mutation.source != Source::Api
        {
            return Err(void(
                "V6",
                "ordinary promotion requires explicit device mediation",
            ));
        }
        if native_body {
            if payload.mutation.on_behalf.is_some() {
                return Err(Rejected::Stall(
                    "delegated T6b mediation is not supported".into(),
                ));
            }
            let d = self
                .active_device(signer)
                .ok_or_else(|| void("V1", "unknown T6b writer"))?;
            if !d.keyed || !self.editor_device(d) {
                return Err(void("V1", "T6b requires a keyed editor device"));
            }
            if self.frozen || self.rekey_required {
                return Err(void("V2", "T6b requires current healthy write authority"));
            }
        }
        let ops: Vec<AnyOp<'_>> = payload
            .mutation
            .ops
            .iter()
            .filter(|o| !native(o))
            .map(|o| match o {
                R::Legacy(o) => Ok(AnyOp::Legacy(o)),
                R::FileAttach(f) => Ok(AnyOp::Attach(f)),
                R::UnindexedMarkdownPut(_)
                | R::RecordToUnindexedMarkdown(_)
                | R::UnindexedMarkdownToRecord(_)
                | R::OrdinaryFileToRecord(_)
                | R::OrdinaryAttachmentContinuation(_) => Err(Rejected::Stall(
                    "extended runtime operation mediation not yet supported".into(),
                )),
            })
            .collect::<Result<_, _>>()?;
        self.check_payload_ops(
            payload.sem.major,
            payload.mutation.on_behalf,
            payload.mutation.source,
            &ops,
            signer,
            ctx,
        )
    }

    fn check_payload_ops(
        &self,
        sem_major: u64,
        on_behalf: Option<Uuid>,
        source: Source,
        ops: &[AnyOp<'_>],
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        if sem_major < self.sem_ratchet {
            return Err(void("V5", "semantics major below the ratchet"));
        }
        let Some(grant) = on_behalf else {
            return Ok(());
        };
        let g = self
            .effective_grant(&grant)
            .ok_or_else(|| void("V6", "on_behalf grant is not active, or not approved"))?;
        // The writer is bound to the grant. Only a device of the grant's
        // own account, or the hosted replica in `cloud-copy`, writes on its behalf.
        self.devices
            .get(signer)
            .filter(|d| d.active)
            .ok_or_else(|| void("V6", "on_behalf entry from an unknown device"))?;
        if !self.writer_serves_account(signer, &g.account) {
            return Err(void(
                "V6",
                "on_behalf entry from a device of another account",
            ));
        }
        let role = g.role;
        if source != Source::Api {
            return Err(void("V6", "external mutation on behalf of a grant"));
        }
        for op in ops {
            let cap = op.capability(ctx);
            if !g.capabilities.contains(cap) {
                return Err(void("V6", format!("grant lacks {cap}")));
            }
            if cap != capability::READ && role < Role::Editor {
                return Err(void("V6", "granting member may not write"));
            }
            if let Some(folders) = &g.file_folders {
                for p in op.file_paths(ctx) {
                    if !within_folders(&p, folders, ctx.path_key) {
                        return Err(void("V6", format!("{p} is outside file_folders")));
                    }
                }
            }
        }
        Ok(())
    }

    /// Record an applied (valid) entry: semantics ratchet and log time.
    pub fn note_entry(&mut self, seq: u64, sem_major: u64, instant: i64) {
        self.seq = seq;
        self.sem_ratchet = self.sem_ratchet.max(sem_major);
        self.log_time = self.log_time.max(instant);
        self.content_seen = true;
    }

    /// Header checks for a `base` item (`snapshot.md` §7).
    pub fn check_base_header(&self, item: &Item, env: &Env<'_>) -> Verdict {
        if item.kind != ItemKind::Base {
            return Err(void("kind", "not a base"));
        }
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        // Hosted signs only a `hosted-import` base, in cloud copy
        // ([`PolicyState::check_base_source`]).
        let hosted = d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy);
        if !d.keyed || !(self.editor_device(d) || hosted) {
            return Err(void(
                "V1",
                "base signer must be a keyed editor device, or hosted in cloud copy",
            ));
        }
        if self.content_seen {
            return Err(void("base", "an entry or base precedes it"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }

    /// An opened `base` payload's source fits its signer: hosted signs only a
    /// `hosted-import` base, and only in cloud copy (policy.md, hosted migration).
    pub fn check_base_source(
        &self,
        item: &Item,
        source: mdbn_wire::snapshot::BaseSource,
    ) -> Verdict {
        let hosted = item
            .signer
            .and_then(|s| self.devices.get(&s))
            .is_some_and(|d| d.kind == DeviceKind::Hosted);
        let import = source == mdbn_wire::snapshot::BaseSource::HostedImport;
        if hosted && !(import && self.cstate == Some(CState::CloudCopy)) {
            return Err(void(
                "base",
                "hosted signs only a hosted-import base in cloud copy",
            ));
        }
        Ok(())
    }

    /// The manifest named by an opened `base` payload must be in the item's refs.
    pub fn check_base_payload(&self, item: &Item, manifest: &B32) -> Verdict {
        if item.refs.as_ref().is_some_and(|r| r.contains(manifest)) {
            Ok(())
        } else {
            Err(void("base", "manifest not in refs"))
        }
    }

    /// Borrowed equivalent of check_base_header; same OLD typed signature,
    /// predicate order/errors, role/epoch rules. No currentness/install authority.
    /// Caller precharges shared input/metadata/hash work before invocation.
    pub fn check_base_header_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        env: &Env<'_>,
    ) -> Verdict {
        if item.kind() != ItemKind::Base {
            return Err(void("kind", "not a base"));
        }
        let signer = self.check_device_signature_borrowed(item, env)?;
        let d = &self.devices[&signer];
        let hosted = d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy);
        if !d.keyed || !(self.editor_device(d) || hosted) {
            return Err(void(
                "V1",
                "base signer must be a keyed editor device, or hosted in cloud copy",
            ));
        }
        if self.content_seen {
            return Err(void("base", "an entry or base precedes it"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch() != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }
    /// Borrowed equivalent of check_base_source; signer/source data is NOT a
    /// signature or current policy proof. Header checks remain separately required.
    pub fn check_base_source_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        source: mdbn_wire::snapshot::BaseSource,
    ) -> Verdict {
        let hosted = item
            .signer()
            .and_then(|s| self.devices.get(&s))
            .is_some_and(|d| d.kind == DeviceKind::Hosted);
        let import = source == mdbn_wire::snapshot::BaseSource::HostedImport;
        if hosted && !(import && self.cstate == Some(CState::CloudCopy)) {
            return Err(void(
                "base",
                "hosted signs only a hosted-import base in cloud copy",
            ));
        }
        Ok(())
    }
    /// Borrowed equivalent of check_base_payload. Ref presence is not complete
    /// authenticated reference/source closure or a native install capability.
    pub fn check_base_payload_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        manifest: &B32,
    ) -> Verdict {
        if item.refs().is_some_and(|r| r.contains(manifest)) {
            Ok(())
        } else {
            Err(void("base", "manifest not in refs"))
        }
    }

    /// Record an applied `base` at `seq` with chain hash `chain` (a control item:
    /// it advances `ctl_chain`).
    pub fn note_base(&mut self, seq: u64, chain: &B32) {
        self.advance_ctl(seq, chain);
        self.seq = seq;
        self.content_seen = true;
    }

    /// Record a void item: it still occupies its position. Pass `chain` for a
    /// control item (kinds 2–6, including a void `base` or `grant_approval`), so the
    /// control chain covers it; `None` for an `entry`.
    pub fn note_void(&mut self, seq: u64, control_chain: Option<&B32>) {
        if let Some(c) = control_chain {
            self.advance_ctl(seq, c);
        }
        self.seq = seq;
        self.voids += 1;
    }
}
