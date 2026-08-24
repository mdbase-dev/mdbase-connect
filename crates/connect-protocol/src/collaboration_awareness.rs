//! Strict ephemeral collaboration awareness wire types.
//!
//! Awareness is deliberately minimal and sanitized. Clients never relay
//! native Yjs awareness documents or arbitrary JSON: an awareness update
//! carries an empty frame payload plus exactly `{status, selections}` where
//! every selection is `{anchor, head}` bounded by the collaboration document
//! limit. The server is the only authority for presentation identity; it
//! broadcasts complete replacement snapshots of exactly
//! `{participants: [{name, color, status, selections}]}` derived from the
//! authenticated control-plane identity stored at replica registration.
//!
//! Everything here is process-local presentation state. Names, colors,
//! statuses, and selections never enter durable storage, outbox rows,
//! receipts, notifications, or logs, and never cross provider instances:
//! Hello advertises `scope: "provider_instance"` so no client can mistake
//! a room's membership for cross-instance completeness.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// Awareness contract version advertised in Hello.
pub const AWARENESS_PROTOCOL_VERSION: u32 = 1;
/// Awareness is visible only inside the provider instance that owns the
/// socket. It is never aggregated across instances.
pub const AWARENESS_SCOPE_PROVIDER_INSTANCE: &str = "provider_instance";
/// Maximum participants in one room's snapshot.
pub const MAX_AWARENESS_PARTICIPANTS: usize = 16;
/// Maximum selection ranges per participant per update.
pub const MAX_AWARENESS_SELECTIONS: usize = 4;
/// Maximum accepted awareness updates per second per session.
pub const MAX_AWARENESS_UPDATES_PER_SECOND: u32 = 8;
/// Minimum spacing between accepted awareness updates in milliseconds.
pub const MIN_AWARENESS_UPDATE_SPACING_MS: u64 = 125;
/// How long a participant stays visible without refreshing activity.
pub const AWARENESS_VISIBLE_TTL_SECONDS: u64 = 30;
pub const GENERIC_AWARENESS_NAME: &str = "Participant";
/// Display-name bounds enforced identically by the control plane, the
/// provider, and both wire codecs.
pub const MAX_AWARENESS_NAME_SCALARS: usize = 100;
pub const MAX_AWARENESS_NAME_BYTES: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwarenessValidationError {
    /// Metadata was not exactly the allowed shape (unknown, missing, deep,
    /// identity-bearing, textual, or path-bearing fields).
    Shape,
    /// More than [`MAX_AWARENESS_SELECTIONS`] ranges were supplied.
    TooManySelections,
    /// The same range appeared more than once.
    DuplicateSelection,
    /// An offset exceeded the collaboration document position bound.
    PositionOutOfRange,
    /// More than [`MAX_AWARENESS_PARTICIPANTS`] entries were supplied.
    TooManyParticipants,
    /// A participant display name failed the bounded NFC rules.
    InvalidName,
    /// An awareness frame carried a non-empty binary payload.
    PayloadNotEmpty,
}

/// Client-visible presence state. Nothing else is expressible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwarenessStatus {
    Active,
    Idle,
}

/// Fixed presentation palette. Colors are assigned by the server from the
/// authenticated control-plane user, never chosen by clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwarenessColor {
    Blue,
    Teal,
    Green,
    Amber,
    Orange,
    Rose,
    Violet,
    Slate,
}

impl AwarenessColor {
    pub const ALL: [AwarenessColor; 8] = [
        Self::Blue,
        Self::Teal,
        Self::Green,
        Self::Amber,
        Self::Orange,
        Self::Rose,
        Self::Violet,
        Self::Slate,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Teal => "teal",
            Self::Green => "green",
            Self::Amber => "amber",
            Self::Orange => "orange",
            Self::Rose => "rose",
            Self::Violet => "violet",
            Self::Slate => "slate",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|color| color.as_str() == value)
    }
}

/// One bounded selection range. Offsets are UTF-16 code units bounded by the
/// collaboration document limit at admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AwarenessSelectionRange {
    pub anchor: u32,
    pub head: u32,
}

/// The exact metadata a client may send in an Awareness frame. The frame
/// payload must be empty; unknown, deep, identity, text, or path fields are
/// rejected by [`Self::from_metadata`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientAwarenessUpdate {
    pub status: AwarenessStatus,
    pub selections: Vec<AwarenessSelectionRange>,
}

impl ClientAwarenessUpdate {
    /// Validate against the document position bound and the range ceilings.
    pub fn validate(&self, max_position: u32) -> Result<(), AwarenessValidationError> {
        if self.selections.len() > MAX_AWARENESS_SELECTIONS {
            return Err(AwarenessValidationError::TooManySelections);
        }
        for window in self.selections.windows(2) {
            if window[0] == window[1] {
                return Err(AwarenessValidationError::DuplicateSelection);
            }
        }
        let unique = self
            .selections
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if unique.len() != self.selections.len() {
            return Err(AwarenessValidationError::DuplicateSelection);
        }
        for selection in &self.selections {
            if selection.anchor > max_position || selection.head > max_position {
                return Err(AwarenessValidationError::PositionOutOfRange);
            }
        }
        Ok(())
    }

    /// Parse strictly from frame metadata. The metadata map must carry
    /// exactly `status` and `selections`.
    pub fn from_metadata(
        metadata: &serde_json::Map<String, Value>,
    ) -> Result<Self, AwarenessValidationError> {
        if metadata.len() != 2
            || !metadata.contains_key("status")
            || !metadata.contains_key("selections")
        {
            return Err(AwarenessValidationError::Shape);
        }
        let value = Value::Object(metadata.clone());
        serde_json::from_value(value).map_err(|_| AwarenessValidationError::Shape)
    }

    pub fn to_metadata(&self) -> serde_json::Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => unreachable!("awareness updates serialize to JSON objects"),
        }
    }
}

/// One sanitized participant entry in a server snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AwarenessParticipant {
    pub name: String,
    pub color: AwarenessColor,
    pub status: AwarenessStatus,
    pub selections: Vec<AwarenessSelectionRange>,
}

/// Complete replacement snapshot broadcast to every room member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerAwarenessSnapshot {
    pub participants: Vec<AwarenessParticipant>,
}

impl ServerAwarenessSnapshot {
    /// Validate participant bounds, names, and range limits. Snapshot sizes
    /// are additionally bounded by construction: sixteen participants with
    /// maximal names and ranges serialize far below the frame metadata limit.
    pub fn validate(&self, max_position: u32) -> Result<(), AwarenessValidationError> {
        if self.participants.len() > MAX_AWARENESS_PARTICIPANTS {
            return Err(AwarenessValidationError::TooManyParticipants);
        }
        for participant in &self.participants {
            validate_awareness_name(&participant.name)?;
            if participant.selections.len() > MAX_AWARENESS_SELECTIONS {
                return Err(AwarenessValidationError::TooManySelections);
            }
            let unique = participant
                .selections
                .iter()
                .collect::<std::collections::BTreeSet<_>>();
            if unique.len() != participant.selections.len() {
                return Err(AwarenessValidationError::DuplicateSelection);
            }
            for selection in &participant.selections {
                if selection.anchor > max_position || selection.head > max_position {
                    return Err(AwarenessValidationError::PositionOutOfRange);
                }
            }
        }
        Ok(())
    }

    pub fn from_metadata(
        metadata: &serde_json::Map<String, Value>,
    ) -> Result<Self, AwarenessValidationError> {
        if metadata.len() != 1 || !metadata.contains_key("participants") {
            return Err(AwarenessValidationError::Shape);
        }
        let value = Value::Object(metadata.clone());
        serde_json::from_value(value).map_err(|_| AwarenessValidationError::Shape)
    }

    pub fn to_metadata(&self) -> serde_json::Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => unreachable!("awareness snapshots serialize to JSON objects"),
        }
    }
}

/// Exact Hello advertisement so clients can never mistake process-local
/// presence for cross-instance completeness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AwarenessHelloAdvertisement {
    pub version: u32,
    pub scope: &'static str,
    pub max_participants: usize,
    pub max_selections: usize,
    pub max_updates_per_second: u32,
    pub ttl_seconds: u64,
}

impl AwarenessHelloAdvertisement {
    pub fn new() -> Self {
        Self::with_ttl(AWARENESS_VISIBLE_TTL_SECONDS)
    }

    pub fn with_ttl(ttl_seconds: u64) -> Self {
        Self {
            version: AWARENESS_PROTOCOL_VERSION,
            scope: AWARENESS_SCOPE_PROVIDER_INSTANCE,
            max_participants: MAX_AWARENESS_PARTICIPANTS,
            max_selections: MAX_AWARENESS_SELECTIONS,
            max_updates_per_second: MAX_AWARENESS_UPDATES_PER_SECOND,
            ttl_seconds,
        }
    }

    pub fn to_metadata(&self) -> serde_json::Map<String, Value> {
        let mut outer = serde_json::Map::new();
        outer.insert(
            "awareness".into(),
            serde_json::to_value(self).expect("advertisement serializes"),
        );
        outer
    }
}

impl Default for AwarenessHelloAdvertisement {
    fn default() -> Self {
        Self::new()
    }
}

/// Validate a server-assigned display name: non-empty, trimmed, NFC, free of
/// control characters and bidirectional overrides, and within both the
/// scalar and byte budgets.
pub fn validate_awareness_name(name: &str) -> Result<(), AwarenessValidationError> {
    if name.is_empty() || name.trim() != name {
        return Err(AwarenessValidationError::InvalidName);
    }
    if name.nfc().collect::<String>() != name {
        return Err(AwarenessValidationError::InvalidName);
    }
    if name.chars().count() > MAX_AWARENESS_NAME_SCALARS || name.len() > MAX_AWARENESS_NAME_BYTES {
        return Err(AwarenessValidationError::InvalidName);
    }
    if name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061C}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{2028}'..='\u{202E}'
                    | '\u{2060}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}'
            )
    }) {
        return Err(AwarenessValidationError::InvalidName);
    }
    Ok(())
}

/// Server-side presentation identity captured at replica registration. Never
/// client-supplied; the private experiment uses a generic non-PII name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplicaAwarenessIdentity {
    pub name: String,
    pub color: AwarenessColor,
}

impl ReplicaAwarenessIdentity {
    pub fn new(name: String, color: AwarenessColor) -> Result<Self, AwarenessValidationError> {
        validate_awareness_name(&name)?;
        Ok(Self { name, color })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(status: &str, selections: Value) -> serde_json::Map<String, Value> {
        json!({"status": status, "selections": selections})
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn client_update_round_trips_exactly() {
        let metadata = update("active", json!([{"anchor": 3, "head": 9}]));
        let parsed = ClientAwarenessUpdate::from_metadata(&metadata).unwrap();
        assert_eq!(
            parsed,
            ClientAwarenessUpdate {
                status: AwarenessStatus::Active,
                selections: vec![AwarenessSelectionRange { anchor: 3, head: 9 }],
            }
        );
        assert_eq!(parsed.to_metadata(), metadata);
        parsed.validate(4096).unwrap();
    }

    #[test]
    fn idle_without_selections_is_valid() {
        let parsed = ClientAwarenessUpdate::from_metadata(&update("idle", json!([]))).unwrap();
        assert_eq!(parsed.status, AwarenessStatus::Idle);
        parsed.validate(4096).unwrap();
    }

    #[test]
    fn client_update_rejects_identity_text_path_and_deep_fields() {
        for smuggled in [
            "name",
            "color",
            "user_id",
            "replica_id",
            "session_id",
            "account_id",
            "grant_id",
            "path",
            "text",
            "email",
            "timestamp",
            "record_id",
        ] {
            let mut metadata = update("active", json!([]));
            metadata.insert(smuggled.into(), json!("smuggled"));
            assert_eq!(
                ClientAwarenessUpdate::from_metadata(&metadata),
                Err(AwarenessValidationError::Shape),
                "{smuggled} was accepted"
            );
        }
        // Deep nesting inside a selection is equally rejected.
        let deep = update(
            "active",
            json!([{"anchor": 0, "head": 1, "extra": {"deeper": [1]}}]),
        );
        assert_eq!(
            ClientAwarenessUpdate::from_metadata(&deep),
            Err(AwarenessValidationError::Shape)
        );
    }

    #[test]
    fn client_update_rejects_shape_enum_and_number_violations() {
        // Unknown status value.
        assert_eq!(
            ClientAwarenessUpdate::from_metadata(&update("away", json!([]))),
            Err(AwarenessValidationError::Shape)
        );
        // Wrong types everywhere.
        for metadata in [
            update(1.to_string().as_str(), json!([])),
            json!({"status":"active","selections":{}})
                .as_object()
                .unwrap()
                .clone(),
            json!({"status":"active","selections":[{"anchor":"0","head":1}]})
                .as_object()
                .unwrap()
                .clone(),
            json!({"status":"active","selections":[{"anchor":0.5,"head":1}]})
                .as_object()
                .unwrap()
                .clone(),
            json!({"status":"active","selections":[[{"anchor":0,"head":1}]]})
                .as_object()
                .unwrap()
                .clone(),
            json!({"status":"active"}).as_object().unwrap().clone(),
            json!({"selections":[]}).as_object().unwrap().clone(),
        ] {
            assert_eq!(
                ClientAwarenessUpdate::from_metadata(&metadata),
                Err(AwarenessValidationError::Shape),
            );
        }
    }

    #[test]
    fn client_update_rejects_duplicate_excess_and_out_of_range_selections() {
        let duplicate = update(
            "active",
            json!([{"anchor": 4, "head": 8}, {"anchor": 4, "head": 8}]),
        );
        let parsed = ClientAwarenessUpdate::from_metadata(&duplicate).unwrap();
        assert_eq!(
            parsed.validate(1024),
            Err(AwarenessValidationError::DuplicateSelection)
        );

        let excess = update(
            "active",
            json!([
                {"anchor": 0, "head": 1},
                {"anchor": 2, "head": 3},
                {"anchor": 4, "head": 5},
                {"anchor": 6, "head": 7},
                {"anchor": 8, "head": 9}
            ]),
        );
        let parsed = ClientAwarenessUpdate::from_metadata(&excess).unwrap();
        assert_eq!(
            parsed.validate(1024),
            Err(AwarenessValidationError::TooManySelections)
        );

        let out_of_range = update("active", json!([{"anchor": 0, "head": 4097}]));
        let parsed = ClientAwarenessUpdate::from_metadata(&out_of_range).unwrap();
        assert_eq!(
            parsed.validate(4096),
            Err(AwarenessValidationError::PositionOutOfRange)
        );
    }

    #[test]
    fn snapshot_round_trips_and_allows_duplicate_names_and_colors() {
        let snapshot = ServerAwarenessSnapshot {
            participants: vec![
                AwarenessParticipant {
                    name: "Ada".into(),
                    color: AwarenessColor::Teal,
                    status: AwarenessStatus::Active,
                    selections: vec![AwarenessSelectionRange { anchor: 0, head: 4 }],
                },
                AwarenessParticipant {
                    name: "Ada".into(),
                    color: AwarenessColor::Teal,
                    status: AwarenessStatus::Idle,
                    selections: Vec::new(),
                },
            ],
        };
        snapshot.validate(4096).unwrap();
        let metadata = snapshot.to_metadata();
        assert_eq!(
            ServerAwarenessSnapshot::from_metadata(&metadata).unwrap(),
            snapshot
        );
    }

    #[test]
    fn snapshot_rejects_excess_participants_invalid_names_and_positions() {
        let participants = (0..MAX_AWARENESS_PARTICIPANTS + 1)
            .map(|index| AwarenessParticipant {
                name: format!("P{index}"),
                color: AwarenessColor::Blue,
                status: AwarenessStatus::Active,
                selections: Vec::new(),
            })
            .collect::<Vec<_>>();
        let snapshot = ServerAwarenessSnapshot { participants };
        assert_eq!(
            snapshot.validate(1024),
            Err(AwarenessValidationError::TooManyParticipants)
        );

        let invalid_names = [
            "",
            " padded",
            "padded ",
            "a\u{7}",
            "a\u{061C}b",
            "a\u{200B}b",
            "a\u{200E}b",
            "a\u{2028}b",
            "a\u{202E}b",
            "a\u{2060}b",
            "a\u{2066}b",
            "a\u{FEFF}b",
        ];
        for name in invalid_names {
            assert_eq!(
                validate_awareness_name(name),
                Err(AwarenessValidationError::InvalidName),
                "{name:?} accepted"
            );
        }
        // Non-NFC decomposed form.
        assert_eq!(
            validate_awareness_name("e\u{301}"),
            Err(AwarenessValidationError::InvalidName)
        );
        assert_eq!(
            validate_awareness_name(&"x".repeat(MAX_AWARENESS_NAME_SCALARS + 1)),
            Err(AwarenessValidationError::InvalidName)
        );

        let snapshot = ServerAwarenessSnapshot {
            participants: vec![AwarenessParticipant {
                name: "Ada".into(),
                color: AwarenessColor::Slate,
                status: AwarenessStatus::Active,
                selections: vec![AwarenessSelectionRange {
                    anchor: 1 << 30,
                    head: 0,
                }],
            }],
        };
        assert_eq!(
            snapshot.validate(1024),
            Err(AwarenessValidationError::PositionOutOfRange)
        );
    }

    #[test]
    fn maximal_snapshot_stays_well_below_the_metadata_limit() {
        let longest_name = "\u{4e3b}".repeat(MAX_AWARENESS_NAME_SCALARS);
        assert_eq!(longest_name.len(), MAX_AWARENESS_NAME_SCALARS * 3);
        let selections = vec![
            AwarenessSelectionRange {
                anchor: u32::MAX / 2,
                head: u32::MAX - 1,
            },
            AwarenessSelectionRange { anchor: 0, head: 1 },
            AwarenessSelectionRange { anchor: 2, head: 3 },
            AwarenessSelectionRange { anchor: 4, head: 5 },
        ];
        let snapshot = ServerAwarenessSnapshot {
            participants: (0..MAX_AWARENESS_PARTICIPANTS)
                .map(|_| AwarenessParticipant {
                    name: longest_name.clone(),
                    color: AwarenessColor::Violet,
                    status: AwarenessStatus::Active,
                    selections: selections.clone(),
                })
                .collect(),
        };
        snapshot.validate(u32::MAX).unwrap();
        let encoded = serde_json::to_vec(&snapshot.to_metadata()).unwrap();
        assert!(encoded.len() < crate::MAX_COLLABORATION_METADATA_BYTES);
    }

    #[test]
    fn hello_advertisement_is_exact_and_provider_instance_scoped() {
        let advertisement = AwarenessHelloAdvertisement::new();
        let value = serde_json::to_value(advertisement).unwrap();
        assert_eq!(
            value,
            json!({
                "version": 1,
                "scope": "provider_instance",
                "max_participants": 16,
                "max_selections": 4,
                "max_updates_per_second": 8,
                "ttl_seconds": 30
            })
        );
    }

    #[test]
    fn colors_round_trip_through_the_fixed_palette() {
        for color in AwarenessColor::ALL {
            assert_eq!(AwarenessColor::parse(color.as_str()), Some(color));
            let value = serde_json::to_value(color).unwrap();
            assert_eq!(value.as_str().and_then(AwarenessColor::parse), Some(color));
        }
        assert_eq!(AwarenessColor::parse("crimson"), None);
        assert_eq!(AwarenessColor::parse(""), None);
    }

    /// Shared Rust/TypeScript fixture parity. The fixture frames were encoded
    /// with canonical JSON metadata; both implementations must decode and
    /// re-encode them byte-for-byte.
    #[test]
    fn shared_awareness_fixture_matches_rust_encoding_exactly() {
        use crate::{CollaborationFrame, CollaborationMessageKind};
        use sha2::{Digest, Sha256};

        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/collaboration-awareness-v1.json"
        ))
        .unwrap();

        for case in ["client_update", "server_snapshot"] {
            let case_fixture = &fixture[case];
            let frame_hex = case_fixture["frame_hex"].as_str().unwrap();
            let bytes = hex_decode(frame_hex);
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                case_fixture["frame_sha256"].as_str().unwrap(),
                "{case} digest mismatch"
            );
            let frame = CollaborationFrame::decode(&bytes).unwrap();
            assert_eq!(frame.kind, CollaborationMessageKind::Awareness);
            assert!(frame.payload.is_empty());
            if case == "client_update" {
                let parsed = ClientAwarenessUpdate::from_metadata(&frame.metadata).unwrap();
                assert_eq!(parsed.status, AwarenessStatus::Active);
                assert_eq!(parsed.selections.len(), 1);
                let rebuilt = CollaborationFrame {
                    kind: CollaborationMessageKind::Awareness,
                    metadata: parsed.to_metadata(),
                    payload: Vec::new(),
                };
                assert_eq!(
                    rebuilt.encode().unwrap(),
                    bytes,
                    "{case} re-encode diverged"
                );
            } else {
                let parsed = ServerAwarenessSnapshot::from_metadata(&frame.metadata).unwrap();
                parsed.validate(4096).unwrap();
                let rebuilt = CollaborationFrame {
                    kind: CollaborationMessageKind::Awareness,
                    metadata: parsed.to_metadata(),
                    payload: Vec::new(),
                };
                assert_eq!(
                    rebuilt.encode().unwrap(),
                    bytes,
                    "{case} re-encode diverged"
                );
            }
        }
    }

    fn hex_decode(value: &str) -> Vec<u8> {
        (0..value.len() / 2)
            .map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap())
            .collect()
    }
}
