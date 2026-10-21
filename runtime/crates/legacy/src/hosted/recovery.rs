//! Native current/retained file recovery component for the SAME archive verifier.
//!
//! Caller first verifies the signed selected-data archive and reconstructs/checks
//! its complete rows. This is NOT an archive/signature verifier or serving path.
//! Metadata is authenticated using the existing unwrap/AAD/decode code, then
//! ORIGINAL recovered R2 bytes are checked by `verify_object`. Legacy R2 bytes
//! have no application encryption: only metadata is sealed. Before that native
//! authentication, an opaque object hash alone is not readable-file proof.
//!
//! Input is private bounded JSON, followed by original objects in exact sorted
//! key order on a reader. No database/path/URL/environment credential selectors.
//! KMS replies are supplied ONLY by the verifier's authenticated fixed-custody
//! KMS adapter; their JSON shape is not KMS authentication. Tests fake that I/O.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::{FileMeta, HostedError, KmsDecrypt, LegacyMasterKey, Unwrapper};

#[cfg(test)]
mod tests;

const MAX_HEADER: usize = 64 * 1024 * 1024;
const MAX_OBJECT: u64 = 1024 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
type Result<T> = std::result::Result<T, HostedError>;
fn bad() -> HostedError {
    HostedError::Inconsistent("scoped recovered file closure is invalid".into())
}
fn require(value: bool) -> Result<()> {
    if value { Ok(()) } else { Err(bad()) }
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn bytes(value: &str) -> Result<Zeroizing<Vec<u8>>> {
    let raw = value.strip_prefix("\\x").ok_or_else(bad)?;
    require(raw.len() <= 8 * 1024 * 1024 && raw.len().is_multiple_of(2) && hex(raw, raw.len()))?;
    let mut result = Zeroizing::new(Vec::with_capacity(raw.len() / 2));
    for pair in raw.as_bytes().chunks_exact(2) {
        let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        result.push(digit(pair[0]) * 16 + digit(pair[1]));
    }
    Ok(result)
}
fn sequence(value: &str) -> Result<u64> {
    require(
        !value.is_empty()
            && value.len() <= 19
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
    )?;
    let result = value.parse::<u64>().map_err(|_| bad())?;
    require(result <= i64::MAX as u64)?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    environment: String,
    source_rows_sha256: String,
    collections: Vec<Collection>,
    keys: Keys,
    objects: Vec<Object>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Collection {
    account_id: String,
    collection_id: String,
    wrapped_data_key: String,
    current: Vec<Row>,
    retained: Vec<Row>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    file_id: String,
    sequence: String,
    revision: String,
    size: u64,
    object_key: String,
    payload_ciphertext: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Object {
    object_key: String,
    size_bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Keys {
    environment: String,
    legacy_master_key: Option<String>,
    kms: Vec<KmsReply>,
}
impl Drop for Keys {
    fn drop(&mut self) {
        if let Some(key) = &mut self.legacy_master_key {
            key.zeroize();
        }
        for reply in &mut self.kms {
            reply.plaintext.zeroize();
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KmsReply {
    ciphertext_sha256: String,
    key_id: String,
    plaintext: String,
    context: Context,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    #[serde(rename = "mdbase:service")]
    service: String,
    #[serde(rename = "mdbase:environment")]
    environment: String,
    #[serde(rename = "mdbase:purpose")]
    purpose: String,
    #[serde(rename = "mdbase:envelope-version")]
    version: String,
    #[serde(rename = "mdbase:collection-id")]
    collection: String,
}
impl Context {
    fn map(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("mdbase:service".into(), self.service.clone()),
            ("mdbase:environment".into(), self.environment.clone()),
            ("mdbase:purpose".into(), self.purpose.clone()),
            ("mdbase:envelope-version".into(), self.version.clone()),
            ("mdbase:collection-id".into(), self.collection.clone()),
        ])
    }
}
impl KmsDecrypt for Keys {
    fn decrypt(
        &self,
        ciphertext: &[u8],
        context: &BTreeMap<String, String>,
    ) -> std::result::Result<(String, Zeroizing<Vec<u8>>), String> {
        let digest = crate::revision_of(ciphertext);
        let matches: Vec<_> = self
            .kms
            .iter()
            .filter(|reply| {
                reply.ciphertext_sha256 == digest[7..] && reply.context.map() == *context
            })
            .collect();
        if matches.len() != 1 {
            return Err("original KMS response/context unavailable".into());
        }
        let reply = matches[0];
        let plain = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(&reply.plaintext)
                .map_err(|_| "invalid private KMS key response")?,
        );
        Ok((reply.key_id.clone(), plain))
    }
}

#[derive(Serialize)]
struct Inventory {
    schema: &'static str,
    source_rows_sha256: String,
    files: Vec<Proof>,
}
#[derive(Serialize)]
struct Proof {
    account_id: String,
    collection_id: String,
    file_id: String,
    revision: String,
    sequence: String,
    current: bool,
    retained: bool,
    logical_size: u64,
    object_key: String,
    ciphertext: Digest,
    plaintext: Digest,
}
#[derive(Serialize)]
struct Digest {
    size_bytes: u64,
    sha256: String,
}
struct Prepared {
    proof: Proof,
    meta: FileMeta,
}

/// Authenticate/decode complete restored current+retained metadata and verify
/// all recovered ORIGINAL objects using the existing native legacy codec.
///
/// `header` is at most64MiB private JSON `mdbase-scoped-native-recovery-input/1`;
/// objects are concatenated on `reader` in the header's sorted unique original
/// key order. The complete reference/metadata closure is validated BEFORE any
/// object read. Per-object bound1GiB; one object is held at a time and wiped.
/// Returns the agreed inventory JSON, not archive verification/acceptance. The
/// caller must check original signed-row digest/KMS custody before invoking it.
/// Only the supplied byte stream is read; there is no source lookup, restore,
/// database/path/network selector or admission side effect.
pub fn recover_inventory(header: &[u8], reader: &mut impl Read) -> Result<Vec<u8>> {
    recover_inventory_staged(header, reader).map_err(|(_, error)| error)
}

/// The stage at which [`recover_inventory_staged`] refused. Carries no private
/// value; the binary maps it to a small fixed exit code only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Header bounds/JSON/schema, data environment or key custody environment.
    Header,
    /// Legacy key/KMS unwrap, metadata authentication/decode or reference
    /// closure, before any object read.
    KeyPreflight,
    /// Original object bytes, trailing input or inventory emission.
    ObjectProof,
}

impl Stage {
    /// Fixed process exit code for this refusal stage (1 is reserved for
    /// invocation/framing/output I/O in the binary).
    pub fn exit_code(self) -> u8 {
        match self {
            Stage::Header => 2,
            Stage::KeyPreflight => 3,
            Stage::ObjectProof => 4,
        }
    }
}

/// [`recover_inventory`], also reporting the refusal [`Stage`].
pub fn recover_inventory_staged(
    header: &[u8],
    reader: &mut impl Read,
) -> std::result::Result<Vec<u8>, (Stage, HostedError)> {
    let input = admit_header(header).map_err(|error| (Stage::Header, error))?;
    let closure = preflight(&input).map_err(|error| (Stage::KeyPreflight, error))?;
    prove_objects(input, closure, reader).map_err(|error| (Stage::ObjectProof, error))
}

/// Header stage: bounded JSON, schema, admitted data environment and key
/// custody environment, and collection/object/KMS-reply count bounds.
fn admit_header(header: &[u8]) -> Result<Input> {
    require(header.len() <= MAX_HEADER)?;
    let input: Input = serde_json::from_slice(header).map_err(|_| bad())?;
    require(
        input.schema == "mdbase-scoped-native-recovery-input/1"
            && ["lab", "staging", "production"].contains(&input.environment.as_str())
            && hex(&input.source_rows_sha256, 64),
    )?;
    require(key_environment_admitted(&input.environment, &input.keys))?;
    require(
        !input.collections.is_empty()
            && input.collections.len() <= 1000
            && input.objects.len() <= MAX_ROWS
            && input.keys.kms.len() <= 1000,
    )?;
    Ok(input)
}

/// Original key custody environment admitted for a data environment.
///
/// LAB accepts `lab` or `local` keys. Managed staging/production accept keys
/// recorded for the SAME environment, or the provider's default `local`
/// custody only when it is legacy-only: a legacy master key and NO KMS replies.
/// `local` with any KMS reply and every cross-environment pairing refuse.
fn key_environment_admitted(environment: &str, keys: &Keys) -> bool {
    match environment {
        "lab" => ["lab", "local"].contains(&keys.environment.as_str()),
        "staging" | "production" => {
            keys.environment == environment
                || (keys.environment == "local"
                    && keys.kms.is_empty()
                    && keys.legacy_master_key.is_some())
        }
        _ => false,
    }
}

type Closure = (
    BTreeMap<(String, String, u64), Prepared>,
    BTreeMap<String, Vec<(String, String, u64)>>,
);

/// Key preflight stage: unwrap every selected collection key, authenticate and
/// decode ALL current+retained metadata, and prove the complete object
/// reference closure, all before the first object read.
fn preflight(input: &Input) -> Result<Closure> {
    let legacy = input
        .keys
        .legacy_master_key
        .as_deref()
        .map(LegacyMasterKey::from_base64)
        .transpose()?;
    let unwrapper = Unwrapper {
        legacy: legacy.as_ref(),
        kms: Some(&input.keys),
        environment: &input.keys.environment,
    };
    let mut prepared = BTreeMap::<(String, String, u64), Prepared>::new();
    let mut references = BTreeMap::<String, (String, u64, String)>::new();
    let mut by_object = BTreeMap::<String, Vec<(String, String, u64)>>::new();
    let mut previous_collection = "";
    let mut row_counts = [0usize; 2];
    for collection in &input.collections {
        let cid = &collection.collection_id;
        require(uuid(cid) && uuid(&collection.account_id) && cid.as_str() > previous_collection)?;
        previous_collection = cid;
        let key = unwrapper.unwrap(&bytes(&collection.wrapped_data_key)?, cid)?;
        let current_ids: BTreeSet<_> = collection
            .current
            .iter()
            .map(|row| row.file_id.as_str())
            .collect();
        require(current_ids.len() == collection.current.len())?;
        for (kind, rows) in [&collection.current, &collection.retained]
            .into_iter()
            .enumerate()
        {
            row_counts[kind] = row_counts[kind].checked_add(rows.len()).ok_or_else(bad)?;
            require(row_counts[kind] <= MAX_ROWS)?;
            let mut previous = None;
            for row in rows {
                let seq = sequence(&row.sequence)?;
                let position = (row.file_id.as_str(), seq);
                require(
                    uuid(&row.file_id)
                        && previous.is_none_or(|p| p < position)
                        && current_ids.contains(row.file_id.as_str()),
                )?;
                previous = Some(position);
                require(
                    !row.revision.is_empty()
                        && row.revision.len() <= 1024
                        && !row.revision.contains('\0')
                        && row.size <= MAX_OBJECT
                        && !row.object_key.is_empty()
                        && row.object_key.len() <= 1024
                        && !row.object_key.contains('\0'),
                )?;
                let payload = bytes(&row.payload_ciphertext)?;
                let meta = if kind == 0 {
                    super::decode_file(
                        &key,
                        cid,
                        &row.file_id,
                        seq,
                        row.size,
                        &row.object_key,
                        &payload,
                    )?
                } else {
                    let version = super::decode_file_version(
                        &key,
                        cid,
                        &row.file_id,
                        seq,
                        &row.revision,
                        0,
                        false,
                        Some(row.size),
                        Some(&row.object_key),
                        Some(&payload),
                    )?;
                    FileMeta {
                        file_id: version.file_id,
                        path: version.path.ok_or_else(bad)?,
                        content_digest: version.content_digest.ok_or_else(bad)?,
                        size: version.size.ok_or_else(bad)?,
                        object_key: version.object_key.ok_or_else(bad)?,
                        media_type: version.media_type,
                        media_class: version.media_class.ok_or_else(bad)?,
                    }
                };
                require(
                    meta.content_digest.starts_with("sha256:")
                        && hex(&meta.content_digest[7..], 64),
                )?;
                let reference = (cid.clone(), meta.size, meta.content_digest.clone());
                if let Some(old) = references.insert(row.object_key.clone(), reference.clone()) {
                    require(old == reference)?;
                }
                let id = (cid.clone(), row.file_id.clone(), seq);
                if let Some(old) = prepared.get_mut(&id) {
                    require(
                        kind == 1
                            && old.proof.current
                            && !old.proof.retained
                            && old.proof.revision == row.revision
                            && old.meta == meta,
                    )?;
                    old.proof.retained = true;
                } else {
                    by_object
                        .entry(row.object_key.clone())
                        .or_default()
                        .push(id.clone());
                    prepared.insert(
                        id,
                        Prepared {
                            proof: Proof {
                                account_id: collection.account_id.clone(),
                                collection_id: cid.clone(),
                                file_id: row.file_id.clone(),
                                revision: row.revision.clone(),
                                sequence: row.sequence.clone(),
                                current: kind == 0,
                                retained: kind == 1,
                                logical_size: row.size,
                                object_key: row.object_key.clone(),
                                ciphertext: Digest {
                                    size_bytes: 0,
                                    sha256: String::new(),
                                },
                                plaintext: Digest {
                                    size_bytes: 0,
                                    sha256: String::new(),
                                },
                            },
                            meta,
                        },
                    );
                }
            }
        }
    }
    require(prepared.values().all(|file| file.proof.retained))?;
    require(references.len() == input.objects.len())?;
    for (object, (key, (_, size, digest))) in input.objects.iter().zip(&references) {
        require(
            object.object_key == *key
                && object.size_bytes == *size
                && object.size_bytes <= MAX_OBJECT
                && hex(&object.sha256, 64)
                && format!("sha256:{}", object.sha256) == *digest,
        )?;
    }
    Ok((prepared, by_object))
}

/// Object proof stage: read and verify each original object, reject trailing
/// bytes, and emit the inventory.
fn prove_objects(
    input: Input,
    (mut prepared, by_object): Closure,
    reader: &mut impl Read,
) -> Result<Vec<u8>> {
    // All decrypts, owners, original keys and opaque/native digest agreement
    // in `preflight` precede the FIRST recovered object read.
    for object in &input.objects {
        let length = usize::try_from(object.size_bytes).map_err(|_| bad())?;
        let mut body = Zeroizing::new(Vec::new());
        body.try_reserve_exact(length).map_err(|_| bad())?;
        body.resize(length, 0);
        reader.read_exact(&mut body).map_err(|_| bad())?;
        let ids = by_object.get(&object.object_key).ok_or_else(bad)?;
        let first = prepared.get(ids.first().ok_or_else(bad)?).ok_or_else(bad)?;
        super::verify_object(&first.meta, &body)?;
        let sha = first.meta.content_digest[7..].to_owned();
        // Preflight proved EVERY reference to this key has the exact same
        // owner/size/authenticated digest. Hash each object once, not per row.
        for id in ids {
            let file = prepared.get_mut(id).ok_or_else(bad)?;
            file.proof.ciphertext = Digest {
                size_bytes: object.size_bytes,
                sha256: sha.clone(),
            };
            file.proof.plaintext = Digest {
                size_bytes: object.size_bytes,
                sha256: sha.clone(),
            };
        }
    }
    let mut trailing = [0u8; 1];
    require(reader.read(&mut trailing).map_err(|_| bad())? == 0)?;
    let inventory = Inventory {
        schema: "mdbase-scoped-recovery-inventory/1",
        source_rows_sha256: input.source_rows_sha256,
        files: prepared.into_values().map(|file| file.proof).collect(),
    };
    serde_json::to_vec(&inventory).map_err(|_| bad())
}
