//! Text ↔ wire identifiers. Old stores write canonical lowercase hyphenated UUIDs and
//! `sha256:<hex>` revisions. The new wire format carries 16 and 32 raw bytes.

use mdbn_wire::common::{B16, B32, Hash, Uuid};

use crate::{Error, Result};

/// Whether `s` is a canonical lowercase hyphenated UUID (`8-4-4-4-12`), any version.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

/// Parse a canonical UUID (`8-4-4-4-12`, lowercase). Any version: Connect's legacy IDs
/// are kept as they are (`00-overview.md` §5).
pub fn uuid(s: &str) -> Result<Uuid> {
    if !is_uuid(s) {
        return Err(Error::Invalid(format!("not a canonical UUID: {s}")));
    }
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    Ok(B16(bytes::<16>(&hex)?))
}

/// Parse `sha256:<64 lowercase hex>`.
pub fn revision(s: &str) -> Result<Hash> {
    let hex = s
        .strip_prefix("sha256:")
        .filter(|h| h.len() == 64)
        .ok_or_else(|| Error::Invalid("revision is not sha256:<hex>".into()))?;
    Ok(B32(bytes::<32>(hex)?))
}

/// The provider's revision form of `bytes`: `sha256:<hex>`.
pub fn revision_of(bytes: &[u8]) -> String {
    format!("sha256:{}", mdbn_wire::hash::sha256(bytes).to_hex())
}

fn bytes<const N: usize>(hex: &str) -> Result<[u8; N]> {
    let b = hex.as_bytes();
    if b.len() != N * 2 {
        return Err(Error::Invalid("hex length".into()));
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err(Error::Invalid("hex digit".into())),
    };
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let s = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";
        assert_eq!(uuid(s).unwrap().to_uuid_string(), s);
        let r = revision_of(b"x");
        assert_eq!(format!("sha256:{}", revision(&r).unwrap().to_hex()), r);
        assert!(uuid("0192F0C1-7E1A-7B3C-8D4E-5F6A7B8C9D0E").is_err());
        assert!(revision("sha256:00").is_err());
        assert!(!is_uuid("0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0"));
    }
}
