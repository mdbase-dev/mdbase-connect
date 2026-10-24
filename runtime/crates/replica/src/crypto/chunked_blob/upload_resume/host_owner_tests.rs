use super::tests::{Salt, metadata};
use super::*;

fn host() -> UploadResumeOwner {
    UploadResumeOwner::HostV2 {
        device: B16([13; 16]),
        account: B16([5; 16]),
        transfer: B16([6; 16]),
    }
}
fn refused(key: &Secret32, reference: &UploadResumeRefV1, owner: UploadResumeOwner, bytes: &[u8]) {
    let mut region = vec![0xce; MAX_SEALED];
    region[..bytes.len()].copy_from_slice(bytes);
    assert!(open_resume_metadata(key, reference, owner, &mut region).is_err());
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn grant_v1_plaintext_binding_and_complete_ciphertext_are_byte_identical() {
    let key = Secret32([10; 32]);
    let m = metadata(123);
    // Independently assemble the pre-Host format, without the new owner encoder.
    let old_binding = vec![
        Cbor::Uint(1),
        Cbor::Bytes(vec![1; 16]),
        Cbor::Uint(7),
        Cbor::Bytes(vec![2; 32]),
        Cbor::Uint(u64::from(CHUNK_BYTES)),
        Cbor::Bytes(vec![3; 16]),
        Cbor::Bytes(vec![4; 32]),
        Cbor::Bytes(vec![5; 16]),
        Cbor::Bytes(vec![6; 16]),
    ];
    let mut old_fields = old_binding.clone();
    old_fields.extend([
        Cbor::Bytes(vec![7; 16]),
        Cbor::Bytes(vec![8; 16]),
        Cbor::Text("files/resume.bin".into()),
        Cbor::Uint(123),
        Cbor::Bytes(vec![9; 32]),
        Cbor::Uint(86_400_000),
        Cbor::Array(vec![]),
    ]);
    let old_plain = cbor::encode(&Cbor::Array(old_fields)).unwrap();
    assert_eq!(&*m.encode().unwrap(), &old_plain);
    assert_eq!(
        binding(m.context, m.owner),
        Cbor::Array(old_binding.clone())
    );
    let old_object = seal_object(
        &key,
        m.context,
        "mdbase/v1/hosted-upload-resume",
        Cbor::Array(old_binding),
        &old_plain,
        &mut Salt(12),
    )
    .unwrap();
    let (new_object, reference) = seal_resume_metadata(&key, &m, &mut Salt(12)).unwrap();
    assert_eq!(new_object.bytes, old_object.bytes);
    assert_eq!(reference.cipher_hash, old_object.cipher_hash);
    let mut region = old_object.bytes;
    let authenticated = open_resume_metadata(&key, &reference, m.owner, &mut region).unwrap();
    assert_eq!(authenticated.metadata(), &m);
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn host_v2_roundtrip_and_every_identity_drift_refuses_and_wipes() {
    let key = Secret32([10; 32]);
    let mut m = metadata(123);
    m.owner = host();
    let plain = vec![0xb1; 123];
    let (chunk, chunk_ref) =
        seal_chunk(&key, &m.chunk_context(0).unwrap(), &plain, &mut Salt(11)).unwrap();
    m.chunks.push(chunk_ref);
    let (object, reference) = seal_resume_metadata(&key, &m, &mut Salt(12)).unwrap();
    let mut region = vec![0xcd; MAX_SEALED];
    let pointer = region.as_ptr();
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    let auth = open_resume_metadata(&key, &reference, m.owner, &mut region).unwrap();
    assert_eq!(auth.metadata(), &m);
    assert!(region.iter().all(|b| *b == 0));
    region[..chunk.bytes.len()].copy_from_slice(&chunk.bytes);
    let span = open_committed_chunk_in_place(&key, &auth, 0, &mut region).unwrap();
    assert_eq!(&region[span], &plain);
    assert_eq!(region.as_ptr(), pointer);
    let owners = [
        UploadResumeOwner::HostV2 {
            device: B16([14; 16]),
            account: B16([5; 16]),
            transfer: B16([6; 16]),
        },
        UploadResumeOwner::HostV2 {
            device: B16([13; 16]),
            account: B16([15; 16]),
            transfer: B16([6; 16]),
        },
        UploadResumeOwner::HostV2 {
            device: B16([13; 16]),
            account: B16([5; 16]),
            transfer: B16([16; 16]),
        },
        metadata(123).owner,
    ];
    for owner in owners {
        refused(&key, &reference, owner, &object.bytes);
    }
}

#[test]
fn host_and_grant_purposes_and_authenticated_payloads_cannot_cross_owner_formats() {
    let key = Secret32([10; 32]);
    let grant = metadata(123);
    let mut m = grant.clone();
    m.owner = host();
    let (grant_object, grant_ref) = seal_resume_metadata(&key, &grant, &mut Salt(12)).unwrap();
    refused(&key, &grant_ref, host(), &grant_object.bytes);
    // Even a valid ciphertext under Host's expected binding must contain a Host
    // payload. Conversely, Host metadata under the old purpose cannot be opened.
    for (domain, plain) in [
        (HOST_DOMAIN, grant.encode().unwrap()),
        (DOMAIN, m.encode().unwrap()),
    ] {
        let object = seal_object(
            &key,
            m.context,
            domain,
            binding(m.context, host()),
            &plain,
            &mut Salt(12),
        )
        .unwrap();
        let reference = UploadResumeRefV1 {
            context: m.context,
            cipher_hash: object.cipher_hash,
            sealed_bytes: object.bytes.len() as u64,
        };
        refused(&key, &reference, host(), &object.bytes);
    }
}

#[test]
fn host_owner_tag_and_arities_are_strict_and_not_an_old_grant_placeholder() {
    let mut m = metadata(0);
    m.owner = host();
    let bytes = m.encode().unwrap();
    assert_eq!(bytes[0], 0x8d); // exact 13-field root vs old Grant's 16
    assert_eq!(UploadResumeMetadataV1::decode(&bytes).unwrap(), m);
    let offset = cbor::encode(&Cbor::Array(m.context.fields()))
        .unwrap()
        .len();
    assert_eq!(&bytes[offset..offset + 2], &[0x84, 2]);
    for (index, replacement) in [(0, 0x90), (offset, 0x83), (offset + 1, 1), (offset + 1, 3)] {
        let mut bad = bytes.to_vec();
        bad[index] = replacement;
        assert!(UploadResumeMetadataV1::decode(&bad).is_err());
    }
    let mut nonminimal = bytes.to_vec();
    nonminimal.splice(offset + 1..offset + 2, [0x18, 2]);
    assert!(UploadResumeMetadataV1::decode(&nonminimal).is_err());
    let mut trailing = bytes.to_vec();
    trailing.push(0);
    assert!(UploadResumeMetadataV1::decode(&trailing).is_err());
}
