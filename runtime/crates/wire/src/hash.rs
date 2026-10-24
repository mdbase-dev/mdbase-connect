//! Hashing and domain separation (`docs/contracts/00-overview.md` §4).
//!
//! `H(tag, m) = SHA-256(u8(len(tag)) ‖ tag ‖ m)`. Tags are ASCII strings from the
//! registry in the overview; a new use gets a new tag.

use sha2::{Digest, Sha256};

use crate::common::B32;

/// Plain SHA-256: document and file revisions, snapshot object addresses.
pub fn sha256(m: &[u8]) -> B32 {
    B32(Sha256::digest(m).into())
}

/// Domain-separated hash `H(tag, m)`.
///
/// # Panics
/// If `tag` is longer than 255 bytes (all registry tags are short constants).
pub fn h(tag: &str, m: &[u8]) -> B32 {
    let len = u8::try_from(tag.len()).expect("domain tag longer than 255 bytes");
    let mut d = Sha256::new();
    d.update([len]);
    d.update(tag.as_bytes());
    d.update(m);
    B32(d.finalize().into())
}

/// `chain(p) = H("mdbase/v1/chain", canonical bytes of the complete item at p)`.
pub fn chain_hash(item_bytes: &[u8]) -> B32 {
    h("mdbase/v1/chain", item_bytes)
}

/// `chain(0)`: 32 zero bytes.
pub const CHAIN_ZERO: B32 = B32([0; 32]);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_answer() {
        // FIPS 180-2 "abc"
        assert_eq!(
            sha256(b"abc").to_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn domain_tag_is_length_prefixed() {
        let mut m = vec![3u8];
        m.extend_from_slice(b"abc");
        m.extend_from_slice(b"xyz");
        assert_eq!(h("abc", b"xyz"), sha256(&m));
        assert_ne!(h("abc", b"xyz"), h("abcx", b"yz"));
    }
}
