use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use aws_config::{retry::RetryConfig, BehaviorVersion};
use aws_sdk_kms::{
    primitives::Blob,
    types::{KeySpec, KeyState, KeyUsageType},
    Client,
};
use aws_smithy_types::{error::metadata::ProvideErrorMetadata, timeout::TimeoutConfig};
use aws_types::region::Region;
use zeroize::Zeroizing;

use super::{KeyWrapContext, KeyWrapError, KeyWrapErrorKind, ManagedCiphertext, ManagedKeyService};

#[derive(Clone)]
pub struct AwsKmsKeyWrapper {
    client: Client,
    active_key_id: Arc<str>,
    environment: Arc<str>,
    operation_timeout: Duration,
}

impl AwsKmsKeyWrapper {
    pub async fn from_default_chain(
        region: impl Into<String>,
        active_key_id: impl Into<String>,
        environment: impl Into<String>,
        max_attempts: u32,
        operation_timeout: Duration,
    ) -> Result<Self, KeyWrapError> {
        let region = region.into();
        let active_key_id = active_key_id.into();
        let environment = environment.into();
        validate_configuration(
            &region,
            &active_key_id,
            &environment,
            max_attempts,
            operation_timeout,
        )?;
        let timeout_config = TimeoutConfig::builder()
            .operation_timeout(operation_timeout)
            .build();
        let config = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region))
            .retry_config(RetryConfig::standard().with_max_attempts(max_attempts))
            .timeout_config(timeout_config)
            .load()
            .await;
        let client = Client::new(&config);
        let response = tokio::time::timeout(
            operation_timeout,
            client.describe_key().key_id(&active_key_id).send(),
        )
        .await
        .map_err(|_| KeyWrapError::timeout())?
        .map_err(|error| classify_service_error(error.as_service_error()))?;
        let metadata = response
            .key_metadata()
            .ok_or_else(KeyWrapError::invalid_response)?;
        if !metadata.enabled()
            || metadata.key_state() != Some(&KeyState::Enabled)
            || metadata.key_usage() != Some(&KeyUsageType::EncryptDecrypt)
            || metadata.key_spec() != Some(&KeySpec::SymmetricDefault)
        {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::Disabled,
                "The configured AWS KMS key is not an enabled symmetric encryption key.",
            ));
        }
        let active_key_ref = metadata
            .arn()
            .ok_or_else(KeyWrapError::invalid_response)?
            .to_string();
        validate_kms_key_ref(&active_key_ref)?;
        Ok(Self {
            client,
            active_key_id: active_key_ref.into(),
            environment: environment.into(),
            operation_timeout,
        })
    }

    fn ensure_context(&self, context: &KeyWrapContext) -> Result<(), KeyWrapError> {
        if context.environment() != self.environment.as_ref() {
            return Err(KeyWrapError::configuration(
                "The KMS wrapping context does not match the configured environment.",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl ManagedKeyService for AwsKmsKeyWrapper {
    fn active_key_ref(&self) -> &str {
        &self.active_key_id
    }

    async fn encrypt(
        &self,
        plaintext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<ManagedCiphertext, KeyWrapError> {
        self.ensure_context(context)?;
        let operation = self
            .client
            .encrypt()
            .key_id(self.active_key_id.as_ref())
            .plaintext(Blob::new(plaintext))
            .set_encryption_context(Some(context.encryption_context().into_iter().collect()));
        let response = tokio::time::timeout(self.operation_timeout, operation.send())
            .await
            .map_err(|_| KeyWrapError::timeout())?
            .map_err(|error| classify_service_error(error.as_service_error()))?;
        let ciphertext = response
            .ciphertext_blob()
            .ok_or_else(KeyWrapError::invalid_response)?
            .as_ref()
            .to_vec();
        let key_ref = response
            .key_id()
            .ok_or_else(KeyWrapError::invalid_response)?
            .to_string();
        validate_kms_key_ref(&key_ref)?;
        Ok(ManagedCiphertext {
            key_ref,
            ciphertext,
        })
    }

    async fn decrypt(
        &self,
        key_ref: &str,
        ciphertext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError> {
        self.ensure_context(context)?;
        validate_kms_key_ref(key_ref)?;
        let operation = self
            .client
            .decrypt()
            .ciphertext_blob(Blob::new(ciphertext))
            .set_encryption_context(Some(context.encryption_context().into_iter().collect()));
        let response = tokio::time::timeout(self.operation_timeout, operation.send())
            .await
            .map_err(|_| KeyWrapError::timeout())?
            .map_err(|error| classify_service_error(error.as_service_error()))?;
        let actual_key_ref = response
            .key_id()
            .ok_or_else(KeyWrapError::invalid_response)?;
        if !same_kms_key(key_ref, actual_key_ref) {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::WrongKey,
                "AWS KMS returned plaintext from an unexpected key.",
            ));
        }
        let plaintext = response
            .plaintext()
            .ok_or_else(KeyWrapError::invalid_response)?;
        Ok(Zeroizing::new(plaintext.as_ref().to_vec()))
    }
}

fn validate_configuration(
    region: &str,
    active_key_id: &str,
    environment: &str,
    max_attempts: u32,
    operation_timeout: Duration,
) -> Result<(), KeyWrapError> {
    if region.trim().is_empty()
        || active_key_id.trim().is_empty()
        || !matches!(environment, "staging" | "production" | "test")
        || !(1..=10).contains(&max_attempts)
        || operation_timeout.is_zero()
        || operation_timeout > Duration::from_secs(60)
    {
        return Err(KeyWrapError::configuration(
            "The AWS KMS wrapping configuration is invalid.",
        ));
    }
    Ok(())
}

fn validate_kms_key_ref(value: &str) -> Result<(), KeyWrapError> {
    let Some((prefix, resource)) = value.rsplit_once(":key/") else {
        return Err(KeyWrapError::invalid_response());
    };
    if !prefix.starts_with("arn:")
        || resource.is_empty()
        || !resource
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(KeyWrapError::invalid_response());
    }
    Ok(())
}

fn same_kms_key(expected: &str, actual: &str) -> bool {
    if expected == actual {
        return true;
    }
    let expected_resource = expected.rsplit_once(":key/").map(|(_, value)| value);
    let actual_resource = actual.rsplit_once(":key/").map(|(_, value)| value);
    matches!(
        (expected_resource, actual_resource),
        (Some(expected), Some(actual)) if expected.starts_with("mrk-") && expected == actual
    )
}

fn classify_service_error(error: Option<&impl ProvideErrorMetadata>) -> KeyWrapError {
    match error.and_then(ProvideErrorMetadata::code) {
        Some("AccessDeniedException") => KeyWrapError::new(
            KeyWrapErrorKind::AccessDenied,
            "AWS KMS denied the key operation.",
        ),
        Some("DisabledException" | "KMSInvalidStateException") => KeyWrapError::new(
            KeyWrapErrorKind::Disabled,
            "The AWS KMS key is not enabled for this operation.",
        ),
        Some("InvalidCiphertextException") => KeyWrapError::new(
            KeyWrapErrorKind::InvalidCiphertext,
            "AWS KMS rejected the wrapped key ciphertext or context.",
        ),
        Some("IncorrectKeyException" | "NotFoundException") => KeyWrapError::new(
            KeyWrapErrorKind::WrongKey,
            "The AWS KMS key referenced by the envelope is unavailable.",
        ),
        Some("ThrottlingException" | "LimitExceededException") => KeyWrapError::new(
            KeyWrapErrorKind::Throttled,
            "AWS KMS throttled the key operation.",
        ),
        Some("DependencyTimeoutException") => KeyWrapError::timeout(),
        Some("KeyUnavailableException" | "KMSInternalException") => KeyWrapError::new(
            KeyWrapErrorKind::Unavailable,
            "AWS KMS is temporarily unavailable.",
        ),
        _ => KeyWrapError::new(
            KeyWrapErrorKind::Unavailable,
            "The AWS KMS key operation failed.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_same_multi_region_key_across_regions() {
        assert!(same_kms_key(
            "arn:aws:kms:ap-southeast-1:445617516211:key/mrk-one",
            "arn:aws:kms:ap-southeast-2:445617516211:key/mrk-one"
        ));
        assert!(!same_kms_key(
            "arn:aws:kms:ap-southeast-1:445617516211:key/mrk-one",
            "arn:aws:kms:ap-southeast-2:445617516211:key/mrk-two"
        ));
        assert!(!same_kms_key(
            "arn:aws:kms:ap-southeast-1:445617516211:key/one",
            "arn:aws:kms:ap-southeast-2:445617516211:key/one"
        ));
    }

    #[test]
    fn rejects_unsafe_configuration() {
        assert!(validate_configuration("", "key", "staging", 3, Duration::from_secs(5)).is_err());
        assert!(validate_configuration(
            "ap-southeast-1",
            "key",
            "development",
            3,
            Duration::from_secs(5)
        )
        .is_err());
        assert!(validate_configuration(
            "ap-southeast-1",
            "key",
            "staging",
            0,
            Duration::from_secs(5)
        )
        .is_err());
    }
}
