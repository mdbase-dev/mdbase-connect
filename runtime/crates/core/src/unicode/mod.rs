//! Unicode helpers with pinned tables: NFC normalization and full default case
//! folding.
//!
//! Path keys (spec 02) depend on Unicode data, so every replica must use the
//! same tables. Canonical normalization (NFC, NFD) and case folding use
//! compact tables generated from one Unicode version
//! (`scripts/gen-normalization-tables.py`, `scripts/gen-casefold-table.py`).
//! The `unicode-normalization` crate is only the test oracle; a test fails if
//! the versions drift apart.

mod casefold_table;
mod normalization_table;
mod normalize;

pub use normalize::{combining_class, is_combining_mark, nfd};

// Both generated tables must come from one Unicode version.
const _: () = {
    let (a, b) = (
        casefold_table::UNICODE_VERSION,
        normalization_table::UNICODE_VERSION,
    );
    assert!(
        a.0 == b.0 && a.1 == b.1 && a.2 == b.2,
        "regenerate the Unicode tables together"
    );
};

/// The Unicode version of the NFC and case folding tables.
pub const UNICODE_VERSION: (u8, u8, u8) = casefold_table::UNICODE_VERSION;

/// The full case-folding table (code point, folding), sorted by code point.
#[cfg(test)]
pub(crate) fn fold_table() -> &'static [(u32, &'static str)] {
    casefold_table::FOLD
}

/// `s` in Normalization Form C.
pub fn nfc(s: &str) -> String {
    // ASCII has no decompositions, no combining marks and no compositions.
    if s.is_ascii() {
        return s.to_owned();
    }
    normalize::nfc(s)
}

/// Unicode default case folding with the full mappings (`C` and `F` of
/// `CaseFolding.txt`, no locale tailoring): `ß` folds to `ss`.
pub fn case_fold(s: &str) -> String {
    // In ASCII the full folding maps exactly `A`-`Z` to `a`-`z`
    // (`ascii_folding_matches_the_table`).
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match casefold_table::FOLD.binary_search_by_key(&(c as u32), |&(code, _)| code) {
            Ok(i) => out.push_str(casefold_table::FOLD[i].1),
            Err(_) => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use unicode_normalization::UnicodeNormalization;
    use unicode_normalization::char::{
        canonical_combining_class, is_combining_mark as oracle_mark,
    };

    /// The ASCII fast paths of `nfc` and `case_fold` agree with the tables.
    #[test]
    fn ascii_folding_matches_the_table() {
        for b in 0u8..0x80 {
            let c = char::from(b);
            let s = c.to_string();
            let table = match super::casefold_table::FOLD
                .binary_search_by_key(&u32::from(b), |&(code, _)| code)
            {
                Ok(i) => super::casefold_table::FOLD[i].1.to_string(),
                Err(_) => s.clone(),
            };
            assert_eq!(super::case_fold(&s), table, "fold U+{b:04X}");
            assert_eq!(nfc(&s), super::normalize::nfc(&s), "NFC U+{b:04X}");
        }
        let all: String = (0u8..0x80).map(char::from).collect();
        assert_eq!(nfc(&all), super::normalize::nfc(&all));
    }

    /// Every code point: NFC, NFD, combining class and mark agree with the
    /// `unicode-normalization` crate.
    #[test]
    fn every_code_point_matches_the_oracle() {
        for code in 0..0x11_0000u32 {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            let s = c.to_string();
            assert_eq!(nfc(&s), s.nfc().collect::<String>(), "NFC U+{code:04X}");
            assert_eq!(nfd(&s), s.nfd().collect::<String>(), "NFD U+{code:04X}");
            assert_eq!(
                combining_class(c),
                canonical_combining_class(c),
                "ccc U+{code:04X}"
            );
            assert_eq!(is_combining_mark(c), oracle_mark(c), "mark U+{code:04X}");
        }
    }

    /// Random strings over starters, marks of many classes, Hangul jamo and
    /// precomposed characters: composition, blocking and reordering.
    #[test]
    fn random_strings_match_the_oracle() {
        const POOL: &[char] = &[
            'a',
            'e',
            'o',
            'A',
            'u',
            'z',
            'ß',
            '\u{0300}',
            '\u{0301}',
            '\u{0302}',
            '\u{0308}',
            '\u{0323}',
            '\u{0327}',
            '\u{0328}',
            '\u{031B}',
            '\u{0345}',
            '\u{05B0}',
            '\u{0F71}',
            '\u{0F72}',
            '\u{0F80}',
            '\u{1100}',
            '\u{1161}',
            '\u{11A8}',
            '\u{AC00}',
            '\u{AC01}',
            '\u{00C5}',
            '\u{212B}',
            '\u{1E9B}',
            '\u{1E0A}',
            '\u{0958}',
            '\u{093C}',
            '\u{0915}',
            '\u{FB2C}',
            '\u{05BC}',
            '\u{05C1}',
            '\u{1D15E}',
            '\u{1D165}',
            '\u{0344}',
            '\u{1F80}',
            '\u{03B1}',
            '\u{0313}',
            '\u{0342}',
            '\u{30AB}',
            '\u{3099}',
            '\u{0CC6}',
            '\u{0CC2}',
            '\u{0CD5}',
            '\u{11131}',
            '\u{11127}',
            '\u{0F73}',
            '\u{2126}',
        ];
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..200_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let len = 1 + (state % 8) as usize;
            let mut s = String::new();
            let mut x = state;
            for _ in 0..len {
                x = x
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                s.push(POOL[((x >> 33) % POOL.len() as u64) as usize]);
            }
            assert_eq!(nfc(&s), s.nfc().collect::<String>(), "NFC {s:?}");
            assert_eq!(nfd(&s), s.nfd().collect::<String>(), "NFD {s:?}");
        }
    }

    use super::*;

    #[test]
    fn tables_share_one_unicode_version() {
        assert_eq!(UNICODE_VERSION, unicode_normalization::UNICODE_VERSION);
        assert_eq!(UNICODE_VERSION, normalization_table::UNICODE_VERSION);
    }

    #[test]
    fn table_is_sorted() {
        assert!(casefold_table::FOLD.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn folding() {
        assert_eq!(case_fold("Straße"), "strasse");
        assert_eq!(case_fold("STRASSE"), "strasse");
        assert_eq!(case_fold("ÉCLAIR"), "éclair");
        assert_eq!(case_fold("ﬁ"), "fi");
        assert_eq!(case_fold("Σίσυφος"), "σίσυφοσ");
        assert_eq!(case_fold("İ"), "i\u{307}");
        assert_eq!(case_fold("日本"), "日本");
    }

    #[test]
    fn normalization() {
        assert_eq!(nfc("Cafe\u{301}"), "Café");
        assert_eq!(nfc("Café"), "Café");
    }
}
