//! Identifiers and digests shared by planning, state and the query layer.
//!
//! - [`Uuid`]: record, file, mutation, replica and grant IDs (16 bytes,
//!   `00-overview.md` §5). Text form: lowercase hyphenated.
//! - [`Hash`]: SHA-256 digests (`00-overview.md` §4). Text form: `sha256:` plus
//!   64 lowercase hex digits, as in the spec's revision tokens.
//! - [`revision`]: the revision of a document is the SHA-256 of its exact bytes,
//!   with no domain tag (spec 12, `00-overview.md` §4).
//! - [`mac`]: the domain-separated `MAC(k, tag, m)` of `00-overview.md` §4.
//!
//! These mirror `mdbn_wire::{B16, B32}`; the conversion is a byte copy.

use std::fmt;

use sha2::{Digest, Sha256};

/// A 128-bit UUID (RFC 9562), network byte order.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Uuid(pub [u8; 16]);

/// A record ID.
pub type RecordId = Uuid;
/// A file (non-record attachment) ID.
pub type FileId = Uuid;
/// A mutation ID: the idempotency key of one logical write.
pub type MutationId = Uuid;

impl Uuid {
    /// The nil UUID (all zero). Never a valid entity ID; useful in tests.
    pub const NIL: Uuid = Uuid([0; 16]);

    /// Parse the canonical hyphenated form (either case).
    pub fn parse(s: &str) -> Option<Uuid> {
        let b = s.as_bytes();
        if b.len() != 36 || b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
            return None;
        }
        let mut out = [0u8; 16];
        let mut nibbles = b.iter().filter(|&&c| c != b'-').map(|&c| hex_val(c));
        for byte in &mut out {
            let hi = nibbles.next()??;
            let lo = nibbles.next()??;
            *byte = (hi << 4) | lo;
        }
        Some(Uuid(out))
    }

    /// A version-4 UUID built from 16 bytes (version and variant bits set).
    pub fn v4_from_bytes(mut b: [u8; 16]) -> Uuid {
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        Uuid(b)
    }

    /// A version-7 UUID from a millisecond timestamp and 10 random bytes
    /// (74 bits used). Callers take the bytes from the injected entropy.
    pub fn v7_from_parts(unix_ms: u64, random: [u8; 10]) -> Uuid {
        let mut b = [0u8; 16];
        b[..6].copy_from_slice(&unix_ms.to_be_bytes()[2..]);
        b[6..].copy_from_slice(&random);
        b[6] = (b[6] & 0x0f) | 0x70;
        b[8] = (b[8] & 0x3f) | 0x80;
        Uuid(b)
    }
}

impl fmt::Display for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, byte) in self.0.iter().enumerate() {
            if matches!(i, 4 | 6 | 8 | 10) {
                f.write_str("-")?;
            }
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Uuid({self})")
    }
}

/// A SHA-256 digest.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Hash(pub [u8; 32]);

impl Hash {
    /// SHA-256 of `bytes`, with no domain tag (revisions, `body_base`).
    pub fn of(bytes: &[u8]) -> Hash {
        Hash(Sha256::digest(bytes).into())
    }

    /// Lowercase hex, 64 digits.
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push(HEX[usize::from(b >> 4)] as char);
            s.push(HEX[usize::from(b & 0x0f)] as char);
        }
        s
    }

    /// Parse `sha256:<64 hex>` (the spec's token form) or bare 64 hex digits.
    pub fn parse(s: &str) -> Option<Hash> {
        let hex = s.strip_prefix("sha256:").unwrap_or(s).as_bytes();
        if hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = (hex_val(hex[2 * i])? << 4) | hex_val(hex[2 * i + 1])?;
        }
        Some(Hash(out))
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{}", self.to_hex())
    }
}

impl fmt::Debug for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hash({self})")
    }
}

/// The revision of a document or resource: SHA-256 of its exact bytes.
pub fn revision(doc: &str) -> Hash {
    Hash::of(doc.as_bytes())
}

/// `MAC(k, tag, m) = HMAC-SHA256(k, u8(len(tag)) ‖ tag ‖ m)` (`00-overview.md` §4).
pub fn mac(key: &[u8], tag: &str, m: &[u8]) -> [u8; 32] {
    let tag_len = u8::try_from(tag.len()).unwrap_or(u8::MAX);
    hmac_sha256(key, &[&[tag_len], tag.as_bytes(), m])
}

/// HMAC-SHA256 (RFC 2104) over the concatenation of `parts`.
fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    for p in parts {
        inner.update(p);
    }
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_round_trip() {
        let s = "0190f5a2-7b3c-7def-8123-456789abcdef";
        let u = Uuid::parse(s).unwrap();
        assert_eq!(u.to_string(), s);
        assert!(Uuid::parse("0190f5a27b3c7def8123456789abcdef").is_none());
        assert!(Uuid::parse("0190f5a2-7b3c-7def-8123-456789abcdeg").is_none());
    }

    #[test]
    fn hash_of_empty() {
        assert_eq!(
            revision("").to_string(),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let h = revision("abc");
        assert_eq!(Hash::parse(&h.to_string()), Some(h));
    }

    #[test]
    fn hmac_rfc4231_case_2() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
        let out = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        assert_eq!(
            Hash(out).to_hex(),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_long_key() {
        // RFC 4231 test case 6: 131-byte key.
        let key = [0xaau8; 131];
        let out = hmac_sha256(
            &key,
            &[b"Test Using Larger Than Block-Size Key - Hash Key First"],
        );
        assert_eq!(
            Hash(out).to_hex(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }
}
