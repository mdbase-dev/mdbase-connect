//! Input = base `\0` first `\0` second: the body merge never panics, is
//! deterministic, satisfies the identity laws, commutes when it is not an
//! append-append merge, and `body_edits` never panics.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mdbn_core::merge::{BodyBase, BodyEdit, apply_body_edits, merge_body};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let mut parts = text.splitn(3, '\0');
    let (Some(b), Some(f), Some(s)) = (parts.next(), parts.next(), parts.next()) else { return };
    let m = merge_body(b, f, s);
    assert_eq!(m, merge_body(b, f, s));
    assert_eq!(merge_body(b, b, s).as_deref(), Some(s));
    assert_eq!(merge_body(b, f, b).as_deref(), Some(f));
    assert_eq!(merge_body(b, f, f).as_deref(), Some(f));
    let append_append = f.starts_with(b) && s.starts_with(b);
    if !append_append {
        assert_eq!(m, merge_body(b, s, f));
    }
    // Edits derived from the input lengths, valid or not.
    let n = b.chars().count() as u64;
    let edits = [
        BodyEdit { start: n / 3, end: n / 2, insert: s.chars().take(5).collect() },
        BodyEdit { start: n / 2, end: n, insert: String::new() },
    ];
    let _ = apply_body_edits(f, BodyBase::Text(b), &edits);
    let _ = apply_body_edits(b, BodyBase::Text(b), &edits);
});
