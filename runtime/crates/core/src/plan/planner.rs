//! The planning loop: ops in order over an overlay, then the status.

use std::collections::BTreeSet;

use super::{
    Alias, Effect, PlanOptions, Planned, RecordIssue, RecordedConflict, RejectCode, Rejection,
    Stage, Status,
};
use crate::ids::RecordId;
use crate::intent::{ConflictMode, Level, Mutation, Op, Source};
use crate::lifecycle::GenStream;
use crate::paths::path_key;
use crate::state::{Overlay, StateView};

/// Planning state shared by the ops of one mutation.
pub(super) struct Ctx<'m> {
    pub m: &'m Mutation,
    pub stage: Stage,
    pub generated: GenStream,
    pub effects: Vec<Effect>,
    pub conflicts: Vec<RecordedConflict>,
    pub aliases: Vec<Alias>,
    pub fills: Vec<super::BaseTextFill>,
    pub issues: Vec<RecordIssue>,
    pub touches: BTreeSet<String>,
    pub link_rewrites: Vec<super::LinkRewrite>,
    pub broken_links: Vec<super::BrokenLink>,
    pub merged: bool,
    pub ends_batch: bool,
    /// Index of the op being planned.
    pub op: u32,
}

impl Ctx<'_> {
    /// Whether this is an `api` mutation.
    pub fn api(&self) -> bool {
        self.m.source == Source::Api
    }

    /// The submit validation level, when single-record issues may reject.
    pub fn submit_level(&self) -> Option<Level> {
        match self.stage {
            Stage::Submit { level } => Some(level),
            Stage::Head | Stage::Resurrect => None,
        }
    }

    /// Whether this is a resurrection plan (never rejects).
    pub fn resurrect(&self) -> bool {
        self.stage == Stage::Resurrect
    }

    /// Report a resolution taken in resurrection mode (or another
    /// non-blocking finding) on record `id`.
    pub fn note(
        &mut self,
        id: crate::ids::Uuid,
        code: &str,
        message: impl Into<String>,
        details: Option<crate::value::Value>,
    ) {
        let mut issue = crate::validate::Issue::new(
            code,
            crate::validate::Severity::Warning,
            crate::validate::Tier::Request,
            message,
        );
        issue.details = details;
        self.issues.push(RecordIssue { id, issue });
    }

    /// Record an effect and layer it onto the overlay.
    pub fn emit(&mut self, ov: &mut Overlay<'_>, e: Effect) {
        match &e {
            Effect::PutRecord { id, path, .. }
            | Effect::PutFile { id, path, .. }
            | Effect::PutAttachmentFile { id, path, .. }
            | Effect::PutUnindexedMarkdown { id, path, .. }
            | Effect::ReindexUnindexedMarkdown { id, path, .. }
            | Effect::ReindexOrdinaryFile { id, path, .. } => {
                self.touch_id(*id);
                self.touch_path(path);
            }
            Effect::RemoveRecord { id, path } | Effect::RemoveFile { id, path } => {
                self.touch_id(*id);
                self.touch_path(path);
            }
            Effect::PutResource { path, .. } | Effect::RemoveResource { path } => {
                self.touches.insert(format!("r:{path}"));
            }
            Effect::PutSettings(_) => {
                self.touches.insert("s:settings".into());
            }
        }
        ov.apply_effect(&e);
        self.effects.push(e);
    }

    /// Record an alias and layer it.
    pub fn alias(&mut self, ov: &mut Overlay<'_>, path: &str, id: RecordId) {
        let a = Alias {
            path: path.to_owned(),
            id,
        };
        ov.apply(&Planned {
            aliases: vec![a.clone()],
            ..Planned::noop()
        });
        self.aliases.push(a);
    }

    pub fn touch_id(&mut self, id: crate::ids::Uuid) {
        self.touches.insert(format!("i:{id}"));
    }

    pub fn touch_path(&mut self, path: &str) {
        self.touches.insert(format!("p:{}", path_key(path)));
    }

    /// Incoming links of `target` before an op, for [`Ctx::record_broken`].
    /// Submit-only preflight; empty at head and resurrection/re-execution.
    pub fn incoming(
        &self,
        ov: &Overlay<'_>,
        target: crate::ids::Uuid,
    ) -> Vec<crate::links::IncomingLink> {
        match self.stage {
            Stage::Submit { .. } => crate::links::links_to(ov, target),
            Stage::Head | Stage::Resurrect => Vec::new(),
        }
    }

    /// Record the `before` links that no longer resolve to `target` in `ov`,
    /// skipping referrers this op rewrote or removed.
    pub fn record_broken(
        &mut self,
        ov: &Overlay<'_>,
        target: crate::ids::Uuid,
        before: Vec<crate::links::IncomingLink>,
    ) {
        for inc in before {
            let rewritten = self
                .link_rewrites
                .iter()
                .any(|w| w.op_index == self.op && w.id == inc.id);
            let Some(now) = ov.record(&inc.id) else {
                continue;
            };
            if rewritten || crate::links::resolve(&inc.link, &now.path, ov).target() == Some(target)
            {
                continue;
            }
            self.broken_links.push(super::BrokenLink {
                op_index: self.op,
                target,
                id: inc.id,
                path: now.path,
                field: inc.link.field.as_ref().map(|(f, _)| f.clone()),
                value: inc.link.raw.clone(),
            });
        }
    }

    /// Record the rewrites of a reference update.
    pub fn record_rewrites(&mut self, updates: &[crate::links::ReferenceUpdate]) {
        for u in updates {
            for l in &u.links {
                self.link_rewrites.push(super::LinkRewrite {
                    op_index: self.op,
                    id: u.id,
                    path: u.path.clone(),
                    field: l.field.clone(),
                    old_value: l.old_value.clone(),
                    new_value: l.new_value.clone(),
                });
            }
        }
    }

    /// Attribute a rejection to the current op.
    pub fn reject(&self, r: Rejection) -> Rejection {
        if r.op_index.is_some() {
            r
        } else {
            r.at_op(self.op)
        }
    }
}

pub(super) fn run(
    m: &Mutation,
    state: &dyn StateView,
    opts: &PlanOptions,
) -> Result<Planned, Rejection> {
    let mut ov = Overlay::new(state);
    let mut ctx = Ctx {
        m,
        stage: opts.stage,
        generated: GenStream::new(m.seed),
        effects: Vec::new(),
        conflicts: Vec::new(),
        aliases: Vec::new(),
        fills: Vec::new(),
        issues: Vec::new(),
        touches: BTreeSet::new(),
        link_rewrites: Vec::new(),
        broken_links: Vec::new(),
        merged: false,
        ends_batch: false,
        op: 0,
    };
    let resource_batch = super::resources::stage_resource_batch(m, state);
    for (i, op) in m.ops.iter().enumerate() {
        ctx.op = u32::try_from(i).unwrap_or(u32::MAX);
        // Writes need a loadable catalog; observed external changes do not.
        let catalog = ov.catalog();
        let needs_catalog = ctx.api()
            && !matches!(
                op,
                Op::ResourcePut(_) | Op::ResourceDelete(_) | Op::ConflictDismiss(_)
            );
        if needs_catalog && !catalog.is_valid() && ctx.stage != Stage::Resurrect {
            let mut r = Rejection::new(
                RejectCode::CollectionInvalid,
                None,
                "the collection configuration does not load",
            );
            r.issues = catalog.issues().to_vec();
            return Err(ctx.reject(r));
        }
        let res = match op {
            Op::Create(c) => super::records::create(&mut ctx, &mut ov, c),
            Op::Update(u) => super::records::update(&mut ctx, &mut ov, u),
            Op::Document(d) => super::records::document(&mut ctx, &mut ov, d),
            Op::Delete(d) => super::records::delete(&mut ctx, &mut ov, d),
            Op::Rename(r) => super::records::rename(&mut ctx, &mut ov, r),
            Op::ResourcePut(r) => {
                super::resources::resource_put(&mut ctx, &mut ov, r, resource_batch.as_ref())
            }
            Op::ResourceDelete(r) => {
                super::resources::resource_delete(&mut ctx, &mut ov, r, resource_batch.as_ref())
            }
            Op::FilePut(f) => super::resources::file_put(&mut ctx, &mut ov, f),
            Op::FileAttach(f) => super::resources::file_attach(&mut ctx, &mut ov, f),
            Op::OrdinaryAttachmentContinuation(f) => {
                super::resources::ordinary_attachment_continuation(&mut ctx, &mut ov, f)
            }
            Op::UnindexedMarkdownPut(f) => {
                super::resources::unindexed_markdown_put(&mut ctx, &mut ov, f)
            }
            Op::RecordToUnindexedMarkdown(f) => {
                super::resources::record_to_unindexed_markdown(&mut ctx, &mut ov, f)
            }
            Op::UnindexedMarkdownToRecord(f) => {
                super::resources::unindexed_markdown_to_record(&mut ctx, &mut ov, f)
            }
            Op::OrdinaryFileToRecord(f) => {
                super::resources::ordinary_file_to_record(&mut ctx, &mut ov, f)
            }
            Op::FileDelete(f) => super::resources::file_delete(&mut ctx, &mut ov, f),
            Op::FileMove(f) => super::resources::file_move(&mut ctx, &mut ov, f),
            Op::ConflictDismiss(d) => {
                ctx.touch_id(d.record);
                Ok(())
            }
            Op::SyncSettings(s) => {
                ctx.emit(&mut ov, Effect::PutSettings(s.clone()));
                Ok(())
            }
        };
        match res {
            Ok(()) => {}
            // Resurrection never rejects. Every S-class check has a
            // resolution above; anything left is a request-tier failure the
            // original submit already passed, so the op is skipped and
            // reported rather than losing the rest of the write.
            Err(r) if ctx.stage == Stage::Resurrect => {
                let id = crate::ids::Uuid::NIL;
                ctx.note(
                    id,
                    "resurrect_skipped",
                    format!("op {}: {}", ctx.op, r.message),
                    None,
                );
                ctx.merged = true;
            }
            Err(r) => return Err(ctx.reject(r)),
        }
    }
    if let Some(batch) = &resource_batch {
        super::resources::validate_resource_batch(&mut ctx, &ov, batch)
            .map_err(|r| ctx.reject(r))?;
    }
    if m.conflict_mode == ConflictMode::Reject
        && ctx.api()
        && ctx.stage != Stage::Resurrect
        && !ctx.conflicts.is_empty()
    {
        let first = &ctx.conflicts[0];
        let mut r = Rejection::new(
            RejectCode::Conflict,
            Some("field"),
            format!(
                "a concurrent change conflicts with this write{}",
                first
                    .field
                    .as_ref()
                    .map(|f| format!(" (`{f}`)"))
                    .unwrap_or_default()
            ),
        );
        r.details = Some(crate::value::Value::string(first.id.to_string()));
        return Err(r);
    }
    let status = if !ctx.conflicts.is_empty() {
        Status::Conflicted
    } else if ctx.merged {
        Status::Merged
    } else {
        Status::Applied
    };
    Ok(Planned {
        sem: crate::semantics::SEM,
        status,
        effects: ctx.effects,
        conflicts: ctx.conflicts,
        aliases: ctx.aliases,
        base_text_fills: ctx.fills,
        issues: ctx.issues,
        ends_batch: ctx.ends_batch,
        touches: ctx.touches.into_iter().collect(),
        link_rewrites: ctx.link_rewrites,
        broken_links: ctx.broken_links,
    })
}
