use super::*;

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
