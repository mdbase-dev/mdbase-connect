use super::*;

#[test]
fn upload_identity_is_an_optional_additive_field() {
    let old = OpenUploadResult {
        transfer: B16([1; 16]),
        chunk_size: 512 * 1024,
        received: vec![0, 1],
        expires_at: 12_000,
        file_id: None,
    };
    let legacy_bytes = old.to_bytes().unwrap();
    let decoded = OpenUploadResult::from_bytes(&legacy_bytes).unwrap();
    assert_eq!(decoded, old);
    let Cbor::Map(fields) = old.to_cbor() else {
        panic!("upload response must be a map");
    };
    assert_eq!(fields.len(), 4);

    let file = B16([2; 16]);
    let current = OpenUploadResult {
        file_id: Some(file),
        ..old.clone()
    };
    let decoded = OpenUploadResult::from_bytes(&current.to_bytes().unwrap()).unwrap();
    assert_eq!(decoded.file_id, Some(file));
    assert_ne!(decoded.file_id, Some(decoded.transfer));
    let Cbor::Map(fields) = current.to_cbor() else {
        panic!("upload response must be a map");
    };
    assert_eq!(fields.len(), 5);
    assert!(fields.contains(&(Cbor::Uint(4), file.to_cbor())));
    assert_eq!(
        OpenUploadResult {
            file_id: None,
            ..decoded
        }
        .to_bytes()
        .unwrap(),
        legacy_bytes
    );
}
