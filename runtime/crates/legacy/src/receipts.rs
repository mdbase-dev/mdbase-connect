//! The connector's durable receipt store (ADR 0007,
//! `crates/connect-core/src/registry/receipts.rs`).
//!
//! A receipt is the exact encrypted transport-v3 response the connector sent (or
//! would send) for a mutation. It is already encrypted to the grant, so migration
//! copies it verbatim and never needs the grant's keys.
//!
//! - **Reference:** `receipt-v1:sha256:<64 lowercase hex>:<byte length>`.
//! - **File:** `<state>/authority-receipts/<hex[0..2]>/<hex[2..]>.receipt`.
//! - **Inline:** at `connector.sqlite` schema 2 (beta.32–55), `final_receipt` holds
//!   the receipt itself instead of a reference.

use std::path::{Path, PathBuf};

use crate::{Error, Result, hex, sha256};

const PREFIX: &str = "receipt-v1:sha256:";

/// A parsed `final_receipt` / `response_receipt` value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiptValue {
    /// A reference into the receipt store.
    Stored {
        /// Lowercase hex SHA-256 of the receipt bytes.
        digest: String,
        /// Byte length.
        len: u64,
    },
    /// The receipt itself, stored inline (schema 2).
    Inline(String),
}

impl ReceiptValue {
    /// Parse a column value. Anything that isn't a well-formed `receipt-v1:`
    /// reference is an inline receipt, as the connector treats it
    /// (`receipts.rs:184-192`). A malformed `receipt-v1:` reference is an error.
    pub fn parse(value: &str) -> std::result::Result<Self, String> {
        let Some(rest) = value.strip_prefix(PREFIX) else {
            return Ok(Self::Inline(value.to_owned()));
        };
        let (digest, len) = rest
            .split_once(':')
            .ok_or_else(|| "receipt reference without a length".to_owned())?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("receipt reference digest is not 64 lowercase hex digits".into());
        }
        let len = len
            .parse::<u64>()
            .map_err(|_| "receipt reference length is not a number".to_owned())?;
        Ok(Self::Stored {
            digest: digest.to_owned(),
            len,
        })
    }
}

/// The receipt store under a connector state directory.
#[derive(Clone, Debug)]
pub struct ReceiptStore {
    root: PathBuf,
}

impl ReceiptStore {
    /// The store at `<state_dir>/authority-receipts`.
    pub fn new(state_dir: &Path) -> Self {
        Self {
            root: state_dir.join("authority-receipts"),
        }
    }

    /// Where a stored receipt lives.
    pub fn path_of(&self, digest: &str) -> PathBuf {
        self.root
            .join(&digest[..2])
            .join(format!("{}.receipt", &digest[2..]))
    }

    /// The receipt bytes for `value`, verified against the reference's digest and
    /// length. A missing or corrupt stored receipt is an error. The connector itself
    /// treats that as fail-closed (ADR 0007), and so does migration: the request
    /// becomes `outcome_unknown`, never a replay.
    pub fn load(&self, value: &ReceiptValue) -> Result<Vec<u8>> {
        match value {
            ReceiptValue::Inline(s) => Ok(s.as_bytes().to_vec()),
            ReceiptValue::Stored { digest, len } => {
                let path = self.path_of(digest);
                let meta = std::fs::symlink_metadata(&path).map_err(|e| Error::io(&path, e))?;
                if !meta.is_file() {
                    return Err(Error::format(&path, "receipt is not a regular file"));
                }
                let bytes = std::fs::read(&path).map_err(|e| Error::io(&path, e))?;
                if bytes.len() as u64 != *len || hex(&sha256(&bytes)) != *digest {
                    return Err(Error::format(
                        &path,
                        "receipt bytes do not match their reference",
                    ));
                }
                Ok(bytes)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_forms() {
        let d = "a".repeat(64);
        assert_eq!(
            ReceiptValue::parse(&format!("receipt-v1:sha256:{d}:12")).unwrap(),
            ReceiptValue::Stored { digest: d, len: 12 }
        );
        assert_eq!(
            ReceiptValue::parse("{\"protocol_version\":3}").unwrap(),
            ReceiptValue::Inline("{\"protocol_version\":3}".into())
        );
        assert!(ReceiptValue::parse("receipt-v1:sha256:abc:1").is_err());
        assert!(ReceiptValue::parse(&format!("receipt-v1:sha256:{}:x", "b".repeat(64))).is_err());
    }
}
