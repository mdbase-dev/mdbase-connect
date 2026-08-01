use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

fn header(kind: RelayFileKind) -> RelayFileHeader {
    RelayFileHeader {
        protocol_version: RELAY_FILE_PROTOCOL_VERSION,
        message_type: kind,
        request_id: Uuid::parse_str("01955555-5555-7555-8555-555555555555").unwrap(),
        grant_id: Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
        transfer_id: Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
        chunk_index: 3,
    }
}

#[test]
fn relay_file_frames_round_trip_opaque_binary_payloads() {
    let frame = RelayFileFrame {
        kind: RelayFileKind::UploadChunk,
        header: header(RelayFileKind::UploadChunk),
        payload: vec![0, 1, 2, 255],
    };
    let encoded = frame.encode().unwrap();
    assert_eq!(&encoded[..4], b"MDBR");
    assert_eq!(RelayFileFrame::decode(&encoded).unwrap(), frame);

    let request = RelayFileFrame {
        kind: RelayFileKind::DownloadRequest,
        header: header(RelayFileKind::DownloadRequest),
        payload: Vec::new(),
    };
    assert_eq!(
        RelayFileFrame::decode(&request.encode().unwrap()).unwrap(),
        request
    );
}

#[test]
fn relay_file_v1_matches_the_shared_typescript_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/test/fixtures/relay-file-v1.json"
    ))
    .unwrap();
    let frame = RelayFileFrame {
        kind: RelayFileKind::UploadChunk,
        header: serde_json::from_value(fixture["header"].clone()).unwrap(),
        payload: BASE64
            .decode(fixture["payload_base64"].as_str().unwrap())
            .unwrap(),
    };
    let encoded = frame.encode().unwrap();
    assert_eq!(
        BASE64.encode(encoded),
        fixture["frame_base64"].as_str().unwrap()
    );
}

#[test]
fn relay_file_frames_reject_malformed_or_ambiguous_messages() {
    let frame = RelayFileFrame {
        kind: RelayFileKind::UploadAcknowledged,
        header: header(RelayFileKind::UploadAcknowledged),
        payload: Vec::new(),
    };
    let encoded = frame.encode().unwrap();
    assert_eq!(
        RelayFileFrame::decode(&encoded[..encoded.len() - 1]),
        Err(RelayFileFrameError::LengthMismatch)
    );
    let mut invalid_kind = encoded.clone();
    invalid_kind[5] = 99;
    assert_eq!(
        RelayFileFrame::decode(&invalid_kind),
        Err(RelayFileFrameError::InvalidKind(99))
    );
    assert_eq!(
        RelayFileFrame {
            kind: RelayFileKind::Rejected,
            header: frame.header.clone(),
            payload: Vec::new(),
        }
        .encode(),
        Err(RelayFileFrameError::KindMismatch)
    );
    assert_eq!(
        RelayFileFrame {
            kind: RelayFileKind::UploadAcknowledged,
            header: frame.header,
            payload: vec![1],
        }
        .encode(),
        Err(RelayFileFrameError::PayloadMismatch)
    );
}
