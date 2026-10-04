use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionSummary {
    pub id: Uuid,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub path: String,
    pub spec_version: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_transfer: Option<CollectionAuthorityTransfer>,
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
    /// Why a registered collection cannot be served, when that is not the
    /// user's own pause. Older readers ignore it and see `enabled: false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<CollectionUnavailableReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionUnavailableReason {
    /// A newer mdbase runtime claimed the folder with its role marker.
    ClaimedByNewerRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionAuthorityTransfer {
    pub transfer_id: Uuid,
    pub state: CollectionAuthorityTransferState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionAuthorityTransferState {
    Fenced,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionTypeDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Digest of the exact type source used as an approval-time precondition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<Value>,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Value>,
    pub extensions: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionContractDescriptor {
    pub contract_type: String,
    pub id: String,
    pub version: String,
    pub digest: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_schema: Option<Value>,
    pub implementations: Vec<CollectionContractImplementationDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionContractImplementationDescriptor {
    pub type_name: String,
    pub type_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_path: Option<String>,
    pub digest: String,
    pub fields: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionDescription {
    /// Authority-local implementation features, not permissions. None means legacy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_capabilities: Option<Vec<String>>,
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub display_name: String,
    pub spec_version: String,
    pub operations: Vec<String>,
    pub change_cursor: u64,
    pub types: Vec<CollectionTypeDescriptor>,
    pub contracts: Vec<CollectionContractDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionChange {
    pub cursor: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionChangesPage {
    pub events: Vec<CollectionChange>,
    pub cursor: u64,
    pub has_more: bool,
    pub reset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationRequest {
    pub protocol_version: u32,
    pub request_id: Uuid,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResponse {
    pub protocol_version: u32,
    pub request_id: Uuid,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<ConnectProblem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub record_id: Uuid,
    pub path: String,
    /// Exact authoritative Markdown document. `revision` is its SHA-256 digest.
    pub document: String,
    pub revision: String,
    /// Derived query projection; never a materialization source.
    pub frontmatter: serde_json::Map<String, Value>,
    /// Derived query projection; never a materialization source.
    pub body: String,
    /// Derived authority projection used for scope checks.
    pub types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCollectionResources {
    pub revision: String,
    pub spec_version: String,
    pub types: Vec<CollectionTypeDescriptor>,
    pub contracts: Vec<CollectionContractDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub documents: Vec<SyncResourceDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResourceDocument {
    pub path: String,
    pub kind: String,
    /// SHA-256 revision of the exact UTF-8 document.
    pub revision: String,
    pub document: String,
}

pub type AuthoritySnapshotRecord = SyncRecord;

/// Complete provider-neutral materialization used to seed a new authority.
///
/// Transfer orchestration pages this value on the wire, but source and target
/// both use this canonical representation and manifest digest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritySnapshot {
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub source_head: u64,
    pub source_revision: String,
    pub manifest_digest: String,
    pub resources: SyncCollectionResources,
    pub records: Vec<AuthoritySnapshotRecord>,
    #[serde(default)]
    pub files: Vec<CollectionFileDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportManifest {
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub source_head: u64,
    pub source_revision: String,
    pub manifest_digest: String,
    pub resources: SyncCollectionResources,
    pub record_count: u64,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub files: Vec<CollectionFileDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportRecord {
    pub record_id: Uuid,
    pub path: String,
    pub document: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportRecordPage {
    pub protocol_version: u32,
    pub page: u64,
    pub records: Vec<AuthorityImportRecord>,
}

pub fn authority_manifest_digest(
    resources: &[SyncResourceDocument],
    records: &[AuthoritySnapshotRecord],
    files: &[CollectionFileDescriptor],
) -> String {
    let mut entries = BTreeMap::<(&str, &str), (String, String)>::new();
    for resource in resources {
        entries.insert(
            ("resource", resource.path.as_str()),
            (
                String::new(),
                hex_digest(&Sha256::digest(resource.document.as_bytes())),
            ),
        );
    }
    for record in records {
        entries.insert(
            ("record", record.path.as_str()),
            (
                record.record_id.to_string(),
                hex_digest(&Sha256::digest(record.document.as_bytes())),
            ),
        );
    }
    for file in files {
        entries.insert(
            ("file", file.path.as_str()),
            (file.file_id.to_string(), authority_file_hash(file)),
        );
    }
    let mut manifest = Sha256::new();
    manifest.update(b"mdbase-authority-manifest-v2\n");
    for ((kind, path), (identity, document_hash)) in entries {
        manifest.update(kind.as_bytes());
        manifest.update(b"\0");
        manifest.update(path.as_bytes());
        manifest.update(b"\0");
        manifest.update(identity.as_bytes());
        manifest.update(b"\0");
        manifest.update(document_hash.as_bytes());
        manifest.update(b"\n");
    }
    hex_digest(&manifest.finalize())
}

pub fn authority_file_hash(file: &CollectionFileDescriptor) -> String {
    let media_class = match file.media_class {
        FileMediaClass::Image => "image",
        FileMediaClass::Audio => "audio",
        FileMediaClass::Video => "video",
        FileMediaClass::Pdf => "pdf",
        FileMediaClass::Other => "other",
    };
    let mut hash = Sha256::new();
    hash.update(b"mdbase-authority-file-v1\0");
    hash.update(file.content_digest.as_bytes());
    hash.update(b"\0");
    hash.update(file.size.to_string().as_bytes());
    hash.update(b"\0");
    hash.update(file.media_type.as_deref().unwrap_or_default().as_bytes());
    hash.update(b"\0");
    hash.update(media_class.as_bytes());
    hash.update(b"\0");
    hex_digest(&hash.finalize())
}

fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub const MAX_READ_MANY_PATHS: usize = 100;
/// Serialized batch operation envelope ceiling; overflow fails and asks callers to split.
pub const MAX_READ_MANY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

// Missing members use serde default; present null is invalid, not absence.
pub(crate) fn present_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataContractSelector {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "ReadInputWire")]
pub struct ReadInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_body: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_document: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<DataContractSelector>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInputWire {
    #[serde(default, deserialize_with = "present_value")]
    path: Option<String>,
    #[serde(default, deserialize_with = "present_value")]
    paths: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present_value")]
    include_body: Option<bool>,
    #[serde(default, deserialize_with = "present_value")]
    include_document: Option<bool>,
    #[serde(default, deserialize_with = "present_value")]
    contract: Option<DataContractSelector>,
}

impl TryFrom<ReadInputWire> for ReadInput {
    type Error = &'static str;

    fn try_from(wire: ReadInputWire) -> Result<Self, Self::Error> {
        if wire.path.is_some() == wire.paths.is_some() {
            return Err("read requires exactly one of path or paths");
        }
        if wire.path.as_ref().is_some_and(String::is_empty)
            || wire.paths.as_ref().is_some_and(|paths| {
                paths.is_empty()
                    || paths.len() > MAX_READ_MANY_PATHS
                    || paths.iter().any(String::is_empty)
            })
        {
            return Err("read paths must be nonempty (batch maximum 100)");
        }
        if wire.contract.is_some() && wire.include_document == Some(true) {
            return Err("contract projections cannot include exact documents");
        }
        // Contract batch support is qualified separately by B5, not inferred here.
        Ok(Self {
            path: wire.path,
            paths: wire.paths,
            include_body: wire.include_body,
            include_document: wire.include_document,
            contract: wire.contract,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordDocument {
    pub path: String,
    pub revision: String,
    pub types: Vec<String>,
    pub frontmatter: serde_json::Map<String, Value>,
    pub effective_frontmatter: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<String>,
    pub file: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadManyDocumentItem {
    Found {
        path: String,
        record: RecordDocument,
    },
    Missing {
        path: String,
    },
    Error {
        path: String,
        error: ReadManyDocumentError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadManyDocumentError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadManyDocumentsResult {
    pub items: Vec<ReadManyDocumentItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryRecord {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    pub types: Vec<String>,
    pub file: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_frontmatter: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryMetadataRecord {
    pub path: String,
    pub types: Vec<String>,
    pub revision: String,
    pub values: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryMetadataOutput {
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryMetadataResult {
    pub output: QueryMetadataOutput,
    pub results: Vec<QueryMetadataRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Map<String, Value>>,
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
