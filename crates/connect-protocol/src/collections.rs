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
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
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
    pub error: Option<ControlError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub record_id: Uuid,
    pub path: String,
    pub revision: String,
    pub frontmatter: serde_json::Map<String, Value>,
    pub body: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritySnapshotRecord {
    pub record: SyncRecord,
    pub document: String,
}

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
            ("record", record.record.path.as_str()),
            (
                record.record.record_id.to_string(),
                hex_digest(&Sha256::digest(record.document.as_bytes())),
            ),
        );
    }
    let mut manifest = Sha256::new();
    manifest.update(b"mdbase-authority-manifest-v1\n");
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

fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
