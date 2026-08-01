use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/protocol/test/fixtures/file-frame-v1.json"
    ))
    .unwrap()
}

fn sample_frame() -> FileFrame {
    let fixture = fixture();
    FileFrame {
        kind: FileFrameKind::UploadChunk,
        header: serde_json::from_value(fixture["header"].clone()).unwrap(),
        payload: BASE64
            .decode(fixture["payload_base64"].as_str().unwrap())
            .unwrap(),
    }
}

fn raw_frame(header: &str, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&FILE_FRAME_MAGIC);
    bytes.push(FILE_FRAME_VERSION);
    bytes.push(FileFrameKind::UploadChunk.code());
    bytes.extend_from_slice(&FILE_FRAME_FLAGS.to_be_bytes());
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(header.as_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

#[test]
fn file_frame_v1_matches_the_shared_typescript_fixture() {
    let fixture = fixture();
    let frame = sample_frame();
    let encoded = frame.encode().unwrap();
    assert_eq!(
        BASE64.encode(&encoded),
        fixture["frame_base64"].as_str().unwrap()
    );
    let decoded = FileFrame::decode(&encoded).unwrap();
    assert_eq!(decoded, frame);
}

#[test]
fn frame_decoder_rejects_malformed_prefixes_and_lengths() {
    assert_eq!(
        FileFrame::decode(&[0; FILE_FRAME_PREFIX_BYTES - 1]),
        Err(FileFrameError::TooShort)
    );
    let encoded = sample_frame().encode().unwrap();

    let mut bad_magic = encoded.clone();
    bad_magic[0] = 0;
    assert_eq!(
        FileFrame::decode(&bad_magic),
        Err(FileFrameError::InvalidMagic)
    );
    let mut bad_version = encoded.clone();
    bad_version[4] = 2;
    assert_eq!(
        FileFrame::decode(&bad_version),
        Err(FileFrameError::UnsupportedVersion(2))
    );
    let mut bad_kind = encoded.clone();
    bad_kind[5] = 99;
    assert_eq!(
        FileFrame::decode(&bad_kind),
        Err(FileFrameError::InvalidKind(99))
    );
    let mut bad_flags = encoded.clone();
    bad_flags[7] = 1;
    assert_eq!(
        FileFrame::decode(&bad_flags),
        Err(FileFrameError::UnsupportedFlags(1))
    );
    assert_eq!(
        FileFrame::decode(&encoded[..encoded.len() - 1]),
        Err(FileFrameError::LengthMismatch)
    );
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert_eq!(
        FileFrame::decode(&trailing),
        Err(FileFrameError::LengthMismatch)
    );

    let mut huge_header = encoded;
    huge_header[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(
        FileFrame::decode(&huge_header),
        Err(FileFrameError::LimitExceeded)
    );
}

#[test]
fn frame_decoder_rejects_noncanonical_or_ambiguous_headers() {
    let frame = sample_frame();
    let canonical = serde_json::to_string(&frame.header).unwrap();
    assert_eq!(
        FileFrame::decode(&raw_frame(&format!(" {canonical}"), &frame.payload)),
        Err(FileFrameError::NonCanonicalHeader)
    );
    let duplicate = canonical.replace("\"scope_epoch\":7", "\"scope_epoch\":7,\"scope_epoch\":7");
    assert!(matches!(
        FileFrame::decode(&raw_frame(&duplicate, &frame.payload)),
        Err(FileFrameError::InvalidHeader(_))
    ));
    let unknown = canonical.replace("\"scope_epoch\":7", "\"scope_epoch\":7,\"future\":true");
    assert!(matches!(
        FileFrame::decode(&raw_frame(&unknown, &frame.payload)),
        Err(FileFrameError::InvalidHeader(_))
    ));
}

#[test]
fn frame_semantics_bind_kind_offsets_bounds_and_protection() {
    let mut frame = sample_frame();
    frame.kind = FileFrameKind::DownloadChunk;
    assert_eq!(frame.encode(), Err(FileFrameError::DirectionMismatch));

    let mut frame = sample_frame();
    frame.header.offset = 1;
    assert_eq!(frame.encode(), Err(FileFrameError::OffsetMismatch));

    let mut frame = sample_frame();
    frame.header.total_size = 31;
    assert_eq!(frame.encode(), Err(FileFrameError::TransferBounds));

    let mut frame = sample_frame();
    frame.header.protection = FileTransferProtection::GrantAeadV1;
    frame.header.key_id = Some("grant-key-3".to_string());
    assert_eq!(frame.encode(), Err(FileFrameError::PayloadLengthMismatch));
    frame.payload.extend_from_slice(&[0; AEAD_TAG_BYTES]);
    assert!(frame.encode().is_ok());
}
