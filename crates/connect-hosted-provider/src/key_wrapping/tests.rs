use std::sync::{Arc, Mutex};

use super::*;

const MANAGED_KEY: &str = "arn:aws:kms:ap-southeast-1:445617516211:key/mrk-test";

#[derive(Clone)]
struct FakeManagedService {
    active_key_ref: &'static str,
    failure: Arc<Mutex<Option<KeyWrapErrorKind>>>,
    contexts: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
}

impl FakeManagedService {
    fn healthy() -> Self {
        Self {
            active_key_ref: MANAGED_KEY,
            failure: Arc::new(Mutex::new(None)),
            contexts: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn fail_with(&self, kind: KeyWrapErrorKind) {
        *self.failure.lock().unwrap() = Some(kind);
    }

    fn maybe_fail(&self) -> Result<(), KeyWrapError> {
        if let Some(kind) = self.failure.lock().unwrap().take() {
            return Err(KeyWrapError::new(kind, "Synthetic managed key failure."));
        }
        Ok(())
    }
}

#[async_trait]
impl ManagedKeyService for FakeManagedService {
    fn active_key_ref(&self) -> &str {
        self.active_key_ref
    }

    async fn encrypt(
        &self,
        plaintext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<ManagedCiphertext, KeyWrapError> {
        self.maybe_fail()?;
        self.contexts
            .lock()
            .unwrap()
            .push(context.encryption_context());
        Ok(ManagedCiphertext {
            key_ref: self.active_key_ref.to_string(),
            ciphertext: plaintext.iter().map(|byte| byte ^ 0x5a).collect(),
        })
    }

    async fn decrypt(
        &self,
        key_ref: &str,
        ciphertext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError> {
        self.maybe_fail()?;
        if key_ref != self.active_key_ref {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::WrongKey,
                "Synthetic key mismatch.",
            ));
        }
        self.contexts
            .lock()
            .unwrap()
            .push(context.encryption_context());
        Ok(Zeroizing::new(
            ciphertext.iter().map(|byte| byte ^ 0x5a).collect(),
        ))
    }
}

fn context() -> KeyWrapContext {
    KeyWrapContext::collection(
        "staging",
        Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
    )
    .unwrap()
}

fn legacy() -> LegacyKeyWrapper {
    LegacyKeyWrapper::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap()
}

#[tokio::test]
async fn writes_managed_envelopes_and_reads_them_with_exact_context() {
    let service = Arc::new(FakeManagedService::healthy());
    let runtime = KeyWrappingRuntime::managed_for_test(service.clone(), Some(legacy()));
    let data_key = [9_u8; KEY_BYTES];
    let wrapped = runtime.wrap_data_key(&data_key, &context()).await.unwrap();
    assert_eq!(
        KeyWrappingRuntime::inspect(&wrapped).unwrap(),
        KeyWrapInspection::AwsKmsV1 {
            key_ref: MANAGED_KEY.to_string()
        }
    );
    assert_eq!(
        runtime
            .unwrap_data_key(&wrapped, &context())
            .await
            .unwrap()
            .as_ref(),
        &data_key
    );
    let contexts = service.contexts.lock().unwrap();
    assert_eq!(contexts.len(), 2);
    assert_eq!(contexts[0], contexts[1]);
    assert_eq!(contexts[0]["mdbase:environment"], "staging");
    assert_eq!(contexts[0]["mdbase:purpose"], "collection-data-key");
    assert_eq!(
        contexts[0]["mdbase:collection-id"],
        "01911111-1111-7111-8111-111111111111"
    );
}

#[tokio::test]
async fn managed_writer_can_migrate_exact_legacy_envelopes() {
    let legacy_runtime = KeyWrappingRuntime::legacy(legacy());
    let data_key = [3_u8; KEY_BYTES];
    let legacy_wrapped = legacy_runtime
        .wrap_data_key(&data_key, &context())
        .await
        .unwrap();
    let managed = KeyWrappingRuntime::managed_for_test(
        Arc::new(FakeManagedService::healthy()),
        Some(legacy()),
    );
    assert_eq!(
        managed
            .unwrap_data_key(&legacy_wrapped, &context())
            .await
            .unwrap()
            .as_ref(),
        &data_key
    );
    let rewrapped = managed.wrap_data_key(&data_key, &context()).await.unwrap();
    assert!(matches!(
        KeyWrappingRuntime::inspect(&rewrapped).unwrap(),
        KeyWrapInspection::AwsKmsV1 { .. }
    ));
}

#[tokio::test]
async fn fails_closed_without_the_reader_required_by_stored_state() {
    let legacy_runtime = KeyWrappingRuntime::legacy(legacy());
    let wrapped = legacy_runtime
        .wrap_data_key(&[4; KEY_BYTES], &context())
        .await
        .unwrap();
    let managed =
        KeyWrappingRuntime::managed_for_test(Arc::new(FakeManagedService::healthy()), None);
    assert_eq!(
        managed
            .unwrap_data_key(&wrapped, &context())
            .await
            .unwrap_err()
            .kind,
        KeyWrapErrorKind::Configuration
    );
}

#[tokio::test]
async fn preserves_managed_failure_categories_without_key_material() {
    let service = Arc::new(FakeManagedService::healthy());
    let runtime = KeyWrappingRuntime::managed_for_test(service.clone(), None);
    for kind in [
        KeyWrapErrorKind::AccessDenied,
        KeyWrapErrorKind::Disabled,
        KeyWrapErrorKind::InvalidCiphertext,
        KeyWrapErrorKind::Throttled,
        KeyWrapErrorKind::Timeout,
        KeyWrapErrorKind::Unavailable,
    ] {
        service.fail_with(kind);
        let error = runtime
            .wrap_data_key(&[8; KEY_BYTES], &context())
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert!(!error.to_string().contains(MANAGED_KEY));
        assert!(!error.to_string().contains("080808"));
    }
}

#[tokio::test]
async fn rejects_wrong_context_and_invalid_unwrapped_lengths() {
    let legacy_runtime = KeyWrappingRuntime::legacy(legacy());
    let wrapped = legacy_runtime
        .wrap_data_key(&[2; KEY_BYTES], &context())
        .await
        .unwrap();
    let other = KeyWrapContext::collection(
        "staging",
        Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
    )
    .unwrap();
    assert_eq!(
        legacy_runtime
            .unwrap_data_key(&wrapped, &other)
            .await
            .unwrap_err()
            .kind,
        KeyWrapErrorKind::InvalidCiphertext
    );

    let service = Arc::new(FakeManagedService::healthy());
    let runtime = KeyWrappingRuntime::managed_for_test(service, None);
    let short = runtime.wrap_bytes(&[1, 2, 3], &context()).await.unwrap();
    assert_eq!(
        runtime
            .unwrap_data_key(&short, &context())
            .await
            .unwrap_err()
            .kind,
        KeyWrapErrorKind::InvalidCiphertext
    );
}

#[test]
fn key_check_context_never_contains_a_collection_identifier() {
    let context = KeyWrapContext::provider_key_check("production").unwrap();
    let values = context.encryption_context();
    assert_eq!(values["mdbase:purpose"], "provider-key-check");
    assert!(!values.contains_key("mdbase:collection-id"));
}
