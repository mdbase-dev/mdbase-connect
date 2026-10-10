//! The old hosted provider (`MC/crates/connect-hosted-provider/`): Postgres rows,
//! their encryption, and collection key unwrapping.
//!
//! **What is where** (legacy hosted layout):
//! - Records, resources, history and receipts live in Postgres, sealed per column with
//!   AES-256-GCM under a per-collection 256-bit key. The envelope is
//!   `0x01 ‖ nonce[12] ‖ ct ‖ tag` (`MP/src/symmetric_crypto.rs`). The AAD is the JSON
//!   of an identity tuple (`MP/src/provider/crypto_state.rs`).
//! - The collection key is wrapped either by the legacy deployment key
//!   (`local-aes-256-gcm-v1`) or by AWS KMS in an `MDBK` envelope (ADR 0003,
//!   `MP/src/key_wrapping/`).
//! - File bytes are in R2 **without** application encryption. Only their metadata is
//!   sealed here.
//!
//! This module decrypts and decodes. It reads rows only through [`source`], and it
//! never calls KMS itself: the caller supplies a [`KmsDecrypt`], so that this crate
//! has no AWS dependency.

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::Deserialize;

use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::revision_of;

#[cfg(feature = "pg")]
pub mod source;

/// A collection's 256-bit data key. Zeroed on drop (`zeroize`).
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct CollectionKey([u8; 32]);

impl CollectionKey {
    /// From raw key bytes (tests, and the KMS path).
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl std::fmt::Debug for CollectionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CollectionKey(..)")
    }
}

/// Errors from decryption and decoding. They never include plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedError {
    /// The ciphertext envelope is malformed.
    Envelope,
    /// Authentication failed: wrong key, wrong AAD, or tampering.
    Authentication,
    /// The wrapped key format is unknown.
    WrappedKey(String),
    /// KMS refused or returned something unexpected.
    Kms(String),
    /// The plaintext doesn't decode as the expected structure.
    Decode(String),
    /// The plaintext decodes but contradicts its row (ID, revision).
    Inconsistent(String),
}

impl std::fmt::Display for HostedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Envelope => f.write_str("ciphertext envelope is invalid"),
            Self::Authentication => f.write_str("ciphertext failed authentication"),
            Self::WrappedKey(d) => write!(f, "wrapped key: {d}"),
            Self::Kms(d) => write!(f, "kms: {d}"),
            Self::Decode(d) => write!(f, "decode: {d}"),
            Self::Inconsistent(d) => write!(f, "inconsistent: {d}"),
        }
    }
}

impl std::error::Error for HostedError {}

type HResult<T> = std::result::Result<T, HostedError>;

/// A JSON decode error described by category and position only. `serde_json`'s
/// `Display` can quote the offending value, which here is decrypted plaintext.
pub(crate) fn json_error(e: &serde_json::Error) -> HostedError {
    HostedError::Decode(format!(
        "{:?} error at line {} column {}",
        e.classify(),
        e.line(),
        e.column()
    ))
}

/// Open an envelope `0x01 ‖ nonce[12] ‖ ct ‖ tag` with `key` and `aad`.
pub fn open(key: &CollectionKey, envelope: &[u8], aad: &[u8]) -> HResult<Vec<u8>> {
    open_raw(&key.0, envelope, aad)
}

fn open_raw(key: &[u8; 32], envelope: &[u8], aad: &[u8]) -> HResult<Vec<u8>> {
    if envelope.len() <= 13 || envelope[0] != 1 {
        return Err(HostedError::Envelope);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| HostedError::Envelope)?;
    let nonce = Nonce::from_slice(&envelope[1..13]);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &envelope[13..],
                aad,
            },
        )
        .map_err(|_| HostedError::Authentication)
}

/// AAD builders: `serde_json` of the provider's identity tuples. UUIDs are lowercase
/// hyphenated strings, and sequences are bare numbers.
pub mod aad {
    fn json(v: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&v).unwrap_or_default()
    }
    /// `collections.resources_ciphertext`.
    pub fn resources(cid: &str) -> Vec<u8> {
        json(serde_json::json!(["resources", cid]))
    }
    /// `hosted_provider_resources.document_ciphertext`.
    pub fn resource_document(cid: &str, path: &str) -> Vec<u8> {
        json(serde_json::json!(["resource_document", cid, path]))
    }
    /// `hosted_provider_records.payload_ciphertext`.
    pub fn current_record(cid: &str, rid: &str, sequence: u64) -> Vec<u8> {
        json(serde_json::json!(["current_record", cid, rid, sequence]))
    }
    /// `hosted_provider_files.payload_ciphertext`.
    pub fn current_file(cid: &str, fid: &str, sequence: u64) -> Vec<u8> {
        json(serde_json::json!(["current_file", cid, fid, sequence]))
    }
    /// `hosted_provider_changes.{before,after}_ciphertext`.
    pub fn change_record(cid: &str, sequence: u64, side: &str) -> Vec<u8> {
        json(serde_json::json!(["change_record", cid, sequence, side]))
    }
    /// `hosted_provider_file_changes.{before,after}_ciphertext`.
    pub fn change_file(cid: &str, sequence: u64, side: &str) -> Vec<u8> {
        json(serde_json::json!(["change_file", cid, sequence, side]))
    }
    /// `hosted_provider_record_versions.payload_ciphertext`
    /// (`MP/src/provider/crypto_state.rs:25`).
    pub fn record_version(cid: &str, rid: &str, sequence: u64) -> Vec<u8> {
        json(serde_json::json!(["record_version", cid, rid, sequence]))
    }
    /// `hosted_provider_file_versions.payload_ciphertext`
    /// (`MP/src/provider/crypto_state.rs:72`).
    pub fn file_version(cid: &str, fid: &str, sequence: u64) -> Vec<u8> {
        json(serde_json::json!(["file_version", cid, fid, sequence]))
    }
    /// A legacy-wrapped collection key.
    pub fn collection_key(cid: &str) -> Vec<u8> {
        json(serde_json::json!(["collection_key", cid]))
    }
}

/// A wrapped collection key (`collections.wrapped_data_key`).
#[derive(Debug, PartialEq, Eq)]
pub enum WrappedKey<'a> {
    /// `local-aes-256-gcm-v1`: the §2.2 envelope under the deployment master key.
    Legacy(&'a [u8]),
    /// `aws-kms-v1`: `MDBK | 1 | 1 | u16 key_ref_len | u32 ct_len | key_ref | ct`.
    Kms {
        /// The immutable KMS key ARN.
        key_ref: &'a str,
        /// The KMS `CiphertextBlob`.
        ciphertext: &'a [u8],
    },
}

impl<'a> WrappedKey<'a> {
    /// Classify and parse, exactly as `MP/src/key_wrapping/envelope.rs` does.
    pub fn parse(value: &'a [u8]) -> HResult<Self> {
        if value.first() == Some(&1) && !value.starts_with(b"MDBK") {
            return Ok(Self::Legacy(value));
        }
        let bad = |d: &str| HostedError::WrappedKey(d.to_owned());
        if value.len() < 12 || &value[..4] != b"MDBK" {
            return Err(bad("not an MDBK envelope"));
        }
        if value[4] != 1 || value[5] != 1 {
            return Err(bad("unsupported MDBK version or scheme"));
        }
        let key_ref_len = usize::from(u16::from_be_bytes([value[6], value[7]]));
        let ct_len = u32::from_be_bytes([value[8], value[9], value[10], value[11]]) as usize;
        if key_ref_len == 0
            || key_ref_len > 2048
            || ct_len == 0
            || ct_len > 8192
            || value.len() != 12 + key_ref_len + ct_len
        {
            return Err(bad("MDBK lengths are inconsistent"));
        }
        let key_ref = std::str::from_utf8(&value[12..12 + key_ref_len])
            .map_err(|_| bad("key_ref is not UTF-8"))?;
        if !key_ref
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
        {
            return Err(bad("key_ref has invalid characters"));
        }
        Ok(Self::Kms {
            key_ref,
            ciphertext: &value[12 + key_ref_len..],
        })
    }
}

/// The legacy deployment master key (`MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY`).
/// Zeroed on drop.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct LegacyMasterKey([u8; 32]);

impl LegacyMasterKey {
    /// Decode as the provider does: URL-safe base64 without padding, then standard.
    pub fn from_base64(value: &str) -> HResult<Self> {
        use base64::Engine;
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        let bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(value)
                .or_else(|_| STANDARD.decode(value))
                .map_err(|_| HostedError::WrappedKey("master key is not base64".into()))?,
        );
        let mut key = Self([0; 32]);
        if bytes.len() != 32 {
            return Err(HostedError::WrappedKey("master key is not 32 bytes".into()));
        }
        key.0.copy_from_slice(&bytes);
        Ok(key)
    }
}

/// KMS `Decrypt`, supplied by the caller (the migrator links the AWS SDK; tests fake
/// it).
pub trait KmsDecrypt {
    /// Decrypt `ciphertext` with the exact `context`. Returns the KMS `KeyId` that
    /// decrypted it, and the plaintext key in a buffer that is wiped on drop.
    fn decrypt(
        &self,
        ciphertext: &[u8],
        context: &BTreeMap<String, String>,
    ) -> std::result::Result<(String, Zeroizing<Vec<u8>>), String>;
}

/// The exact KMS encryption context for a collection key (ADR 0003,
/// `MP/src/key_wrapping/mod.rs:184-205`).
pub fn kms_context(environment: &str, cid: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("mdbase:service".into(), "hosted-provider".into()),
        ("mdbase:environment".into(), environment.into()),
        ("mdbase:purpose".into(), "collection-data-key".into()),
        ("mdbase:envelope-version".into(), "1".into()),
        ("mdbase:collection-id".into(), cid.into()),
    ])
}

/// How to unwrap collection keys in one environment.
pub struct Unwrapper<'a> {
    /// The legacy master key, if any stored row may need it.
    pub legacy: Option<&'a LegacyMasterKey>,
    /// KMS, if any stored row may need it.
    pub kms: Option<&'a dyn KmsDecrypt>,
    /// `staging` / `production` (`local` for LAB and tests).
    pub environment: &'a str,
}

impl Unwrapper<'_> {
    /// Unwrap collection `cid`'s key.
    pub fn unwrap(&self, wrapped: &[u8], cid: &str) -> HResult<CollectionKey> {
        let plain: Zeroizing<Vec<u8>> = match WrappedKey::parse(wrapped)? {
            WrappedKey::Legacy(env) => {
                let master = self
                    .legacy
                    .ok_or_else(|| HostedError::WrappedKey("legacy key not configured".into()))?;
                Zeroizing::new(open_raw(&master.0, env, &aad::collection_key(cid))?)
            }
            WrappedKey::Kms {
                key_ref,
                ciphertext,
            } => {
                let kms = self
                    .kms
                    .ok_or_else(|| HostedError::Kms("KMS not configured".into()))?;
                let (key_id, plain) = kms
                    .decrypt(ciphertext, &kms_context(self.environment, cid))
                    .map_err(HostedError::Kms)?;
                if !same_kms_key(&key_id, key_ref) {
                    return Err(HostedError::Kms("decrypted by a different key".into()));
                }
                plain
            }
        };
        if plain.len() != 32 {
            return Err(HostedError::WrappedKey(
                "unwrapped key is not 32 bytes".into(),
            ));
        }
        let mut key = CollectionKey([0; 32]);
        key.0.copy_from_slice(&plain);
        Ok(key)
    }
}

/// The returned `KeyId` must name the enveloped key, or be the same multi-region key
/// (`mrk-…`) in another region (`MP/src/key_wrapping/aws.rs:133-163`).
fn same_kms_key(returned: &str, enveloped: &str) -> bool {
    if returned == enveloped {
        return true;
    }
    let mrk = |arn: &str| arn.rsplit_once("key/").map(|(_, id)| id.to_owned());
    match (mrk(returned), mrk(enveloped)) {
        (Some(a), Some(b)) => a.starts_with("mrk-") && a == b,
        _ => false,
    }
}

/// A current record, decoded (`SyncRecord`, `MC/crates/connect-protocol/src/
/// collections.rs:128-140`). The derived `frontmatter`, `body` and `types` are
/// dropped: `document` is authoritative.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// Record ID (kept at migration).
    pub record_id: String,
    /// Collection-relative path.
    pub path: String,
    /// The exact Markdown.
    pub document: String,
    /// `"sha256:<hex>"` of `document`.
    pub revision: String,
}

#[derive(Deserialize)]
struct SyncRecord {
    record_id: String,
    path: String,
    document: String,
    revision: String,
}

/// Decrypt and check a `hosted_provider_records` row: the payload's ID and revision
/// must equal the row's, and the revision must be the document's digest.
pub fn decode_record(
    key: &CollectionKey,
    cid: &str,
    row_record_id: &str,
    row_revision: &str,
    sequence: u64,
    payload: &[u8],
) -> HResult<Record> {
    let plain = open(
        key,
        payload,
        &aad::current_record(cid, row_record_id, sequence),
    )?;
    let r: SyncRecord = serde_json::from_slice(&plain).map_err(|e| json_error(&e))?;
    if r.record_id != row_record_id {
        return Err(HostedError::Inconsistent(
            "record_id differs from its row".into(),
        ));
    }
    if r.revision != row_revision || revision_of(r.document.as_bytes()) != r.revision {
        return Err(HostedError::Inconsistent(format!(
            "record {row_record_id}: revision does not match its document"
        )));
    }
    Ok(Record {
        record_id: r.record_id,
        path: r.path,
        document: r.document,
        revision: r.revision,
    })
}

/// One version of a record (`hosted_provider_record_versions`), decoded. A deleted
/// version has no path or document. Pre-history source (pre-history preservation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordVersion {
    /// Record ID.
    pub record_id: String,
    /// Legacy sequence of this version.
    pub sequence: u64,
    /// The row's revision token, exactly as stored.
    pub revision: String,
    /// Row `created_at`, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// A deletion version.
    pub deleted: bool,
    /// Path at this version.
    pub path: Option<String>,
    /// The exact document at this version.
    pub document: Option<String>,
}

/// Decrypt and check a `hosted_provider_record_versions` row. `deleted` must agree
/// with the payload's presence; a live payload's ID and revision must equal the row's,
/// and the revision must be the document's digest.
#[allow(clippy::too_many_arguments)]
pub fn decode_record_version(
    key: &CollectionKey,
    cid: &str,
    row_record_id: &str,
    sequence: u64,
    row_revision: &str,
    created_at_ms: i64,
    deleted: bool,
    payload: Option<&[u8]>,
) -> HResult<RecordVersion> {
    let (path, document) = match (deleted, payload) {
        (true, None) => (None, None),
        (false, Some(ct)) => {
            let plain = open(key, ct, &aad::record_version(cid, row_record_id, sequence))?;
            let r: SyncRecord = serde_json::from_slice(&plain).map_err(|e| json_error(&e))?;
            if r.record_id != row_record_id {
                return Err(HostedError::Inconsistent(
                    "record_id differs from its version row".into(),
                ));
            }
            if r.revision != row_revision || revision_of(r.document.as_bytes()) != r.revision {
                return Err(HostedError::Inconsistent(format!(
                    "record {row_record_id} version {sequence}: revision does not match its document"
                )));
            }
            (Some(r.path), Some(r.document))
        }
        _ => {
            return Err(HostedError::Inconsistent(format!(
                "record {row_record_id} version {sequence}: deleted flag disagrees with its payload"
            )));
        }
    };
    Ok(RecordVersion {
        record_id: row_record_id.to_owned(),
        sequence,
        revision: row_revision.to_owned(),
        created_at_ms,
        deleted,
        path,
        document,
    })
}

/// One version of a file (`hosted_provider_file_versions`), decoded. A deleted version
/// has no size, object key, digest or path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileVersion {
    /// File ID.
    pub file_id: String,
    /// Legacy sequence of this version.
    pub sequence: u64,
    /// The row's revision token, exactly as stored.
    pub revision: String,
    /// Row `created_at`, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// A deletion version.
    pub deleted: bool,
    /// Path at this version.
    pub path: Option<String>,
    /// `"sha256:<hex>"` of the bytes at this version.
    pub content_digest: Option<String>,
    /// Size in bytes.
    pub size: Option<u64>,
    /// The R2 key of the old bytes (second pass), never reconstructed.
    pub object_key: Option<String>,
    /// MIME type, if recorded.
    pub media_type: Option<String>,
    /// Media class.
    pub media_class: Option<String>,
}

/// Decrypt and check a `hosted_provider_file_versions` row. The DDL ties `deleted` to
/// NULL `object_key`, `size` and payload; this checks the same agreement.
#[allow(clippy::too_many_arguments)]
pub fn decode_file_version(
    key: &CollectionKey,
    cid: &str,
    row_file_id: &str,
    sequence: u64,
    row_revision: &str,
    created_at_ms: i64,
    deleted: bool,
    size: Option<u64>,
    object_key: Option<&str>,
    payload: Option<&[u8]>,
) -> HResult<FileVersion> {
    let mut v = FileVersion {
        file_id: row_file_id.to_owned(),
        sequence,
        revision: row_revision.to_owned(),
        created_at_ms,
        deleted,
        path: None,
        content_digest: None,
        size: None,
        object_key: None,
        media_type: None,
        media_class: None,
    };
    match (deleted, payload, size, object_key) {
        (true, None, None, None) => {}
        (false, Some(ct), Some(size), Some(object_key)) => {
            let plain = open(key, ct, &aad::file_version(cid, row_file_id, sequence))?;
            let p: FilePayload = serde_json::from_slice(&plain).map_err(|e| json_error(&e))?;
            if !p.content_digest.starts_with("sha256:") || p.content_digest.len() != 71 {
                return Err(HostedError::Inconsistent(format!(
                    "file {row_file_id} version {sequence}: content_digest is not sha256"
                )));
            }
            v.path = Some(p.path);
            v.content_digest = Some(p.content_digest);
            v.size = Some(size);
            v.object_key = Some(object_key.to_owned());
            v.media_type = p.media_type;
            v.media_class = Some(p.media_class);
        }
        _ => {
            return Err(HostedError::Inconsistent(format!(
                "file {row_file_id} version {sequence}: deleted flag disagrees with its row"
            )));
        }
    }
    Ok(v)
}

/// A live file's metadata, decoded (`HostedFilePayload`, `MP/src/provider/files.rs:23-29`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMeta {
    /// File ID (kept at migration).
    pub file_id: String,
    /// Collection-relative path.
    pub path: String,
    /// `"sha256:<hex>"` of the R2 bytes.
    pub content_digest: String,
    /// Size in bytes (from the row).
    pub size: u64,
    /// The R2 key, read from the row and never reconstructed.
    pub object_key: String,
    /// MIME type, if recorded.
    pub media_type: Option<String>,
    /// `image` / `audio` / `video` / `pdf` / `other`.
    pub media_class: String,
}

#[derive(Deserialize)]
struct FilePayload {
    path: String,
    content_digest: String,
    media_type: Option<String>,
    media_class: String,
}

/// Decrypt a `hosted_provider_files` row.
pub fn decode_file(
    key: &CollectionKey,
    cid: &str,
    file_id: &str,
    sequence: u64,
    size: u64,
    object_key: &str,
    payload: &[u8],
) -> HResult<FileMeta> {
    let plain = open(key, payload, &aad::current_file(cid, file_id, sequence))?;
    let p: FilePayload = serde_json::from_slice(&plain).map_err(|e| json_error(&e))?;
    if !p.content_digest.starts_with("sha256:") || p.content_digest.len() != 71 {
        return Err(HostedError::Inconsistent(format!(
            "file {file_id}: content_digest is not sha256"
        )));
    }
    Ok(FileMeta {
        file_id: file_id.to_owned(),
        path: p.path,
        content_digest: p.content_digest,
        size,
        object_key: object_key.to_owned(),
        media_type: p.media_type,
        media_class: p.media_class,
    })
}

/// Decrypt a `hosted_provider_resources` row into its exact bytes, checking the
/// row's revision where it is a digest. Revisions of the form `hosted:1:<n>:resources`
/// are sequence markers, not digests, and aren't checked.
pub fn decode_resource(
    key: &CollectionKey,
    cid: &str,
    path: &str,
    revision: &str,
    payload: &[u8],
) -> HResult<Vec<u8>> {
    let bytes = open(key, payload, &aad::resource_document(cid, path))?;
    if revision.starts_with("sha256:") && revision_of(&bytes) != revision {
        return Err(HostedError::Inconsistent(format!(
            "resource {path}: revision does not match"
        )));
    }
    Ok(bytes)
}

/// Check R2 bytes against their file row before re-sealing (migration H2).
pub fn verify_object(meta: &FileMeta, bytes: &[u8]) -> HResult<()> {
    if bytes.len() as u64 != meta.size || revision_of(bytes) != meta.content_digest {
        return Err(HostedError::Inconsistent(format!(
            "file {}: R2 object does not match its digest or size",
            meta.file_id
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// Seal like the provider, with a fixed nonce (tests only).
    pub fn seal(key: &[u8; 32], plain: &[u8], aad: &[u8], nonce: u8) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let n = [nonce; 12];
        let ct = cipher
            .encrypt(Nonce::from_slice(&n), Payload { msg: plain, aad })
            .unwrap();
        let mut out = vec![1u8];
        out.extend_from_slice(&n);
        out.extend_from_slice(&ct);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testing::seal;
    use super::*;

    const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
    const RID: &str = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";

    #[test]
    fn aad_matches_provider_serialisation() {
        assert_eq!(
            aad::current_record(CID, RID, 17),
            format!(r#"["current_record","{CID}","{RID}",17]"#).into_bytes()
        );
        assert_eq!(
            aad::collection_key(CID),
            format!(r#"["collection_key","{CID}"]"#).into_bytes()
        );
    }

    #[test]
    fn legacy_unwrap_and_record_decode() {
        let master = [7u8; 32];
        let dek = [9u8; 32];
        let wrapped = seal(&master, &dek, &aad::collection_key(CID), 1);
        assert_eq!(wrapped.len(), 61);
        let mk = {
            use base64::Engine;
            LegacyMasterKey::from_base64(&base64::engine::general_purpose::STANDARD.encode(master))
                .unwrap()
        };
        let u = Unwrapper {
            legacy: Some(&mk),
            kms: None,
            environment: "local",
        };
        let key = u.unwrap(&wrapped, CID).unwrap();
        // The wrong collection fails authentication: keys can't be moved.
        assert!(
            u.unwrap(&wrapped, "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
                .is_err()
        );

        let doc = "---\ntitle: A\n---\nbody\n";
        let rev = revision_of(doc.as_bytes());
        let payload = serde_json::json!({
            "record_id": RID, "path": "notes/a.md", "document": doc, "revision": rev,
            "frontmatter": {"title": "A"}, "body": "body\n", "types": []
        });
        let sealed = seal(
            &dek,
            &serde_json::to_vec(&payload).unwrap(),
            &aad::current_record(CID, RID, 3),
            2,
        );
        let r = decode_record(&key, CID, RID, &rev, 3, &sealed).unwrap();
        assert_eq!(r.document, doc);
        // Wrong sequence = wrong AAD.
        assert_eq!(
            decode_record(&key, CID, RID, &rev, 4, &sealed),
            Err(HostedError::Authentication)
        );
        // A row revision that disagrees is caught.
        assert!(matches!(
            decode_record(&key, CID, RID, "sha256:00", 3, &sealed),
            Err(HostedError::Inconsistent(_))
        ));
    }

    struct FakeKms {
        key_id: String,
        plain: Vec<u8>,
    }
    impl KmsDecrypt for FakeKms {
        fn decrypt(
            &self,
            _: &[u8],
            context: &BTreeMap<String, String>,
        ) -> std::result::Result<(String, Zeroizing<Vec<u8>>), String> {
            assert_eq!(context["mdbase:collection-id"], CID);
            assert_eq!(context["mdbase:environment"], "staging");
            Ok((self.key_id.clone(), Zeroizing::new(self.plain.clone())))
        }
    }

    fn mdbk(key_ref: &str, ct: &[u8]) -> Vec<u8> {
        let mut v = b"MDBK".to_vec();
        v.extend([1, 1]);
        v.extend((key_ref.len() as u16).to_be_bytes());
        v.extend((ct.len() as u32).to_be_bytes());
        v.extend(key_ref.as_bytes());
        v.extend(ct);
        v
    }

    #[test]
    fn kms_envelope() {
        let arn = "arn:aws:kms:ap-southeast-1:111122223333:key/mrk-0123";
        let wrapped = mdbk(arn, b"blob");
        assert_eq!(
            WrappedKey::parse(&wrapped).unwrap(),
            WrappedKey::Kms {
                key_ref: arn,
                ciphertext: b"blob"
            }
        );
        let kms = FakeKms {
            key_id: "arn:aws:kms:ap-southeast-2:111122223333:key/mrk-0123".into(),
            plain: vec![5; 32],
        };
        let u = Unwrapper {
            legacy: None,
            kms: Some(&kms),
            environment: "staging",
        };
        assert!(u.unwrap(&wrapped, CID).is_ok(), "same multi-region key");
        let other = FakeKms {
            key_id: "arn:aws:kms:ap-southeast-1:111122223333:key/other".into(),
            plain: vec![5; 32],
        };
        let u = Unwrapper {
            kms: Some(&other),
            ..u
        };
        assert!(u.unwrap(&wrapped, CID).is_err());
        // Truncated and trailing data are rejected.
        assert!(WrappedKey::parse(&wrapped[..wrapped.len() - 1]).is_err());
        let mut long = wrapped.clone();
        long.push(0);
        assert!(WrappedKey::parse(&long).is_err());
    }

    #[test]
    fn version_rows_decode_and_check() {
        let dek = [9u8; 32];
        let key = CollectionKey::from_bytes(dek);
        let doc = "---\ntitle: v2\n---\n";
        let rev = revision_of(doc.as_bytes());
        let payload = serde_json::to_vec(&serde_json::json!({
            "record_id": RID, "path": "notes/a.md", "document": doc, "revision": rev,
        }))
        .unwrap();
        let sealed = seal(&dek, &payload, &aad::record_version(CID, RID, 4), 8);
        let v = decode_record_version(
            &key,
            CID,
            RID,
            4,
            &rev,
            1_790_000_000_000,
            false,
            Some(&sealed),
        )
        .unwrap();
        assert_eq!(v.document.as_deref(), Some(doc));
        assert_eq!(v.path.as_deref(), Some("notes/a.md"));
        // The current-record AAD does not open a version row.
        let wrong = seal(&dek, &payload, &aad::current_record(CID, RID, 4), 8);
        assert!(decode_record_version(&key, CID, RID, 4, &rev, 0, false, Some(&wrong)).is_err());
        // A tombstone: no payload; the flag must agree.
        let t = decode_record_version(&key, CID, RID, 5, "prev", 1, true, None).unwrap();
        assert!(t.deleted && t.document.is_none() && t.path.is_none());
        assert!(decode_record_version(&key, CID, RID, 5, "prev", 1, false, None).is_err());
        assert!(decode_record_version(&key, CID, RID, 4, &rev, 0, true, Some(&sealed)).is_err());
        // File versions.
        let fid = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";
        let fp = serde_json::to_vec(&serde_json::json!({
            "path": "att/a.png", "content_digest": revision_of(b"png"), "media_type": "image/png",
            "media_class": "image"
        }))
        .unwrap();
        let fs = seal(&dek, &fp, &aad::file_version(CID, fid, 6), 9);
        let f = decode_file_version(
            &key,
            CID,
            fid,
            6,
            "r",
            2,
            false,
            Some(3),
            Some("v1/blobs/x"),
            Some(&fs),
        )
        .unwrap();
        assert_eq!(f.size, Some(3));
        assert_eq!(f.object_key.as_deref(), Some("v1/blobs/x"));
        assert_eq!(
            f.content_digest.as_deref(),
            Some(revision_of(b"png").as_str())
        );
        assert!(
            decode_file_version(&key, CID, fid, 7, "r", 2, true, None, None, None)
                .unwrap()
                .deleted
        );
        assert!(decode_file_version(&key, CID, fid, 7, "r", 2, true, Some(3), None, None).is_err());
    }

    #[test]
    fn json_errors_never_quote_plaintext() {
        let dek = [3u8; 32];
        let key = CollectionKey::from_bytes(dek);
        // A payload whose type error would make serde_json quote the secret value.
        let payload = br#"{"record_id": 7, "path": "SECRET-PLAINTEXT"}"#;
        let sealed = seal(&dek, payload, &aad::current_record(CID, RID, 1), 6);
        let err = decode_record(&key, CID, RID, "sha256:00", 1, &sealed).unwrap_err();
        let text = err.to_string();
        assert!(!text.contains("SECRET"), "{text}");
        let payload = br#"{"record_id": "SECRET-PLAINTEXT-ID"}"#;
        let sealed = seal(&dek, payload, &aad::current_record(CID, RID, 1), 7);
        let text = decode_record(&key, CID, RID, "sha256:00", 1, &sealed)
            .unwrap_err()
            .to_string();
        assert!(!text.contains("SECRET"), "{text}");
    }

    #[test]
    fn file_and_object_verification() {
        let dek = [3u8; 32];
        let key = CollectionKey::from_bytes(dek);
        let fid = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
        let bytes = b"\x89PNG...";
        let payload = serde_json::json!({
            "path": "attachments/a.png", "content_digest": revision_of(bytes),
            "media_type": "image/png", "media_class": "image", "modified_at": "2026-10-01T00:00:00Z"
        });
        let sealed = seal(
            &dek,
            &serde_json::to_vec(&payload).unwrap(),
            &aad::current_file(CID, fid, 9),
            4,
        );
        let m = decode_file(&key, CID, fid, 9, bytes.len() as u64, "v1/blobs/x", &sealed).unwrap();
        assert_eq!(m.path, "attachments/a.png");
        assert!(verify_object(&m, bytes).is_ok());
        assert!(verify_object(&m, b"other").is_err());
    }
}
