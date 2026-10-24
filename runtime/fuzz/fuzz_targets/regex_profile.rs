//! Input = pattern `\0` text: validation never panics, an accepted pattern
//! always compiles, and matching is deterministic.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mdbn_core::regex::Pattern;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let (pattern, haystack) = text.split_once('\0').unwrap_or((text, ""));
    if let Ok(p) = Pattern::new(pattern) {
        assert_eq!(p.is_match(haystack), p.is_match(haystack));
    }
});
