//! Runtime selection of the `attachment_runtime_v1` codec family (`intent.md`
//! §3.11, `log-entry.md` §2.5, `snapshot.md` §3.1).
//!
//! Every synced entry, snapshot manifest and snapshot chunk this build reads is
//! decoded ONCE with the explicit runtime family, never retried with the legacy
//! decoder. Synced entries apply in that family, attachment content included
//! (T5, `apply.rs`). Snapshot content carrying a critical attachment child
//! (Sections 10/11, a ConflictValue5 row) decodes but is not yet installed: the
//! caller stalls the WHOLE install with [`AttachmentNotYet`] (reported as
//! `upgrade_required`), never skipping a child or installing a prefix (T7).
//! [`entry`] (legacy selection) remains for paths that have no attachment
//! support yet, such as the hosted owner check, which fail closed.
//!
//! Ops14–17, Effects9–11, ConflictValue6 and Sections12/13 now decode as closed
//! data. Until their mediation/apply/install slices land, every such child stalls
//! the WHOLE parent. Unknown future children still fail decoding.

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::entry::{Conflict, ConflictValue, Effect, EntryPayload};
use mdbn_wire::intent::{Mutation, Op};
use mdbn_wire::schema::Wire;

/// The bare app↔replica `hello` feature: this build decodes the attachment
/// runtime family. It grants no read/write/materialize direction.
pub(crate) const ATTACHMENT_V1_FEATURE: &str = "attachment-v1";

/// Stable reason code for decoded-but-unapplied attachment content.
pub(crate) const NOT_YET: &str = "attachment_apply_not_yet";

/// A decoded critical attachment child this build cannot apply or install yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttachmentNotYet {
    /// `file_attach` (Op13).
    FileAttach,
    /// `put_attachment_file` (Effect8).
    PutAttachmentFile,
    /// An attachment conflict side (ConflictValue5).
    ConflictSide,
    /// Ops14–16, Effects9–10 or ConflictValue6: mediation not qualified yet.
    UnindexedMarkdown,
    /// Op17 or Effect11: ordinary promotion mediation not qualified yet.
    OrdinaryFilePromotion,
    /// Op18: descriptor-CAS continuation not qualified yet.
    OrdinaryFileContinuation,
}

impl std::fmt::Display for AttachmentNotYet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self {
            Self::FileAttach => "file_attach (op 13)".to_owned(),
            Self::PutAttachmentFile => "put_attachment_file (effect 8)".to_owned(),
            Self::ConflictSide => "attachment conflict side (conflict value 5)".to_owned(),
            Self::UnindexedMarkdown => "unindexed Markdown critical child".to_owned(),
            Self::OrdinaryFileContinuation => "ordinary full-CAS continuation".to_owned(),
            Self::OrdinaryFilePromotion => "ordinary file promotion critical child".to_owned(),
        };
        write!(
            f,
            "{NOT_YET}: {what} is decoded but not applied by this build"
        )
    }
}

/// Decode a synced entry payload with the runtime family and select the legacy
/// form; `None` for content this caller cannot handle (fail closed).
pub(crate) fn entry(plain: &[u8]) -> Option<EntryPayload> {
    let e = rt::EntryPayload::from_bytes(plain).ok()?;
    legacy_entry(e).ok()
}

/// The mutation of a synced entry as data (ID/origin), attachment or not.
pub(crate) fn entry_mutation(plain: &[u8]) -> Option<rt::Mutation> {
    rt::EntryPayload::from_bytes(plain).ok().map(|e| e.mutation)
}

/// Extended syntax is not activation. Check before policy/result validation so
/// unsupported content cannot become a void, a partial commit or a confirmation.
pub(crate) fn extended_entry_not_yet(e: &rt::EntryPayload) -> Option<AttachmentNotYet> {
    for op in &e.mutation.ops {
        match op {
            rt::Op::OrdinaryAttachmentContinuation(_) => {
                return Some(AttachmentNotYet::OrdinaryFileContinuation);
            }
            rt::Op::UnindexedMarkdownPut(_)
            | rt::Op::RecordToUnindexedMarkdown(_)
            | rt::Op::UnindexedMarkdownToRecord(_) => {}
            rt::Op::OrdinaryFileToRecord(_) => {
                return Some(AttachmentNotYet::OrdinaryFilePromotion);
            }
            rt::Op::Legacy(_) | rt::Op::FileAttach(_) => {}
        }
    }
    for effect in &e.effects {
        match effect {
            rt::Effect::PutUnindexedMarkdown(_) | rt::Effect::ReindexUnindexedMarkdown(_) => {}
            rt::Effect::ReindexOrdinaryFile(_) => {
                return Some(AttachmentNotYet::OrdinaryFilePromotion);
            }
            rt::Effect::Legacy(_) | rt::Effect::PutAttachmentFile(_) => {}
        }
    }
    None
}

pub(crate) fn extended_conflict_not_yet(c: &rt::Conflict) -> bool {
    [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
        .into_iter()
        .flatten()
        .any(|v| matches!(v, rt::ConflictValue::UnindexedMarkdown(_)))
}

fn legacy_op(o: rt::Op) -> Result<Op, AttachmentNotYet> {
    match o {
        rt::Op::Legacy(o) => Ok(o),
        rt::Op::FileAttach(_) => Err(AttachmentNotYet::FileAttach),
        rt::Op::UnindexedMarkdownPut(_)
        | rt::Op::RecordToUnindexedMarkdown(_)
        | rt::Op::UnindexedMarkdownToRecord(_) => Err(AttachmentNotYet::UnindexedMarkdown),
        rt::Op::OrdinaryFileToRecord(_) => Err(AttachmentNotYet::OrdinaryFilePromotion),
        rt::Op::OrdinaryAttachmentContinuation(_) => {
            Err(AttachmentNotYet::OrdinaryFileContinuation)
        }
    }
}

/// Structural conversion of a fully legacy runtime mutation (a pending row).
pub(crate) fn legacy_mutation(m: rt::Mutation) -> Result<Mutation, AttachmentNotYet> {
    Ok(Mutation {
        id: m.id,
        origin: m.origin,
        base_seq: m.base_seq,
        clock: m.clock,
        seed: m.seed,
        source: m.source,
        ops: m.ops.into_iter().map(legacy_op).collect::<Result<_, _>>()?,
        on_behalf: m.on_behalf,
        conflict_mode: m.conflict_mode,
        validated_at: m.validated_at,
        room: m.room,
    })
}

fn legacy_effect(e: rt::Effect) -> Result<Effect, AttachmentNotYet> {
    match e {
        rt::Effect::Legacy(e) => Ok(e),
        rt::Effect::PutAttachmentFile(_) => Err(AttachmentNotYet::PutAttachmentFile),
        rt::Effect::PutUnindexedMarkdown(_) | rt::Effect::ReindexUnindexedMarkdown(_) => {
            Err(AttachmentNotYet::UnindexedMarkdown)
        }
        rt::Effect::ReindexOrdinaryFile(_) => Err(AttachmentNotYet::OrdinaryFilePromotion),
    }
}

fn legacy_side(v: rt::ConflictValue) -> Result<ConflictValue, AttachmentNotYet> {
    match v {
        rt::ConflictValue::Legacy(v) => Ok(v),
        rt::ConflictValue::Attachment(_) => Err(AttachmentNotYet::ConflictSide),
        rt::ConflictValue::UnindexedMarkdown(_) => Err(AttachmentNotYet::UnindexedMarkdown),
    }
}

pub(crate) fn legacy_conflict(c: rt::Conflict) -> Result<Conflict, AttachmentNotYet> {
    Ok(Conflict {
        kind: c.kind,
        id: c.id,
        field: c.field,
        base: c.base.map(legacy_side).transpose()?,
        kept: legacy_side(c.kept)?,
        lost: legacy_side(c.lost)?,
    })
}

/// Structural conversion of a fully legacy runtime entry; no re-decode.
pub(crate) fn legacy_entry(e: rt::EntryPayload) -> Result<EntryPayload, AttachmentNotYet> {
    Ok(EntryPayload {
        sem: e.sem,
        mutation: legacy_mutation(e.mutation)?,
        status: e.status,
        effects: e
            .effects
            .into_iter()
            .map(legacy_effect)
            .collect::<Result<_, _>>()?,
        conflicts: e
            .conflicts
            .map(|cs| cs.into_iter().map(legacy_conflict).collect())
            .transpose()?,
        aliases: e.aliases,
        texts: e.texts,
        resurrect: e.resurrect,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_op18_stalls_before_ordinary_planning_or_apply() {
        let fixture = mdbn_wire::fixtures::all()
            .into_iter()
            .find(|f| f.format == "entry" && f.name == "runtime-v1-ordinary-continuation")
            .unwrap();
        let entry = rt::EntryPayload::from_bytes(&fixture.bytes).unwrap();
        assert_eq!(
            extended_entry_not_yet(&entry),
            Some(AttachmentNotYet::OrdinaryFileContinuation)
        );
        let op = &entry.mutation.ops[1];
        assert_eq!(
            crate::convert::runtime_op(op, &crate::convert::inline_only),
            Err(crate::convert::ConvertError::OrdinaryFileContinuationUnsupported)
        );
    }

    #[test]
    fn native_children_select_runtime_without_legacy_fallback_and_promotion_stays_guarded() {
        let all = mdbn_wire::fixtures::all();
        let full = rt::EntryPayload::from_bytes(
            &all.iter()
                .find(|f| f.format == "entry" && f.name == "runtime-v1-extended")
                .unwrap()
                .bytes,
        )
        .unwrap();
        let base = rt::EntryPayload::from(
            EntryPayload::from_bytes(
                &all.iter()
                    .find(|f| f.format == "entry" && f.name == "applied-with-text-table")
                    .unwrap()
                    .bytes,
            )
            .unwrap(),
        );
        assert_eq!(extended_entry_not_yet(&base), None);
        let mut count = 0;
        for op in full.mutation.ops.into_iter().skip(3) {
            let why = if matches!(op, rt::Op::OrdinaryFileToRecord(_)) {
                AttachmentNotYet::OrdinaryFilePromotion
            } else {
                AttachmentNotYet::UnindexedMarkdown
            };
            let mut e = base.clone();
            e.mutation.ops.insert(0, op);
            assert_eq!(
                extended_entry_not_yet(&e),
                (why == AttachmentNotYet::OrdinaryFilePromotion).then_some(why)
            );
            assert_eq!(legacy_entry(e.clone()), Err(why));
            assert!(entry(&e.to_bytes().unwrap()).is_none());
            count += 1;
        }
        assert_eq!(count, 4);
        let mut count = 0;
        for effect in full.effects.into_iter().skip(3) {
            let why = if matches!(effect, rt::Effect::ReindexOrdinaryFile(_)) {
                AttachmentNotYet::OrdinaryFilePromotion
            } else {
                AttachmentNotYet::UnindexedMarkdown
            };
            let mut e = base.clone();
            e.effects.insert(0, effect);
            assert_eq!(
                extended_entry_not_yet(&e),
                (why == AttachmentNotYet::OrdinaryFilePromotion).then_some(why)
            );
            assert_eq!(legacy_entry(e), Err(why));
            count += 1;
        }
        assert_eq!(count, 3);
        let c = full.conflicts.unwrap().pop().unwrap();
        for side in 0..3 {
            let mut e = base.clone();
            let mut conflict = c.clone();
            conflict.base = None;
            conflict.kept = rt::ConflictValue::Legacy(ConflictValue::Deleted);
            conflict.lost = rt::ConflictValue::Legacy(ConflictValue::Deleted);
            match side {
                0 => conflict.base = c.base.clone(),
                1 => conflict.kept = c.kept.clone(),
                _ => conflict.lost = c.kept.clone(),
            }
            e.conflicts = Some(vec![conflict]);
            assert_eq!(extended_entry_not_yet(&e), None);
            assert_eq!(legacy_entry(e), Err(AttachmentNotYet::UnindexedMarkdown));
        }
    }

    macro_rules! vector {
        ($p:literal) => {
            include_bytes!(concat!("../../../../conformance/wire/", $p)).as_slice()
        };
    }

    const LEGACY_ENTRIES: [&[u8]; 3] = [
        vector!("entry/applied-with-text-table.cbor"),
        vector!("entry/conflicted-external.cbor"),
        vector!("entry/resurrected.cbor"),
    ];

    /// Fully legacy entries decode through the runtime family to exactly what
    /// the legacy decoder produced, and re-encode byte-identically.
    #[test]
    fn legacy_entries_select_unchanged() {
        for bytes in LEGACY_ENTRIES {
            let legacy = EntryPayload::from_bytes(bytes).unwrap();
            let selected = entry(bytes).unwrap();
            assert_eq!(selected, legacy);
            assert_eq!(selected.to_bytes().unwrap(), bytes);
        }
    }

    /// Attachment entries are accepted by decode and refused by apply as a
    /// whole, typed `attachment_apply_not_yet`; the legacy decoder (an older
    /// build) still rejects the same bytes as an unknown critical variant.
    #[test]
    fn attachment_entry_decodes_but_is_not_yet_applied() {
        let bytes = vector!("entry/runtime-v1-mixed.cbor");
        let decoded = rt::EntryPayload::from_bytes(bytes).unwrap();
        assert!(
            decoded
                .effects
                .iter()
                .any(|e| matches!(e, rt::Effect::PutAttachmentFile(_)))
        );
        assert!(entry(bytes).is_none(), "no legacy selection");
        let Err(why) = legacy_entry(decoded.clone()) else {
            panic!("attachment entry has no legacy form");
        };
        assert!(why.to_string().starts_with(NOT_YET));
        assert!(EntryPayload::from_bytes(bytes).unwrap_err().is_unknown());
        assert_eq!(
            entry_mutation(bytes).map(|m| m.id),
            Some(decoded.mutation.id)
        );
    }

    /// Each critical child alone is enough to refuse the whole entry.
    #[test]
    fn each_attachment_child_refuses_the_whole_entry() {
        let full = rt::EntryPayload::from_bytes(vector!("entry/runtime-v1-mixed.cbor")).unwrap();
        let base = rt::EntryPayload::from(EntryPayload::from_bytes(LEGACY_ENTRIES[1]).unwrap());
        assert!(legacy_entry(base.clone()).is_ok());
        let op = full
            .mutation
            .ops
            .iter()
            .find(|o| matches!(o, rt::Op::FileAttach(_)))
            .cloned()
            .unwrap();
        let mut with_op = base.clone();
        with_op.mutation.ops.push(op);
        assert_eq!(legacy_entry(with_op), Err(AttachmentNotYet::FileAttach));
        let effect = full
            .effects
            .iter()
            .find(|e| matches!(e, rt::Effect::PutAttachmentFile(_)))
            .cloned()
            .unwrap();
        let mut with_effect = base.clone();
        with_effect.effects.insert(0, effect);
        assert_eq!(
            legacy_entry(with_effect),
            Err(AttachmentNotYet::PutAttachmentFile)
        );
        let content = match full.effects.iter().find_map(|e| match e {
            rt::Effect::PutAttachmentFile(p) => Some(p.content.clone()),
            _ => None,
        }) {
            Some(c) => c,
            None => unreachable!(),
        };
        let mut with_side = base;
        let conflicts = with_side.conflicts.as_mut().expect("conflicted vector");
        conflicts[0].lost = rt::ConflictValue::Attachment(content);
        assert_eq!(legacy_entry(with_side), Err(AttachmentNotYet::ConflictSide));
    }
}
