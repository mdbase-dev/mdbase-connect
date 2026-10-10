//! Every path the policy accepts must mean the same safe thing on
//! every platform. Each accepted path is run through independent models of how
//! Win32/NTFS, HFS+/APFS and Linux interpret a relative path, and none of them
//! may resolve it outside the collection, into a hidden or private directory,
//! onto a device, or to an alternate stream.

mod support;

use mdbn_core::paths::check_path;
use mdbn_core::unicode::{case_fold, nfc};
use support::Rng;

const PARTS: &[&str] = &[
    "a",
    "B",
    "x",
    "1",
    "9",
    ".",
    "..",
    " ",
    "~",
    "~1",
    "~01",
    "-",
    "_",
    "md",
    ".md",
    "con",
    "CON",
    "nul",
    "Com",
    "lpt",
    "\u{b9}",
    "aux",
    "conin$",
    "git",
    "GIT",
    "obsidian",
    "mdbase",
    "MDBASE",
    "node_modules",
    "Node_Modules",
    ":",
    "\\",
    "/",
    "<",
    "|",
    "?",
    "*",
    "\"",
    "\u{0}",
    "\n",
    "\u{7f}",
    "\u{85}",
    "\u{200c}",
    "\u{200d}",
    "\u{feff}",
    "\u{202e}",
    "\u{2060}",
    "é",
    "e\u{301}",
    "ß",
    "İ",
    "\u{212a}",
    "\u{ff0e}",
    "😀",
    "日本",
];

/// Win32/NTFS: separators `\` and `/`, trailing dots and spaces stripped, `:`
/// for drives and streams, devices by stem, case-insensitive, 8.3 aliases.
fn unsafe_on_windows(path: &str) -> Option<String> {
    for raw in path.split(['/', '\\']) {
        let seg = raw.trim_end_matches(['.', ' ']);
        if seg.is_empty() || raw == "." || raw == ".." {
            return Some(format!("segment {raw:?} collapses"));
        }
        if seg.contains(':') {
            return Some("drive or stream".into());
        }
        if seg.starts_with('.') {
            return Some(format!("hidden {seg:?}"));
        }
        let stem = seg
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_uppercase();
        let devices = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"];
        let numbered = (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.chars().count() == 4
            && matches!(
                stem.chars().nth(3),
                Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
            );
        if devices.contains(&stem.as_str()) || numbered {
            return Some(format!("device {seg:?}"));
        }
        // An 8.3 short name (BASE~N[.EXT], at most one dot, BASE <= 6 and
        // EXT <= 3 characters) can alias any long name, dot directories too.
        let upper = seg.to_uppercase();
        let (name, ext) = match upper.split_once('.') {
            Some((n, e)) => (n, Some(e)),
            None => (upper.as_str(), None),
        };
        if ext.is_none_or(|e| !e.contains('.') && e.chars().count() <= 3)
            && let Some((base, num)) = name.rsplit_once('~')
            && (1..=6).contains(&base.chars().count())
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit())
            && !num.starts_with('0')
        {
            return Some(format!("short name {seg:?}"));
        }
        if seg
            .chars()
            .any(|c| (c as u32) < 0x20 || "<>\"|?*".contains(c))
        {
            return Some("invalid character".into());
        }
    }
    None
}

/// HFS+/APFS: ignorable code points removed, NFD/NFC-insensitive and
/// case-insensitive comparison.
fn unsafe_on_mac(path: &str) -> Option<String> {
    for (i, raw) in path.split('/').enumerate() {
        let cleaned: String = raw
            .chars()
            .filter(|c| !matches!(*c as u32, 0x200C..=0x200F | 0x202A..=0x202E | 0x206A..=0x206F | 0xFEFF))
            .collect();
        let key = nfc(&case_fold(&nfc(&cleaned)));
        if key.is_empty() || key == "." || key == ".." {
            return Some(format!("segment {raw:?} collapses"));
        }
        if key.starts_with('.') {
            return Some(format!("hidden {raw:?}"));
        }
        if i == 0 && key == ".mdbase" {
            return Some("private".into());
        }
        if key == "node_modules" {
            return Some("dependency".into());
        }
    }
    None
}

/// Linux: only `/` separates; no absolute paths, `.`, `..` or empty segments,
/// no dot-prefixed (hidden) segments.
fn unsafe_on_linux(path: &str) -> Option<String> {
    if path.starts_with('/') {
        return Some("absolute".into());
    }
    path.split('/')
        .find(|s| s.is_empty() || *s == "." || *s == ".." || s.starts_with('.') || s.contains('\0'))
        .map(|s| format!("segment {s:?}"))
}

#[test]
fn accepted_paths_are_safe_everywhere() {
    let mut accepted = 0u32;
    for seed in 0..200_000u64 {
        let mut r = Rng::new(seed);
        let mut path = String::new();
        for _ in 0..1 + r.usize(8) {
            let part: &&str = r.pick(PARTS);
            path.push_str(part);
        }
        if check_path(&path).is_err() {
            continue;
        }
        accepted += 1;
        for (os, verdict) in [
            ("windows", unsafe_on_windows(&path)),
            ("mac", unsafe_on_mac(&path)),
            ("linux", unsafe_on_linux(&path)),
        ] {
            assert!(
                verdict.is_none(),
                "seed {seed}: {path:?} accepted but unsafe on {os}: {verdict:?}"
            );
        }
    }
    assert!(accepted > 10_000, "{accepted}");
}

#[test]
fn rejection_is_deterministic_and_stable_under_prefixing() {
    // A path inside an accepted folder is judged by its own segments only.
    for seed in 0..20_000u64 {
        let mut r = Rng::new(seed);
        let mut seg = String::new();
        for _ in 0..1 + r.usize(4) {
            let part: &&str = r.pick(PARTS);
            seg.push_str(part);
        }
        let alone = check_path(&seg);
        assert_eq!(alone, check_path(&seg));
        if !seg.contains('/') && alone.is_ok() {
            assert!(check_path(&format!("notes/{seg}")).is_ok(), "{seg:?}");
        }
    }
}
