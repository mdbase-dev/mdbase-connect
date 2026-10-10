//! Existing text-table Blob form for reverse16; no new Wire capability.
use crate::{
    api::{ApiResult, ErrorCode},
    seal::Sealer,
    store::PendingRow,
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    common::Text,
    entry::{ConflictValue, TextBlob, TextDef, TextDefForm},
    schema::Wire,
};
use zeroize::{Zeroize, Zeroizing};
pub(crate) fn is_reverse(m: &rt::Mutation) -> bool {
    m.ops
        .iter()
        .any(|o| matches!(o, rt::Op::UnindexedMarkdownToRecord(_)))
}
pub(crate) fn check(row: &PendingRow, sealer: &dyn Sealer) -> ApiResult<()> {
    let [rt::Op::UnindexedMarkdownToRecord(op)] = row.mutation.ops.as_slice() else {
        return Err(ErrorCode::Internal.err("reverse capture requires one operation"));
    };
    let [source] = row.uploads.as_slice() else {
        return Err(ErrorCode::Internal.err("reverse capture requires one uploaded source"));
    };
    let Text::Inline(doc) = &op.doc else {
        return Err(ErrorCode::Internal.err("pending reverse text is not inline"));
    };
    if doc.len() > 1048576
        || source.size != doc.len() as u64
        || source.plain_hash != mdbn_wire::hash::sha256(doc.as_bytes())
    {
        return Err(ErrorCode::Internal.err("reverse source descriptor mismatch"));
    }
    crate::crypto::blob::validate_blob_ref(source)
        .map_err(|_| ErrorCode::Internal.err("reverse source shape"))?;
    let mut refs = sealer
        .blob_part_addresses(source)
        .ok_or_else(|| ErrorCode::Unavailable.err("reverse source key missing"))?;
    refs.sort();
    if refs.is_empty() || !refs.windows(2).all(|w| w[0] < w[1]) || refs != row.refs {
        return Err(ErrorCode::Internal.err("reverse source refs incomplete"));
    }
    Ok(())
}
fn replace(t: &mut Text, doc: &str) {
    if let Text::Inline(s) = t
        && s == doc
    {
        s.zeroize();
        *t = Text::Index(0);
    }
}
/// Pending texts stay exact/inline for Core replanning; only the emitted payload
/// references the authenticated uploaded Blob in both operation AND result sides.
pub(crate) fn entry_plain(
    row: &PendingRow,
    planned: &mdbn_core::plan::Planned,
    resurrect: Option<u64>,
    sealer: &dyn Sealer,
) -> ApiResult<Vec<u8>> {
    check(row, sealer)?;
    let rt::Op::UnindexedMarkdownToRecord(op) = &row.mutation.ops[0] else {
        unreachable!()
    };
    let Text::Inline(doc) = &op.doc else {
        unreachable!()
    };
    let exact = Zeroizing::new(doc.clone());
    let mut payload =
        super::attachment_upload::entry_payload(row.mutation.clone(), planned, resurrect)?;
    let rt::Op::UnindexedMarkdownToRecord(op) = &mut payload.mutation.ops[0] else {
        unreachable!()
    };
    replace(&mut op.doc, &exact);
    for e in &mut payload.effects {
        if let rt::Effect::ReindexUnindexedMarkdown(e) = e {
            replace(&mut e.doc, &exact);
        }
    }
    if let Some(conflicts) = &mut payload.conflicts {
        for c in conflicts {
            for v in c.base.iter_mut().chain([&mut c.kept, &mut c.lost]) {
                if let rt::ConflictValue::Legacy(ConflictValue::Text(t)) = v {
                    replace(t, &exact);
                }
            }
        }
    }
    payload.texts = Some(vec![TextDef::Form(TextDefForm::Blob(TextBlob {
        blob: row.uploads[0].clone(),
    }))]);
    payload
        .to_bytes()
        .map_err(|_| ErrorCode::Internal.err("reverse entry encoding"))
}
