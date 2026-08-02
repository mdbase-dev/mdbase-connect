use super::{KeyWrapError, KeyWrapInspection};

const MAGIC: &[u8; 4] = b"MDBK";
const ENVELOPE_VERSION: u8 = 1;
const AWS_KMS_SCHEME: u8 = 1;
const HEADER_BYTES: usize = 12;
const MAX_KEY_REF_BYTES: usize = 2_048;
const MAX_CIPHERTEXT_BYTES: usize = 8_192;

#[derive(Debug)]
pub(super) struct ManagedEnvelope<'a> {
    pub key_ref: &'a str,
    pub ciphertext: &'a [u8],
}

pub(super) fn encode_aws_kms(key_ref: &str, ciphertext: &[u8]) -> Result<Vec<u8>, KeyWrapError> {
    validate_key_ref(key_ref)?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(KeyWrapError::invalid_envelope());
    }
    let key_ref_len = u16::try_from(key_ref.len()).map_err(|_| KeyWrapError::invalid_envelope())?;
    let ciphertext_len =
        u32::try_from(ciphertext.len()).map_err(|_| KeyWrapError::invalid_envelope())?;
    let mut output = Vec::with_capacity(HEADER_BYTES + key_ref.len() + ciphertext.len());
    output.extend_from_slice(MAGIC);
    output.push(ENVELOPE_VERSION);
    output.push(AWS_KMS_SCHEME);
    output.extend_from_slice(&key_ref_len.to_be_bytes());
    output.extend_from_slice(&ciphertext_len.to_be_bytes());
    output.extend_from_slice(key_ref.as_bytes());
    output.extend_from_slice(ciphertext);
    Ok(output)
}

pub(super) fn parse_managed(value: &[u8]) -> Result<ManagedEnvelope<'_>, KeyWrapError> {
    if value.len() < HEADER_BYTES || &value[..MAGIC.len()] != MAGIC {
        return Err(KeyWrapError::invalid_envelope());
    }
    if value[4] != ENVELOPE_VERSION || value[5] != AWS_KMS_SCHEME {
        return Err(KeyWrapError::unsupported_envelope());
    }
    let key_ref_len = usize::from(u16::from_be_bytes([value[6], value[7]]));
    let ciphertext_len = usize::try_from(u32::from_be_bytes([
        value[8], value[9], value[10], value[11],
    ]))
    .map_err(|_| KeyWrapError::invalid_envelope())?;
    if key_ref_len == 0
        || key_ref_len > MAX_KEY_REF_BYTES
        || ciphertext_len == 0
        || ciphertext_len > MAX_CIPHERTEXT_BYTES
        || value.len() != HEADER_BYTES + key_ref_len + ciphertext_len
    {
        return Err(KeyWrapError::invalid_envelope());
    }
    let key_ref_end = HEADER_BYTES + key_ref_len;
    let key_ref = std::str::from_utf8(&value[HEADER_BYTES..key_ref_end])
        .map_err(|_| KeyWrapError::invalid_envelope())?;
    validate_key_ref(key_ref)?;
    Ok(ManagedEnvelope {
        key_ref,
        ciphertext: &value[key_ref_end..],
    })
}

pub(super) fn inspect(value: &[u8]) -> Result<KeyWrapInspection, KeyWrapError> {
    if value.first() == Some(&1) && !value.starts_with(MAGIC) {
        return Ok(KeyWrapInspection::LocalAes256GcmV1);
    }
    let envelope = parse_managed(value)?;
    Ok(KeyWrapInspection::AwsKmsV1 {
        key_ref: envelope.key_ref.to_string(),
    })
}

fn validate_key_ref(value: &str) -> Result<(), KeyWrapError> {
    if value.is_empty()
        || value.len() > MAX_KEY_REF_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
    {
        return Err(KeyWrapError::invalid_envelope());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_bounded_binary_envelope() {
        let encoded = encode_aws_kms(
            "arn:aws:kms:ap-southeast-1:445617516211:key/mrk-example",
            &[7; 64],
        )
        .unwrap();
        let parsed = parse_managed(&encoded).unwrap();
        assert_eq!(
            parsed.key_ref,
            "arn:aws:kms:ap-southeast-1:445617516211:key/mrk-example"
        );
        assert_eq!(parsed.ciphertext, &[7; 64]);
    }

    #[test]
    fn rejects_truncation_trailing_data_and_unknown_versions() {
        let encoded = encode_aws_kms("arn:aws:kms:test:key/mrk-one", &[8; 32]).unwrap();
        for length in 0..encoded.len() {
            assert!(parse_managed(&encoded[..length]).is_err());
        }
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert!(parse_managed(&trailing).is_err());
        let mut unknown_version = encoded.clone();
        unknown_version[4] = 2;
        assert_eq!(
            parse_managed(&unknown_version).unwrap_err().kind,
            super::super::KeyWrapErrorKind::UnsupportedEnvelope
        );
        let mut unknown_scheme = encoded;
        unknown_scheme[5] = 2;
        assert_eq!(
            parse_managed(&unknown_scheme).unwrap_err().kind,
            super::super::KeyWrapErrorKind::UnsupportedEnvelope
        );
    }

    #[test]
    fn rejects_unbounded_or_ambiguous_fields() {
        assert!(encode_aws_kms("", &[1]).is_err());
        assert!(encode_aws_kms(&"a".repeat(MAX_KEY_REF_BYTES + 1), &[1]).is_err());
        assert!(encode_aws_kms("arn:aws:kms:test:key/one", &[]).is_err());
        assert!(
            encode_aws_kms("arn:aws:kms:test:key/one", &[1; MAX_CIPHERTEXT_BYTES + 1]).is_err()
        );
        assert!(encode_aws_kms("arn:aws:kms:test:key/line\nbreak", &[1]).is_err());
    }

    #[test]
    fn distinguishes_only_the_exact_legacy_version_prefix() {
        assert_eq!(
            inspect(&[1, 2, 3]).unwrap(),
            KeyWrapInspection::LocalAes256GcmV1
        );
        assert!(inspect(&[2, 2, 3]).is_err());
    }
}
