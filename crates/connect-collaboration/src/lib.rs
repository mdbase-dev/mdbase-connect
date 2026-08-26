//! Provider-neutral collaboration profile primitives.
//!
//! This crate deliberately owns no transport, authorization, persistence, or
//! encryption. Collection authorities use it to validate and materialize the
//! versioned Markdown-body collaboration profile.

use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, TextRef, Transact, Update,
};

pub const MARKDOWN_BODY_YJS_V13_PROFILE: &str = "markdown-body-yjs-v13";
pub const COLLABORATION_PROFILE_VERSION: u32 = 1;
pub const BODY_ROOT: &str = "body";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CollaborationError {
    #[error("the record body is unsupported by this collaboration profile")]
    UnsupportedBody,
    #[error("the collaboration update is malformed")]
    MalformedUpdate,
    #[error("the collaboration state contains an unsupported shared root")]
    UnsupportedRoot,
    #[error("the collaboration update exceeds the configured byte limit")]
    UpdateTooLarge,
    #[error("the materialized collaboration body exceeds the configured byte limit")]
    BodyTooLarge,
}

/// A Yjs-v13-compatible document containing exactly one `Y.Text("body")` root.
///
/// Yrs is configured for UTF-16 offsets because Yjs and CodeMirror positions
/// are UTF-16 code-unit offsets. The materialized Rust string is nevertheless
/// required to match the authority-visible UTF-8 record body exactly.
pub struct MarkdownBodyDocument {
    doc: Doc,
    body: TextRef,
}

impl MarkdownBodyDocument {
    pub fn new(body: &str, max_body_bytes: usize) -> Result<Self, CollaborationError> {
        validate_body(body, max_body_bytes)?;
        let doc = yjs_compatible_doc();
        let body_ref = doc.get_or_insert_text(BODY_ROOT);
        if !body.is_empty() {
            body_ref.insert(&mut doc.transact_mut(), 0, body);
        }
        Ok(Self {
            doc,
            body: body_ref,
        })
    }

    /// Rehydrates a compact full-state update. Incremental updates can then be
    /// applied regardless of whether earlier update-log rows were compacted.
    pub fn from_snapshot(
        snapshot: &[u8],
        max_update_bytes: usize,
        max_body_bytes: usize,
    ) -> Result<Self, CollaborationError> {
        if snapshot.len() > max_update_bytes {
            return Err(CollaborationError::UpdateTooLarge);
        }
        let doc = yjs_compatible_doc();
        // Root types are profile knowledge rather than update metadata. Register
        // the one supported root before decoding remote state.
        doc.get_or_insert_text(BODY_ROOT);
        let update =
            Update::decode_v1(snapshot).map_err(|_| CollaborationError::MalformedUpdate)?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|_| CollaborationError::MalformedUpdate)?;
        Self::from_validated_doc(doc, max_body_bytes)
    }

    pub fn body(&self) -> String {
        self.body.get_string(&self.doc.transact())
    }

    pub fn state_vector_v1(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    pub fn snapshot_v1(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn diff_v1(&self, encoded_state_vector: &[u8]) -> Result<Vec<u8>, CollaborationError> {
        let state_vector = StateVector::decode_v1(encoded_state_vector)
            .map_err(|_| CollaborationError::MalformedUpdate)?;
        Ok(self.doc.transact().encode_state_as_update_v1(&state_vector))
    }

    /// Applies an untrusted update to a scratch document and replaces live
    /// state only after root and body limits pass. A rejected update therefore
    /// cannot poison a reusable room document.
    pub fn apply_update_v1(
        &mut self,
        encoded_update: &[u8],
        max_update_bytes: usize,
        max_body_bytes: usize,
    ) -> Result<(), CollaborationError> {
        if encoded_update.len() > max_update_bytes {
            return Err(CollaborationError::UpdateTooLarge);
        }
        let mut scratch = Self::from_snapshot(&self.snapshot_v1(), usize::MAX, max_body_bytes)?;
        let update =
            Update::decode_v1(encoded_update).map_err(|_| CollaborationError::MalformedUpdate)?;
        scratch
            .doc
            .transact_mut()
            .apply_update(update)
            .map_err(|_| CollaborationError::MalformedUpdate)?;
        scratch = Self::from_validated_doc(scratch.doc, max_body_bytes)?;
        *self = scratch;
        Ok(())
    }

    /// Applies one bounded server-origin textual delta rather than replacing
    /// the entire Y.Text. The common prefix and suffix are selected only at
    /// Unicode scalar boundaries, then converted to Yjs UTF-16 offsets.
    pub fn apply_provider_body(
        &mut self,
        next_body: &str,
        max_body_bytes: usize,
    ) -> Result<Vec<u8>, CollaborationError> {
        validate_body(next_body, max_body_bytes)?;
        let current = self.body();
        if current == next_body {
            return Ok(Vec::new());
        }
        let (prefix_bytes, current_suffix_bytes, next_suffix_bytes) =
            scalar_diff_boundaries(&current, next_body);
        let start = utf16_len(&current[..prefix_bytes]);
        let remove = utf16_len(&current[prefix_bytes..current_suffix_bytes]);
        let insert = &next_body[prefix_bytes..next_suffix_bytes];
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            if remove != 0 {
                self.body.remove_range(&mut txn, start, remove);
            }
            if !insert.is_empty() {
                self.body.insert(&mut txn, start, insert);
            }
        }
        debug_assert_eq!(self.body(), next_body);
        Ok(self.doc.transact().encode_state_as_update_v1(&before))
    }

    fn from_validated_doc(doc: Doc, max_body_bytes: usize) -> Result<Self, CollaborationError> {
        let body = {
            let txn = doc.transact();
            let mut roots = txn.root_refs();
            let Some((name, root)) = roots.next() else {
                return Err(CollaborationError::UnsupportedRoot);
            };
            if name != BODY_ROOT || roots.next().is_some() {
                return Err(CollaborationError::UnsupportedRoot);
            }
            root.cast::<TextRef>()
                .map_err(|_| CollaborationError::UnsupportedRoot)?
        };
        validate_body(&body.get_string(&doc.transact()), max_body_bytes)?;
        Ok(Self { doc, body })
    }
}

pub fn validate_body(body: &str, max_body_bytes: usize) -> Result<(), CollaborationError> {
    if body.len() > max_body_bytes {
        return Err(CollaborationError::BodyTooLarge);
    }
    // Profile v1 admits LF line endings only. Rejecting all carriage returns is
    // explicit and lossless; support can broaden after an exact CodeMirror and
    // conventional-write proof.
    if body.contains(['\r', '\0']) {
        return Err(CollaborationError::UnsupportedBody);
    }
    Ok(())
}

fn yjs_compatible_doc() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

fn utf16_len(value: &str) -> u32 {
    value.encode_utf16().count() as u32
}

fn scalar_diff_boundaries(current: &str, next: &str) -> (usize, usize, usize) {
    let mut prefix = 0;
    let mut left = current.char_indices();
    let mut right = next.char_indices();
    loop {
        match (left.next(), right.next()) {
            (Some((left_index, left_char)), Some((right_index, right_char)))
                if left_char == right_char =>
            {
                debug_assert_eq!(left_index, right_index);
                prefix = left_index + left_char.len_utf8();
            }
            _ => break,
        }
    }

    let current_tail = &current[prefix..];
    let next_tail = &next[prefix..];
    let mut common_suffix_bytes = 0;
    for (left_char, right_char) in current_tail.chars().rev().zip(next_tail.chars().rev()) {
        if left_char != right_char {
            break;
        }
        common_suffix_bytes += left_char.len_utf8();
    }
    (
        prefix,
        current.len() - common_suffix_bytes,
        next.len() - common_suffix_bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPDATE_LIMIT: usize = 1024 * 1024;
    const BODY_LIMIT: usize = 1024 * 1024;

    #[test]
    fn exact_body_round_trips_without_unicode_normalization() {
        let body = "# Café 👩🏽‍💻\n\ne\u{301} is decomposed\n";
        let document = MarkdownBodyDocument::new(body, BODY_LIMIT).unwrap();
        assert_eq!(document.body(), body);
        assert_eq!(document.body().as_bytes(), body.as_bytes());
        let restored =
            MarkdownBodyDocument::from_snapshot(&document.snapshot_v1(), UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();
        assert_eq!(restored.body().as_bytes(), body.as_bytes());
    }

    #[test]
    fn profile_rejects_non_lf_and_nul_bodies() {
        for body in ["a\r\nb", "a\rb", "a\r\nb\nc", "a\0b"] {
            assert_eq!(
                MarkdownBodyDocument::new(body, BODY_LIMIT).err(),
                Some(CollaborationError::UnsupportedBody)
            );
        }
    }

    #[test]
    fn provider_diff_uses_utf16_positions_and_preserves_shared_history() {
        let mut document = MarkdownBodyDocument::new("A👩🏽‍💻Z\n", BODY_LIMIT).unwrap();
        let old_snapshot = document.snapshot_v1();
        let old_vector = document.state_vector_v1();
        let update = document
            .apply_provider_body("A👩🏽‍💻 together Z\n", BODY_LIMIT)
            .unwrap();
        assert!(!update.is_empty());
        assert_eq!(document.body(), "A👩🏽‍💻 together Z\n");

        let mut stale =
            MarkdownBodyDocument::from_snapshot(&old_snapshot, UPDATE_LIMIT, BODY_LIMIT).unwrap();
        stale
            .apply_update_v1(
                &document.diff_v1(&old_vector).unwrap(),
                UPDATE_LIMIT,
                BODY_LIMIT,
            )
            .unwrap();
        // A stale client can synchronize from its old state vector after the
        // authority has compacted its durable log to one full-state snapshot.
        assert_eq!(stale.body(), "A👩🏽‍💻 together Z\n");
    }

    #[test]
    fn one_thousand_concurrent_provider_origin_schedules_converge() {
        for seed in 0..1_000_u32 {
            let base = format!("# Seed {seed}\n\nabcdef 👋 ghijkl e\u{301}\n");
            let base_document = MarkdownBodyDocument::new(&base, BODY_LIMIT).unwrap();
            let snapshot = base_document.snapshot_v1();
            let scalar_count = base.chars().count();
            let left_at = (seed as usize * 17) % (scalar_count + 1);
            let right_at = (seed as usize * 31 + 3) % scalar_count;
            let left_body = insert_at_scalar(&base, left_at, &format!("L{seed}✨"));
            let right_body = replace_scalar_at(&base, right_at, &format!("R{seed}👩🏽‍💻"));

            let mut left =
                MarkdownBodyDocument::from_snapshot(&snapshot, UPDATE_LIMIT, BODY_LIMIT).unwrap();
            let left_update = left.apply_provider_body(&left_body, BODY_LIMIT).unwrap();
            let mut right =
                MarkdownBodyDocument::from_snapshot(&snapshot, UPDATE_LIMIT, BODY_LIMIT).unwrap();
            let right_update = right.apply_provider_body(&right_body, BODY_LIMIT).unwrap();

            let mut first =
                MarkdownBodyDocument::from_snapshot(&snapshot, UPDATE_LIMIT, BODY_LIMIT).unwrap();
            first
                .apply_update_v1(&left_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();
            first
                .apply_update_v1(&right_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();
            first
                .apply_update_v1(&left_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();

            let mut second =
                MarkdownBodyDocument::from_snapshot(&snapshot, UPDATE_LIMIT, BODY_LIMIT).unwrap();
            second
                .apply_update_v1(&right_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();
            second
                .apply_update_v1(&left_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();
            second
                .apply_update_v1(&right_update, UPDATE_LIMIT, BODY_LIMIT)
                .unwrap();

            assert_eq!(first.body(), second.body(), "seed {seed}");
            assert_eq!(
                first.state_vector_v1(),
                second.state_vector_v1(),
                "seed {seed}"
            );
            let restored =
                MarkdownBodyDocument::from_snapshot(&first.snapshot_v1(), UPDATE_LIMIT, BODY_LIMIT)
                    .unwrap();
            assert_eq!(restored.body(), first.body(), "seed {seed}");
        }
    }

    #[test]
    fn rejected_root_does_not_mutate_live_state() {
        let mut live = MarkdownBodyDocument::new("safe\n", BODY_LIMIT).unwrap();
        let hostile = yjs_compatible_doc();
        hostile
            .get_or_insert_text("other")
            .insert(&mut hostile.transact_mut(), 0, "hidden");
        let update = hostile
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        assert_eq!(
            live.apply_update_v1(&update, UPDATE_LIMIT, BODY_LIMIT),
            Err(CollaborationError::UnsupportedRoot)
        );
        assert_eq!(live.body(), "safe\n");
    }

    fn insert_at_scalar(value: &str, scalar_index: usize, inserted: &str) -> String {
        let byte_index = value
            .char_indices()
            .nth(scalar_index)
            .map(|(index, _)| index)
            .unwrap_or(value.len());
        format!(
            "{}{}{}",
            &value[..byte_index],
            inserted,
            &value[byte_index..]
        )
    }

    fn replace_scalar_at(value: &str, scalar_index: usize, replacement: &str) -> String {
        let (start, character) = value.char_indices().nth(scalar_index).unwrap();
        let end = start + character.len_utf8();
        format!("{}{}{}", &value[..start], replacement, &value[end..])
    }
}
