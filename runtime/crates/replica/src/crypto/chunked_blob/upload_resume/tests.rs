use super::*;
use crate::crypto::Entropy;
use crate::seal::{KeyringSealer, PlainSealer, Sealer};
use sha2::{Digest, Sha256};

struct Salt(u8);
impl Entropy for Salt {
    fn fill(&mut self, bytes: &mut [u8]) {
        bytes.fill(self.0);
    }
}
impl CsprngEntropy for Salt {}
struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) {
        panic!("entropy before refusal");
    }
}
impl CsprngEntropy for NoEntropy {}
fn metadata(total: u64) -> UploadResumeMetadataV1 {
    UploadResumeMetadataV1 {
        context: AttachmentContextV1 {
            collection: B16([1; 16]),
            key_epoch: 7,
            attachment_id: B32([2; 32]),
            chunk_bytes: CHUNK_BYTES,
        },
        owner: UploadResumeOwnerV1 {
            grant: B16([3; 16]),
            client_pk: B32([4; 32]),
            account: B16([5; 16]),
            transfer: B16([6; 16]),
        },
        file: B16([7; 16]),
        mutation: B16([8; 16]),
        path: "files/resume.bin".into(),
        total_plain_bytes: total,
        expected_whole_hash: Some(B32([9; 32])),
        expires_at_ms: 86_400_000,
        chunks: vec![],
    }
}
fn add_chunk(
    key: &Secret32,
    m: &mut UploadResumeMetadataV1,
    index: u64,
    plain: &[u8],
) -> SealedObject {
    let ctx = m.chunk_context(index).unwrap();
    let (object, reference) = seal_chunk(key, &ctx, plain, &mut Salt(11)).unwrap();
    m.chunks.push(reference);
    object
}
fn reopen(key: &Secret32, m: &UploadResumeMetadataV1) -> AuthenticatedUploadResumeV1 {
    let (object, reference) = seal_resume_metadata(key, m, &mut Salt(12)).unwrap();
    let mut region = vec![0xcd; MAX_SEALED];
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    let auth = open_resume_metadata(key, &reference, m.owner, &mut region).unwrap();
    assert!(region.iter().all(|b| *b == 0));
    auth
}
fn fail_open(key: &Secret32, r: UploadResumeRefV1, owner: UploadResumeOwnerV1, bytes: &[u8]) {
    let mut region = vec![0xce; MAX_SEALED];
    region[..bytes.len()].copy_from_slice(bytes);
    assert!(open_resume_metadata(key, &r, owner, &mut region).is_err());
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn complete_metadata_and_chunks_roundtrip_zero_partial_and_eight_mib_in_same_region() {
    let key = Secret32([10; 32]);
    for len in [0, 65_537, MAX_CHUNK_PLAIN] {
        let plain: Vec<u8> = (0..len).map(|i| i.wrapping_mul(37) as u8).collect();
        let mut m = metadata(len as u64);
        m.expected_whole_hash = Some(mdbn_wire::hash::sha256(&plain));
        let chunk = add_chunk(&key, &mut m, 0, &plain);
        let (object, reference) = seal_resume_metadata(&key, &m, &mut Salt(12)).unwrap();
        assert!(object.bytes.len() <= max_sealed_bytes(7).unwrap());
        let mut region = vec![0xbd; MAX_SEALED];
        let pointer = region.as_ptr();
        region[..object.bytes.len()].copy_from_slice(&object.bytes);
        let auth = open_resume_metadata(&key, &reference, m.owner, &mut region).unwrap();
        assert_eq!(auth.metadata(), &m);
        assert!(region.iter().all(|b| *b == 0));
        region[..chunk.bytes.len()].copy_from_slice(&chunk.bytes);
        let span = open_committed_chunk_in_place(&key, &auth, 0, &mut region).unwrap();
        assert_eq!(&region[span.clone()], &plain);
        assert_eq!(
            mdbn_wire::hash::sha256(&region[span]),
            m.expected_whole_hash.unwrap()
        );
        assert_eq!(region.as_ptr(), pointer);
        assert!(region[chunk.bytes.len()..].iter().all(|b| *b == 0));
    }
}

#[test]
fn nonfinal_committed_prefix_uses_original_total_and_rebuilds_whole_digest() {
    let key = Secret32([10; 32]);
    let first = vec![0xa7; MAX_CHUNK_PLAIN];
    let tail = vec![0xb8; 65_537];
    let mut expected = Sha256::new();
    expected.update(&first);
    expected.update(&tail);
    let mut m = metadata((first.len() + tail.len()) as u64);
    m.expected_whole_hash = Some(B32(expected.finalize().into()));
    let object = add_chunk(&key, &mut m, 0, &first);
    let auth = reopen(&key, &m);
    assert!(!auth.metadata.chunk_context(0).unwrap().final_chunk);
    let mut region = vec![0xcc; MAX_SEALED];
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    let span = open_committed_chunk_in_place(&key, &auth, 0, &mut region).unwrap();
    let mut rebuilt = Sha256::new();
    rebuilt.update(&region[span]);
    rebuilt.update(&tail);
    assert_eq!(
        B32(rebuilt.finalize().into()),
        m.expected_whole_hash.unwrap()
    );
    assert_eq!(auth.metadata.chunks.len(), 1);
    let mut bad = m.clone();
    bad.total_plain_bytes = first.len() as u64;
    let changed = reopen(&key, &bad); // structurally valid, but WRONG finality AAD
    region.fill(0xcd);
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    assert!(open_committed_chunk_in_place(&key, &changed, 0, &mut region).is_err());
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn owner_context_purpose_checksum_and_payload_binding_drift_refuses_and_wipes_all() {
    let key = Secret32([10; 32]);
    let m = metadata(123);
    let (object, reference) = seal_resume_metadata(&key, &m, &mut Salt(12)).unwrap();
    let mut owners = [m.owner; 4];
    owners[0].grant.0[0] ^= 1;
    owners[1].client_pk.0[0] ^= 1;
    owners[2].account.0[0] ^= 1;
    owners[3].transfer.0[0] ^= 1;
    for owner in owners {
        fail_open(&key, reference, owner, &object.bytes);
    }
    let mut references = [reference; 5];
    references[0].context.collection.0[0] ^= 1;
    references[1].context.key_epoch += 1;
    references[2].context.attachment_id.0[0] ^= 1;
    references[3].context.chunk_bytes -= 1;
    references[4].cipher_hash.0[0] ^= 1;
    for r in references {
        fail_open(&key, r, m.owner, &object.bytes);
    }
    let mut corrupt = object.bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut r = reference;
    r.cipher_hash = mdbn_wire::hash::sha256(&corrupt);
    fail_open(&key, r, m.owner, &corrupt); // checksum matches; AEAD still must pass
    let plain = m.encode().unwrap();
    let foreign = seal_object(
        &key,
        m.context,
        MANIFEST_DOMAIN,
        binding(m.context, m.owner),
        &plain,
        &mut Salt(12),
    )
    .unwrap();
    r.cipher_hash = foreign.cipher_hash;
    r.sealed_bytes = foreign.bytes.len() as u64;
    fail_open(&key, r, m.owner, &foreign.bytes);
    let mut wrong_payload = m.clone();
    wrong_payload.owner.grant.0[0] ^= 1;
    let forged = seal_object(
        &key,
        m.context,
        DOMAIN,
        binding(m.context, m.owner),
        &wrong_payload.encode().unwrap(),
        &mut Salt(12),
    )
    .unwrap();
    r.cipher_hash = forged.cipher_hash;
    r.sealed_bytes = forged.bytes.len() as u64;
    fail_open(&key, r, m.owner, &forged.bytes); // payload owner must equal KDF owner
}

#[test]
fn strict_metadata_decoder_refuses_nonminimal_trailing_and_oversized_claims() {
    let m = metadata(0);
    let bytes = m.encode().unwrap();
    assert_eq!(UploadResumeMetadataV1::decode(&bytes).unwrap(), m);
    let mut trailing = bytes.to_vec();
    trailing.push(0);
    assert!(UploadResumeMetadataV1::decode(&trailing).is_err());
    let mut nonminimal = bytes.to_vec();
    nonminimal.splice(1..2, [0x18, 1]);
    assert!(UploadResumeMetadataV1::decode(&nonminimal).is_err());
    let mut huge_count = bytes.to_vec();
    huge_count.pop();
    huge_count.extend([0x9b, 255, 255, 255, 255, 255, 255, 255, 255]);
    assert!(UploadResumeMetadataV1::decode(&huge_count).is_err());
    assert!(UploadResumeMetadataV1::decode(&vec![0; METADATA_BYTES + 1]).is_err());
}

#[test]
fn preentropy_caps_refusals_and_bad_regions_wipe_without_progress() {
    let key = Secret32([10; 32]);
    let m = metadata(0);
    let mut cases = vec![];
    let mut bad = m.clone();
    bad.total_plain_bytes = FILE_BYTES + 1;
    cases.push(bad);
    let mut bad = m.clone();
    bad.path = "p".repeat(PATH_BYTES + 1);
    cases.push(bad);
    let mut bad = m.clone();
    bad.expires_at_ms = 1 << 53;
    cases.push(bad);
    let mut bad = m.clone();
    bad.context.chunk_bytes -= 1;
    cases.push(bad);
    let mut bad = m.clone();
    bad.chunks = vec![
        ChunkRefV1 {
            cipher_hash: B32([0; 32]),
            sealed_bytes: 1,
            plain_hash: B32([0; 32]),
            plain_bytes: 0
        };
        129
    ];
    cases.push(bad);
    for bad in cases {
        assert!(seal_resume_metadata(&key, &bad, &mut NoEntropy).is_err());
    }
    let (object, r) = seal_resume_metadata(&key, &m, &mut Salt(12)).unwrap();
    for size in [object.bytes.len() - 1, MAX_SEALED + 1] {
        let mut region = vec![0xbb; size];
        assert!(open_resume_metadata(&key, &r, m.owner, &mut region).is_err());
        assert!(region.iter().all(|b| *b == 0));
    }
    let auth = reopen(&key, &m);
    let mut region = vec![0xab; MAX_SEALED];
    assert!(open_committed_chunk_in_place(&key, &auth, 0, &mut region).is_err()); // no committed chunk
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn wrong_plain_hash_and_late_tag_committed_reopen_wipe_entire_region() {
    let key = Secret32([10; 32]);
    let mut m = metadata(65_537);
    let chunk = add_chunk(&key, &mut m, 0, &vec![0xa7; 65_537]);
    let mut bad_hash = m.clone();
    bad_hash.chunks[0].plain_hash.0[0] ^= 1;
    let mut corrupt = chunk.bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut bad_tag = m.clone();
    bad_tag.chunks[0].cipher_hash = mdbn_wire::hash::sha256(&corrupt);
    for (bad, bytes) in [(&bad_hash, &chunk.bytes), (&bad_tag, &corrupt)] {
        let auth = reopen(&key, bad);
        let mut region = vec![0xab; MAX_SEALED];
        region[..bytes.len()].copy_from_slice(bytes);
        assert!(open_committed_chunk_in_place(&key, &auth, 0, &mut region).is_err());
        assert!(region.iter().all(|b| *b == 0));
    }
}

#[test]
fn keyring_requires_current_epoch_for_metadata_and_chunks_defaults_refuse_and_wipe() {
    fn sealer() -> KeyringSealer {
        let mut keys = crate::crypto::keys::Keyring::new();
        keys.insert(7, Secret32([10; 32]));
        keys.insert(8, Secret32([11; 32]));
        let bytes = keys.to_bytes();
        let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
        stored.extend_from_slice(&bytes);
        let mut s = KeyringSealer::new(B16([1; 16]), B16([2; 16]), &[6; 32], &[7; 32]);
        s.import(&stored).unwrap();
        s.set_epoch(7);
        s
    }
    let mut s = sealer();
    let mut m = metadata(3);
    let chunk = add_chunk(&Secret32([10; 32]), &mut m, 0, b"abc");
    let (object, r) = s.seal_hosted_upload_resume(&m, &mut Salt(12)).unwrap();
    let mut region = vec![0xbb; MAX_SEALED];
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    let auth = s
        .open_hosted_upload_resume(&r, m.owner, &mut region)
        .unwrap();
    s.set_epoch(8); // OLD KEY STILL HELD; resume is not a historical read
    assert!(s.seal_hosted_upload_resume(&m, &mut NoEntropy).is_err());
    region.fill(0xbb);
    region[..object.bytes.len()].copy_from_slice(&object.bytes);
    assert!(
        s.open_hosted_upload_resume(&r, m.owner, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    region.fill(0xbb);
    region[..chunk.bytes.len()].copy_from_slice(&chunk.bytes);
    assert!(
        s.open_hosted_upload_committed_chunk_in_place(&auth, 0, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    let plain = PlainSealer::for_device(B16([2; 16]));
    assert!(plain.seal_hosted_upload_resume(&m, &mut NoEntropy).is_err());
    region.fill(0xbb);
    assert!(
        plain
            .open_hosted_upload_resume(&r, m.owner, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    region.fill(0xbb);
    assert!(
        plain
            .open_hosted_upload_committed_chunk_in_place(&auth, 0, &mut region)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
}
