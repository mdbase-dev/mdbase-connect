use mdbase::v03::OperationResult;
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
    pub envelope: OperationResult,
    pub primary_record_id: Uuid,
    pub changed: Vec<(Uuid, Option<SyncRecord>, Option<String>)>,
}
