//! Copy byte-for-byte to Connect's `crates/connect-hosted-provider/src/key_wrapping/worker_vectors.rs`
//! at 8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e; the parent module adds
//! `#[cfg(test)] mod worker_vectors;`. This is a child unit module, not an integration test.
//!
//! Only public fixed test keys, dummy ARNs and synthetic payloads are used. The
//! provider performs the actual local wrapping, MDBK encoding and payload crypto.
//! The managed service below is ONLY a deterministic opaque-ciphertext stub: it
//! performs no KMS crypto, AWS client construction, credential discovery or I/O.
//! LAB uses the existing private test constructor, not a new production capability.
//!
//! Local wrap AND payload nonces come from the real provider's OsRng. Regeneration
//! is NOT byte-deterministic: capture the emitted JSON once as the fixed KAT, and
//! retain this exact source and provider commit as provenance. Never replace the
//! provider nonce generation or derive expected ciphertext with a second algorithm.

use super::*;
use crate::crypto::ProviderCrypto;
use std::sync::atomic::{AtomicUsize, Ordering};

const PROVIDER_SOURCE_COMMIT: &str = "8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e";
const MASTER_KEY: [u8; 32] = [7; 32];
const MASTER_KEY_BASE64: &str =
    concat!("BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "BwcH", "Bwc");
const DEK: [u8; 32] = [9; 32];
const COLLECTION_ID: &str = "01911111-1111-7111-8111-111111111111";
const OTHER_COLLECTION_ID: &str = "01922222-2222-7222-8222-222222222222";
const RECORD_ID: &str = "01933333-3333-7333-8333-333333333333";
const SEQUENCE: u64 = 40;
const PAYLOAD: &[u8] = b"# Public provider wrapping KAT\nNo secrets or live records.\n";
const OLD_KEY_REF: &str =
    "arn:aws:kms:us-east-1:000000000000:key/11111111-1111-4111-8111-111111111111";
const NEW_KEY_REF: &str =
    "arn:aws:kms:us-west-2:000000000000:key/mrk-22222222222222222222222222222222";

// This mapping checks exact input identity, not a reversible stand-in cipher.
// Different environments/references get different fixed opaque ciphertexts.
struct TestManagedKeyService {
    key_ref: &'static str,
    ciphertext: Vec<u8>,
    expected_context: BTreeMap<String, String>,
    decrypt_calls: AtomicUsize,
}

#[async_trait::async_trait]
impl ManagedKeyService for TestManagedKeyService {
    fn active_key_ref(&self) -> &str {
        self.key_ref
    }

    async fn encrypt(
        &self,
        plaintext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<ManagedCiphertext, KeyWrapError> {
        assert_eq!(
            plaintext,
            DEK.as_slice(),
            "stub only accepts the public test DEK"
        );
        assert_eq!(context.encryption_context(), self.expected_context);
        Ok(ManagedCiphertext {
            key_ref: self.key_ref.to_string(),
            ciphertext: self.ciphertext.clone(),
        })
    }

    async fn decrypt(
        &self,
        key_ref: &str,
        ciphertext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError> {
        self.decrypt_calls.fetch_add(1, Ordering::SeqCst);
        if key_ref != self.key_ref {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::WrongKey,
                "Public vector stub key reference mismatch.",
            ));
        }
        if ciphertext != self.ciphertext.as_slice()
            || context.encryption_context() != self.expected_context
        {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::InvalidCiphertext,
                "Public vector stub ciphertext or context mismatch.",
            ));
        }
        Ok(Zeroizing::new(DEK.to_vec()))
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut result, "{byte:02x}").unwrap();
    }
    result
}

fn expected_kms_context(environment: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("mdbase:service".into(), "hosted-provider".into()),
        ("mdbase:environment".into(), environment.into()),
        ("mdbase:purpose".into(), "collection-data-key".into()),
        ("mdbase:envelope-version".into(), "1".into()),
        ("mdbase:collection-id".into(), COLLECTION_ID.into()),
    ])
}

fn case_json(
    name: &str,
    environment: &str,
    wrapped: &[u8],
    payload_aad: &[u8],
    payload_ciphertext: &[u8],
    context: &KeyWrapContext,
    managed: Option<(&str, &[u8])>,
) -> serde_json::Value {
    let (mode, kms_context, key_ref, kms_ciphertext) = match managed {
        None => (
            "local-aes-gcm-v1",
            // Descriptor only: local wrapping still authenticates ONLY legacy_aad.
            serde_json::to_value(context.encryption_context()).unwrap(),
            None,
            None,
        ),
        Some((key_ref, ciphertext)) => (
            "mdbk-v1-aws-kms-scheme-1",
            serde_json::to_value(context.encryption_context()).unwrap(),
            Some(key_ref),
            Some(hex(ciphertext)),
        ),
    };
    serde_json::json!({
        "name": name,
        "mode": mode,
        "environment": environment,
        "collectionId": COLLECTION_ID,
        "recordId": RECORD_ID,
        "sequence": SEQUENCE,
        "masterKeyHex": hex(&MASTER_KEY),
        "dekHex": hex(&DEK),
        "wrappedKeyHex": hex(wrapped),
        "legacyAadHex": hex(&context.legacy_aad),
        "kmsContext": kms_context,
        "keyRef": key_ref,
        "kmsCiphertextHex": kms_ciphertext,
        "payloadAadHex": hex(payload_aad),
        "payloadPlaintextHex": hex(PAYLOAD),
        "payloadCiphertextHex": hex(payload_ciphertext),
    })
}

async fn assert_payload_parity(
    provider: &ProviderCrypto,
    wrapped: &[u8],
    collection_id: Uuid,
    payload_aad: &[u8],
    payload_ciphertext: &[u8],
) {
    let opened = provider
        .unwrap_data_key(wrapped, collection_id)
        .await
        .unwrap();
    assert_eq!(opened.as_ref(), &DEK);
    assert_eq!(
        provider
            .decrypt_bytes(&opened, payload_ciphertext, payload_aad)
            .unwrap(),
        PAYLOAD
    );
    let mut wrong_aad = payload_aad.to_vec();
    wrong_aad.push(0);
    assert!(provider
        .decrypt_bytes(&opened, payload_ciphertext, &wrong_aad)
        .is_err());
    let mut tampered = payload_ciphertext.to_vec();
    *tampered.last_mut().unwrap() ^= 1;
    assert!(provider
        .decrypt_bytes(&opened, &tampered, payload_aad)
        .is_err());
    assert!(provider
        .unwrap_data_key(wrapped, Uuid::parse_str(OTHER_COLLECTION_ID).unwrap())
        .await
        .is_err());
}

// Exercise the actual provider unwrap, not merely an independent parser oracle.
async fn assert_envelope_refusals(
    provider: &ProviderCrypto,
    wrapped: &[u8],
    collection_id: Uuid,
    managed: bool,
) {
    for length in 0..wrapped.len() {
        assert!(provider
            .unwrap_data_key(&wrapped[..length], collection_id)
            .await
            .is_err());
    }
    let mut trailing = wrapped.to_vec();
    trailing.push(0);
    assert!(provider
        .unwrap_data_key(&trailing, collection_id)
        .await
        .is_err());
    let mut unknown_header = wrapped.to_vec();
    unknown_header[0] = 2;
    assert!(provider
        .unwrap_data_key(&unknown_header, collection_id)
        .await
        .is_err());

    if managed {
        for offset in [4, 5] {
            let mut unknown = wrapped.to_vec();
            unknown[offset] = 2;
            assert_eq!(
                KeyWrappingRuntime::inspect(&unknown).unwrap_err().kind,
                KeyWrapErrorKind::UnsupportedEnvelope
            );
            assert!(provider
                .unwrap_data_key(&unknown, collection_id)
                .await
                .is_err());
        }
        for key_ref_length in [0_u16, 2_049] {
            let mut invalid = wrapped.to_vec();
            invalid[6..8].copy_from_slice(&key_ref_length.to_be_bytes());
            assert!(provider
                .unwrap_data_key(&invalid, collection_id)
                .await
                .is_err());
        }
        for ciphertext_length in [0_u32, 8_193] {
            let mut invalid = wrapped.to_vec();
            invalid[8..12].copy_from_slice(&ciphertext_length.to_be_bytes());
            assert!(provider
                .unwrap_data_key(&invalid, collection_id)
                .await
                .is_err());
        }
        let mut invalid_key_ref = wrapped.to_vec();
        invalid_key_ref[12] = b'"';
        assert!(provider
            .unwrap_data_key(&invalid_key_ref, collection_id)
            .await
            .is_err());
    } else {
        let mut tampered = wrapped.to_vec();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(provider
            .unwrap_data_key(&tampered, collection_id)
            .await
            .is_err());
    }
}

#[tokio::test]
async fn emit_worker_wrapping_known_answers() {
    assert_eq!(
        base64::Engine::decode(&general_purpose::URL_SAFE_NO_PAD, MASTER_KEY_BASE64).unwrap(),
        MASTER_KEY
    );
    let collection_id = Uuid::parse_str(COLLECTION_ID).unwrap();
    let record_id = Uuid::parse_str(RECORD_ID).unwrap();
    // This is the actual provider's compact serde_json tuple AAD, including the
    // numeric sequence (not a string) and lowercase hyphenated UUIDs.
    let payload_aad =
        serde_json::to_vec(&("current_record", collection_id, record_id, SEQUENCE)).unwrap();
    let legacy_aad = serde_json::to_vec(&("collection_key", collection_id)).unwrap();
    let mut cases = Vec::new();

    for (environment_index, environment) in ["lab", "staging", "production"].into_iter().enumerate()
    {
        let context = KeyWrapContext::collection(environment, collection_id).unwrap();
        assert_eq!(context.legacy_aad, legacy_aad);
        assert_eq!(
            context.encryption_context(),
            expected_kms_context(environment)
        );

        // from_base64 deliberately uses the historical local writer. Local
        // wrapping has no authenticated environment; never add one to its AAD.
        let local = ProviderCrypto::from_base64(MASTER_KEY_BASE64).unwrap();
        let local_wrapped = local.wrap_data_key(&DEK, collection_id).await.unwrap();
        assert_eq!(local_wrapped.len(), 61);
        assert_eq!(
            KeyWrappingRuntime::inspect(&local_wrapped).unwrap(),
            KeyWrapInspection::LocalAes256GcmV1
        );
        let local_payload = local.encrypt_bytes(&DEK, PAYLOAD, &payload_aad).unwrap();
        assert_payload_parity(
            &local,
            &local_wrapped,
            collection_id,
            &payload_aad,
            &local_payload,
        )
        .await;
        assert_envelope_refusals(&local, &local_wrapped, collection_id, false).await;
        cases.push(case_json(
            &format!("{environment}-local"),
            environment,
            &local_wrapped,
            &payload_aad,
            &local_payload,
            &context,
            None,
        ));

        // Real local encryption of a short plaintext must not be accepted as a DEK.
        let legacy_runtime =
            KeyWrappingRuntime::legacy(LegacyKeyWrapper::from_base64(MASTER_KEY_BASE64).unwrap());
        let short_key = legacy_runtime.wrap_bytes(&[9; 31], &context).await.unwrap();
        assert!(local
            .unwrap_data_key(&short_key, collection_id)
            .await
            .is_err());

        // These variants cover real MDBK encoding of old/new immutable references.
        // They do NOT claim to exercise AWS returned-KeyId/MRK replica validation.
        for (reference_index, (label, key_ref)) in [
            ("managed-old", OLD_KEY_REF),
            ("managed-new-mrk", NEW_KEY_REF),
        ]
        .into_iter()
        .enumerate()
        {
            let marker = u8::try_from(environment_index * 2 + reference_index).unwrap();
            let mut opaque_ciphertext = vec![0xa0 + marker; 48];
            opaque_ciphertext[0] = 0;
            opaque_ciphertext[1] = 0xff;
            let service = Arc::new(TestManagedKeyService {
                key_ref,
                ciphertext: opaque_ciphertext.clone(),
                expected_context: expected_kms_context(environment),
                decrypt_calls: AtomicUsize::new(0),
            });
            let runtime = KeyWrappingRuntime::managed_for_test(
                service.clone(),
                Some(LegacyKeyWrapper::from_base64(MASTER_KEY_BASE64).unwrap()),
            );
            let managed = ProviderCrypto::with_key_wrapping(runtime, environment).unwrap();
            // This invokes Runtime::wrap_bytes -> REAL envelope::encode_aws_kms.
            let wrapped = managed.wrap_data_key(&DEK, collection_id).await.unwrap();
            let parsed = envelope::parse_managed(&wrapped).unwrap();
            assert_eq!(parsed.key_ref, key_ref);
            assert_eq!(parsed.ciphertext, opaque_ciphertext.as_slice());
            let payload_ciphertext = managed.encrypt_bytes(&DEK, PAYLOAD, &payload_aad).unwrap();
            assert_payload_parity(
                &managed,
                &wrapped,
                collection_id,
                &payload_aad,
                &payload_ciphertext,
            )
            .await;
            // Same real runtime reads both historically persisted modes.
            assert_payload_parity(
                &managed,
                &local_wrapped,
                collection_id,
                &payload_aad,
                &local_payload,
            )
            .await;
            assert!(local
                .unwrap_data_key(&wrapped, collection_id)
                .await
                .is_err());

            let calls_before = service.decrypt_calls.load(Ordering::SeqCst);
            assert_envelope_refusals(&managed, &wrapped, collection_id, true).await;
            assert_eq!(
                service.decrypt_calls.load(Ordering::SeqCst),
                calls_before,
                "malformed MDBK must be refused before the managed service"
            );
            let mut changed_ciphertext = wrapped.clone();
            *changed_ciphertext.last_mut().unwrap() ^= 1;
            assert!(managed
                .unwrap_data_key(&changed_ciphertext, collection_id)
                .await
                .is_err());
            let mut changed_reference = wrapped.clone();
            changed_reference[12] = b'b'; // Still graphic; the stub must reject the wrong reference.
            assert!(managed
                .unwrap_data_key(&changed_reference, collection_id)
                .await
                .is_err());
            let wrong_environment = if environment == "production" {
                "staging"
            } else {
                "production"
            };
            let wrong_reader = ProviderCrypto::with_key_wrapping(
                KeyWrappingRuntime::managed_for_test(service.clone(), None),
                wrong_environment,
            )
            .unwrap();
            assert!(wrong_reader
                .unwrap_data_key(&wrapped, collection_id)
                .await
                .is_err());

            cases.push(case_json(
                &format!("{environment}-{label}"),
                environment,
                &wrapped,
                &payload_aad,
                &payload_ciphertext,
                &context,
                Some((key_ref, &opaque_ciphertext)),
            ));
        }
    }

    assert_eq!(cases.len(), 9);
    let document = serde_json::json!({
        "schema": "mdbase-provider-wrapping-kat/1",
        "providerSourceCommit": PROVIDER_SOURCE_COMMIT,
        "publicFixedTestValuesOnly": true,
        "realAws": false,
        "cases": cases,
    });
    println!(
        "MDBASE_PROVIDER_WRAPPING_VECTOR_JSON={}",
        serde_json::to_string(&document).unwrap()
    );
}
