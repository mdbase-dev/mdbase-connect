use mdbase::{runtime::CanonicalOperationOutcome, v03::OperationResult};
use mdbase_connect_protocol::SyncRecord;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct StoredDocument {
    pub record_id: Uuid,
    pub path: String,
    pub document: String,
}

#[derive(Debug)]
pub struct Execution {
    /// Canonical semantic outcome retained by hosted execution. Legacy
    /// workspace fixtures and replication-only writes have no typed outcome.
    pub operation: Option<CanonicalOperationOutcome>,
    /// Compatibility envelope retained only for the durable v0.3 edge.
    pub envelope: OperationResult,
    pub primary_record_id: Uuid,
    pub changed: Vec<(Uuid, Option<SyncRecord>, Option<String>)>,
}
