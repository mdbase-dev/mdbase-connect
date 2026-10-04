//! The folder role marker at `.mdbase/connect-role.json`.
//!
//! Version 1 marks a hosted mirror folder (`{"version":1,"role":"mirror",
//! "collection_id":…}`). A newer runtime claims a folder by writing a marker
//! with a higher integer version; Connect must then stop using the folder and
//! must not remove that marker.
use serde_json::Value;
use uuid::Uuid;

/// Marker path relative to a collection or mirror root.
pub const ROLE_MARKER_PATH: &str = ".mdbase/connect-role.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoleMarker {
    /// A version 1 hosted mirror marker.
    Mirror { collection_id: Uuid },
    /// A newer runtime owns the folder; `runtime` is informational only.
    ClaimedByNewerRuntime { runtime: Option<String> },
    /// Valid JSON that is neither a mirror marker nor a newer claim.
    Unrecognized,
    /// Not a JSON object.
    Malformed,
}

impl RoleMarker {
    pub fn classify(bytes: &[u8]) -> Self {
        let Ok(Value::Object(marker)) = serde_json::from_slice::<Value>(bytes) else {
            return Self::Malformed;
        };
        match marker.get("version").and_then(Value::as_u64) {
            Some(1) => match (
                marker.get("role").and_then(Value::as_str),
                marker
                    .get("collection_id")
                    .and_then(Value::as_str)
                    .and_then(|value| Uuid::parse_str(value).ok()),
            ) {
                (Some("mirror"), Some(collection_id)) => Self::Mirror { collection_id },
                _ => Self::Unrecognized,
            },
            Some(version) if version >= 2 => Self::ClaimedByNewerRuntime {
                runtime: marker
                    .get("runtime")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            _ => Self::Unrecognized,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_v2_claim_fixture_as_a_newer_runtime() {
        let fixture = include_bytes!("../../../test-fixtures/role-marker-v2-claim.json");
        assert_eq!(
            RoleMarker::classify(fixture),
            RoleMarker::ClaimedByNewerRuntime {
                runtime: Some("mdbase-next".into())
            }
        );
    }

    #[test]
    fn classifies_mirror_and_invalid_markers() {
        let id = Uuid::new_v4();
        assert_eq!(
            RoleMarker::classify(
                format!(r#"{{"version":1,"role":"mirror","collection_id":"{id}"}}"#).as_bytes()
            ),
            RoleMarker::Mirror { collection_id: id }
        );
        for unrecognized in [
            r#"{"version":1,"role":"replica","collection_id":"not-a-uuid"}"#,
            r#"{"version":1,"role":"mirror"}"#,
            r#"{"version":"2","role":"replica"}"#,
            r#"{"version":0}"#,
            r#"{}"#,
        ] {
            assert_eq!(
                RoleMarker::classify(unrecognized.as_bytes()),
                RoleMarker::Unrecognized,
                "{unrecognized}"
            );
        }
        for malformed in ["", "{broken", "[]", "2"] {
            assert_eq!(
                RoleMarker::classify(malformed.as_bytes()),
                RoleMarker::Malformed,
                "{malformed}"
            );
        }
        assert_eq!(
            RoleMarker::classify(br#"{"version":300}"#),
            RoleMarker::ClaimedByNewerRuntime { runtime: None }
        );
    }
}
