//! Strict paired-device cutover metadata transport with an exact eight-field body.
//! A transport record is NOT verified installation, policy, keys, or admission.
//! There is no mirror-join runtime caller. The future driver must recheck the
//! full current account/capture/head/holder/generation at serialized consumption.

use super::{Cloud, CloudError};
use serde::Deserialize;
use std::sync::Arc;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

/// Complete metadata from one authenticated/current strict200 read. Not a proof
/// or permission cache; only Cloud can construct it outside the hermetic tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRecord {
    collection_id: [u8; 16],
    legacy_collection_id: [u8; 16],
    s_final: u64,
    cutover_seq: u64,
    barrier_f: u64,
    final_digest: [u8; 32],
    cutover_at: OffsetDateTime,
}
impl MigrationRecord {
    /// Exactly the requested Next collection identity.
    pub fn collection_id(&self) -> [u8; 16] {
        self.collection_id
    }
    /// Exactly the expected captured legacy identity.
    pub fn legacy_collection_id(&self) -> [u8; 16] {
        self.legacy_collection_id
    }
    /// Legacy drained sequence; not in the Next log sequence domain.
    pub fn s_final(&self) -> u64 {
        self.s_final
    }
    /// Next cutover position C; not an installed-head claim.
    pub fn cutover_seq(&self) -> u64 {
        self.cutover_seq
    }
    /// Next barrier F, with C<=F; actual C..F verification remains required.
    pub fn barrier_f(&self) -> u64 {
        self.barrier_f
    }
    /// Canonical drained legacy-state digest, not a disk-known hash.
    pub fn final_digest(&self) -> [u8; 32] {
        self.final_digest
    }
    /// UTC metadata time, never a permission TTL.
    pub fn cutover_at(&self) -> OffsetDateTime {
        self.cutover_at
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRecord {
    collection_id: String,
    legacy_collection_id: String,
    ids_preserved: bool,
    s_final: String,
    cutover_seq: String,
    barrier_f: String,
    final_digest: String,
    cutover_at: String,
}

// Pure byte grammar, separate from decoding so its complete byte classes can
// be tested without passing malformed strings to any legacy helper.
fn canonical_id_shape(value: &[u8]) -> bool {
    value.len() == 36
        && value.iter().enumerate().all(|(at, &byte)| {
            if matches!(at, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
fn canonical_id(value: &str) -> Option<[u8; 16]> {
    // Validate bytes BEFORE the legacy decoder, which assumes ASCII byte
    // boundaries. Accept only the exact lowercase, hyphenated wire spelling.
    if !canonical_id_shape(value.as_bytes()) {
        return None;
    }
    let id = crate::attest::uuid_bytes(value)?;
    (id != [0; 16] && crate::secrets::uuid_string(&id) == value).then_some(id)
}
fn sequence(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}
fn malformed() -> CloudError {
    CloudError::Server(200, "invalid_migration_record".into())
}
fn parse(
    bytes: &[u8],
    expected: [u8; 16],
    legacy: [u8; 16],
) -> Result<MigrationRecord, CloudError> {
    // Direct struct decode rejects duplicate AND extra/missing fields, unlike a
    // prior Value projection. Numbers/bools/nulls cannot coerce to strings.
    let raw: RawRecord = serde_json::from_slice(bytes).map_err(|_| malformed())?;
    let collection_id = canonical_id(&raw.collection_id).ok_or_else(malformed)?;
    let legacy_collection_id = canonical_id(&raw.legacy_collection_id).ok_or_else(malformed)?;
    if collection_id != expected
        || legacy_collection_id != legacy
        || collection_id != legacy_collection_id
        || !raw.ids_preserved
    {
        return Err(malformed());
    }
    let s_final = sequence(&raw.s_final).ok_or_else(malformed)?;
    let cutover_seq = sequence(&raw.cutover_seq).ok_or_else(malformed)?;
    let barrier_f = sequence(&raw.barrier_f).ok_or_else(malformed)?;
    if cutover_seq > barrier_f
        || raw.final_digest.len() != 64
        || !raw
            .final_digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(malformed());
    }
    let final_digest = crate::secrets::hex_decode(&raw.final_digest)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(malformed)?;
    if raw.cutover_at.len() > 64 {
        return Err(malformed());
    }
    let cutover_at = OffsetDateTime::parse(&raw.cutover_at, &Rfc3339).map_err(|_| malformed())?;
    if cutover_at.offset() != UtcOffset::UTC {
        return Err(malformed());
    }
    Ok(MigrationRecord {
        collection_id,
        legacy_collection_id,
        s_final,
        cutover_seq,
        barrier_f,
        final_digest,
        cutover_at,
    })
}

impl Cloud {
    /// Fetch ONLY the agreed metadata record. Caller supplies a fresh current
    /// native pairing/account-backend/capture guard, checked before send and
    /// after every await and decode. All errors leave join pending; no fallback,
    /// key/grant activation, known-hash seeding, or release exists in this API.
    pub async fn migration_record(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        collection_id: &str,
        legacy_collection_id: &str,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<MigrationRecord, CloudError> {
        let expected = canonical_id(collection_id)
            .ok_or_else(|| CloudError::Local("invalid_collection_identity".into()))?;
        let legacy = canonical_id(legacy_collection_id)
            .ok_or_else(|| CloudError::Local("invalid_legacy_identity".into()))?;
        if expected != legacy {
            return Err(CloudError::Local("migration_identity_not_preserved".into()));
        }
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((**tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let request = client
            .get(format!(
                "{}/v1/next/collections/{collection_id}/migration-record",
                self.server
            ))
            .bearer_auth(self.token.as_str())
            .header(reqwest::header::CACHE_CONTROL, "no-cache, no-store");
        let (_, bytes) = self
            .send_current_raw_status(request, current, Some(200))
            .await?;
        let record = parse(&bytes, expected, legacy)?;
        current().map_err(CloudError::Local)?;
        Ok(record)
    }
}

#[cfg(test)]
#[path = "cloud_migration_record_tests.rs"]
mod tests;
