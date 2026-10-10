//! The compact, embedded IANA database pinned by the semantics registry.
//!
//! No host zoneinfo, clock or locale is consulted. The generated table retains
//! historical transitions and POSIX future rules; aliases share a rule set.

use std::sync::OnceLock;

use super::{PosixTz, TimeError, TimeZoneRules};

/// The IANA release embedded in this build (semantics 1.1).
pub const RELEASE: &str = "2026e";
const PACKED: &[u8] = include_bytes!("tzdb.bin");
const MAX_DECODED: usize = 256 * 1024;

#[derive(Debug)]
struct Rules {
    initial: i32,
    transitions: Vec<(i64, i32)>,
    footer: Option<PosixTz>,
}

impl TimeZoneRules for Rules {
    fn offset_at(&self, seconds: i64) -> i32 {
        if self
            .transitions
            .last()
            .is_none_or(|&(last, _)| seconds > last)
            && let Some(footer) = &self.footer
        {
            return footer.offset_at(seconds);
        }
        let i = self.transitions.partition_point(|&(at, _)| at <= seconds);
        if i == 0 {
            self.initial
        } else {
            self.transitions[i - 1].1
        }
    }
}

#[derive(Debug)]
struct Database {
    rules: Vec<Rules>,
    names: Vec<(String, u16)>,
}

/// A named zone from the embedded IANA release. Lookup is exact and
/// case-sensitive, including IANA aliases. Unknown names are errors, never UTC.
#[derive(Debug, Clone, Copy)]
pub struct NamedZone {
    rules: &'static Rules,
    name: &'static str,
}

impl NamedZone {
    /// Look up a named IANA zone in the release pinned by this build's semantics.
    pub fn get(name: &str) -> Result<NamedZone, TimeError> {
        static DB: OnceLock<Result<Database, TimeError>> = OnceLock::new();
        let db = DB.get_or_init(|| {
            let bytes = miniz_oxide::inflate::decompress_to_vec_with_limit(PACKED, MAX_DECODED)
                .map_err(|_| invalid())?;
            decode(&bytes).ok_or_else(invalid)
        });
        let db = db.as_ref().map_err(Clone::clone)?;
        let i = db
            .names
            .binary_search_by(|(n, _)| n.as_str().cmp(name))
            .map_err(|_| TimeError(format!("unsupported_timezone: {name:?} (tzdb {RELEASE})")))?;
        Ok(NamedZone {
            rules: &db.rules[usize::from(db.names[i].1)],
            name: &db.names[i].0,
        })
    }
    /// Exact matched identity from the pinned database, including aliases.
    /// This is retained lookup provenance, not an inferred canonical name.
    pub fn name(self) -> &'static str {
        self.name
    }
}

impl TimeZoneRules for NamedZone {
    fn offset_at(&self, utc_seconds: i64) -> i32 {
        self.rules.offset_at(utc_seconds)
    }
}

fn invalid() -> TimeError {
    TimeError("invalid embedded tzdb table".into())
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (out, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(out)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes(self.take(2)?.try_into().ok()?))
    }
    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }
    fn text(&mut self) -> Option<&'a str> {
        let n = usize::from(self.u8()?);
        let bytes = self.take(n)?;
        bytes.is_ascii().then(|| std::str::from_utf8(bytes).ok())?
    }
    fn signed(&mut self) -> Option<i64> {
        let mut value = 0u64;
        for shift in (0..=63).step_by(7) {
            let b = self.u8()?;
            let payload = u64::from(b & 127);
            if shift == 63 && payload > 1 {
                return None;
            }
            value |= payload << shift;
            if b & 128 == 0 {
                // Require canonical varints, including at the 64-bit boundary.
                if shift != 0 && payload == 0 {
                    return None;
                }
                return Some(i64::try_from(value >> 1).ok()? ^ -i64::from(b_sign(value)));
            }
        }
        None
    }
}

fn b_sign(value: u64) -> u8 {
    if value & 1 == 0 { 0 } else { 1 }
}

fn decode(bytes: &[u8]) -> Option<Database> {
    if bytes.len() > MAX_DECODED {
        return None;
    }
    let mut r = Reader(bytes);
    if r.take(6)? != b"MDBTZ1" || r.take(RELEASE.len())? != RELEASE.as_bytes() {
        return None;
    }
    let count = usize::from(r.u16()?);
    if count == 0 || count > 512 {
        return None;
    }
    let mut rules = Vec::with_capacity(count);
    for _ in 0..count {
        let initial = r.i32()?;
        if !(-86_400..=86_400).contains(&initial) {
            return None;
        }
        let n = usize::from(r.u16()?);
        if n > 4096 {
            return None;
        }
        let mut transitions = Vec::with_capacity(n);
        let mut previous = 0i64;
        for i in 0..n {
            let at = previous.checked_add(r.signed()?)?;
            let offset = i32::try_from(r.signed()?).ok()?;
            if (i != 0 && at <= previous) || !(-86_400..=86_400).contains(&offset) {
                return None;
            }
            transitions.push((at, offset));
            previous = at;
        }
        let footer = match r.text()? {
            "" => None,
            text => Some(PosixTz::parse(text).ok()?),
        };
        rules.push(Rules {
            initial,
            transitions,
            footer,
        });
    }
    let n = usize::from(r.u16()?);
    if n == 0 || n > 1024 {
        return None;
    }
    let mut names: Vec<(String, u16)> = Vec::with_capacity(n);
    for _ in 0..n {
        let name = r.text()?;
        let index = r.u16()?;
        if name.is_empty()
            || usize::from(index) >= rules.len()
            || names
                .last()
                .is_some_and(|(previous, _)| previous.as_str() >= name)
        {
            return None;
        }
        names.push((name.to_owned(), index));
    }
    r.0.is_empty().then_some(Database { rules, names })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_valid_and_complete() {
        let bytes =
            miniz_oxide::inflate::decompress_to_vec_with_limit(PACKED, MAX_DECODED).unwrap();
        let db = decode(&bytes).unwrap();
        assert_eq!(db.rules.len(), 344);
        assert_eq!(db.names.len(), 597);
        for (name, _) in &db.names {
            assert!(NamedZone::get(name).is_ok(), "{name}");
        }
        for bad in [
            "",
            "america/New_York",
            "../UTC",
            "Mars/Olympus",
            "Australia/Melbourne\0",
        ] {
            assert!(
                NamedZone::get(bad)
                    .unwrap_err()
                    .0
                    .contains("unsupported_timezone")
            );
        }
    }

    #[test]
    fn malformed_tables_fail_without_panicking() {
        let bytes =
            miniz_oxide::inflate::decompress_to_vec_with_limit(PACKED, MAX_DECODED).unwrap();
        for end in [0, 6, 11, 100, bytes.len() - 1] {
            assert!(decode(&bytes[..end]).is_none());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_none());
        let mut invalid_count = bytes.clone();
        invalid_count[11..13].copy_from_slice(&u16::MAX.to_be_bytes());
        assert!(decode(&invalid_count).is_none());
        let mut wrong_version = bytes.clone();
        wrong_version[10] = b'f';
        assert!(decode(&wrong_version).is_none());
        for varint in [&[0x80, 0][..], &[0xff; 10][..], &[0x80][..]] {
            assert!(Reader(varint).signed().is_none());
        }
    }
}
