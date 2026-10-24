//! Canonical normalization (UAX #15): NFD and NFC, from the compact generated
//! tables in `normalization_table.rs`.
//!
//! Only canonical forms are needed (path keys, spec 02; `slugify`, spec 09),
//! so compatibility data is left out. The `unicode-normalization` crate is the
//! test oracle (a dev-dependency), checked over every code point and over
//! random strings.

use super::normalization_table::{CCC, COMPOSE, DECOMP, MARKS};

const S_BASE: u32 = 0xAC00;
const L_BASE: u32 = 0x1100;
const V_BASE: u32 = 0x1161;
const T_BASE: u32 = 0x11A7;
const L_COUNT: u32 = 19;
const V_COUNT: u32 = 21;
const T_COUNT: u32 = 28;
const N_COUNT: u32 = V_COUNT * T_COUNT;
const S_COUNT: u32 = L_COUNT * N_COUNT;

fn entry_code(e: u64) -> u32 {
    (e & 0x1F_FFFF) as u32
}

fn entry_first(e: u64) -> u32 {
    ((e >> 21) & 0x1F_FFFF) as u32
}

fn entry_second(e: u64) -> u32 {
    ((e >> 42) & 0x1F_FFFF) as u32
}

fn to_char(code: u32) -> char {
    // Generated from UnicodeData.txt: every code is a scalar value.
    char::from_u32(code).unwrap_or('\u{FFFD}')
}

/// The canonical combining class of `c`.
pub fn combining_class(c: char) -> u8 {
    let key = (c as u32) << 8 | 0xFF;
    let i = CCC.partition_point(|&e| e <= key);
    if i == 0 { 0 } else { (CCC[i - 1] & 0xFF) as u8 }
}

/// Whether `c` is a combining mark (general category Mn, Mc or Me).
pub fn is_combining_mark(c: char) -> bool {
    let key = (c as u32) << 1 | 1;
    let i = MARKS.partition_point(|&e| e <= key);
    i > 0 && MARKS[i - 1] & 1 == 1
}

/// Append the full canonical decomposition of `c` to `out`.
fn decompose(c: char, out: &mut Vec<char>) {
    let code = c as u32;
    if (S_BASE..S_BASE + S_COUNT).contains(&code) {
        let s = code - S_BASE;
        out.push(to_char(L_BASE + s / N_COUNT));
        out.push(to_char(V_BASE + (s % N_COUNT) / T_COUNT));
        let t = s % T_COUNT;
        if t != 0 {
            out.push(to_char(T_BASE + t));
        }
        return;
    }
    match DECOMP.binary_search_by_key(&code, |&e| entry_code(e)) {
        Ok(i) => {
            let e = DECOMP[i];
            decompose(to_char(entry_first(e)), out);
            let second = entry_second(e);
            if second != 0 {
                decompose(to_char(second), out);
            }
        }
        Err(_) => out.push(c),
    }
}

/// Canonical ordering: a stable sort of every run of non-starters by class.
fn reorder(chars: &mut [char]) {
    let mut i = 0;
    while i < chars.len() {
        if combining_class(chars[i]) == 0 {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && combining_class(chars[i]) != 0 {
            i += 1;
        }
        chars[start..i].sort_by_key(|&c| combining_class(c));
    }
}

/// The primary composite of `a` and `b`, if any.
fn compose_pair(a: char, b: char) -> Option<char> {
    let (a, b) = (a as u32, b as u32);
    // Hangul: L + V and LV + T.
    if (L_BASE..L_BASE + L_COUNT).contains(&a) && (V_BASE..V_BASE + V_COUNT).contains(&b) {
        return Some(to_char(
            S_BASE + ((a - L_BASE) * V_COUNT + (b - V_BASE)) * T_COUNT,
        ));
    }
    if (S_BASE..S_BASE + S_COUNT).contains(&a)
        && (a - S_BASE).is_multiple_of(T_COUNT)
        && (T_BASE + 1..T_BASE + T_COUNT).contains(&b)
    {
        return Some(to_char(a + (b - T_BASE)));
    }
    let i = COMPOSE.partition_point(|&i| {
        let e = DECOMP[usize::from(i)];
        (entry_first(e), entry_second(e)) < (a, b)
    });
    let e = DECOMP[usize::from(*COMPOSE.get(i)?)];
    (entry_first(e) == a && entry_second(e) == b).then(|| to_char(entry_code(e)))
}

/// `s` in Normalization Form D.
pub fn nfd(s: &str) -> String {
    let mut chars = Vec::with_capacity(s.len());
    for c in s.chars() {
        decompose(c, &mut chars);
    }
    reorder(&mut chars);
    chars.into_iter().collect()
}

/// `s` in Normalization Form C.
pub fn nfc(s: &str) -> String {
    let mut chars = Vec::with_capacity(s.len());
    for c in s.chars() {
        decompose(c, &mut chars);
    }
    reorder(&mut chars);
    // Canonical composition: a character combines with the last starter
    // unless a character between them blocks it (class 0, or a class not
    // lower than its own).
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut starter: Option<usize> = None;
    let mut last_class: u8 = 0;
    for c in chars {
        let class = combining_class(c);
        if let Some(si) = starter {
            let adjacent = out.len() == si + 1;
            if (adjacent || (last_class != 0 && last_class < class))
                && let Some(composed) = compose_pair(out[si], c)
            {
                out[si] = composed;
                continue;
            }
        }
        if class == 0 {
            starter = Some(out.len());
        }
        last_class = class;
        out.push(c);
    }
    out.into_iter().collect()
}
