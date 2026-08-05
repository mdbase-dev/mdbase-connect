use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Duration, SecondsFormat, Utc};
use mdbase_connect_protocol::{
    application_installation_id, authorization_requires_durable_mutation,
    ApplicationAuthorizationBinding, ApplicationAuthorizationFlow, ApplicationAuthorizationProof,
    ApplicationFileRequirement, ConnectContractRequirements, FileCapability,
    APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use uuid::Uuid;

pub(crate) struct TestApplicationSecurity {
    pub proof: ApplicationAuthorizationProof,
}

pub(crate) struct TestApplicationSecurityParams<'a> {
    pub application_id: Uuid,
    pub authorization_id: Uuid,
    pub collection_id: Uuid,
    pub operations: &'a [String],
    pub distribution: &'a str,
    pub grant_agreement_public_key: String,
    pub file_capability: Option<&'a FileCapability>,
}

pub(crate) fn application_security(
    params: TestApplicationSecurityParams<'_>,
) -> TestApplicationSecurity {
    application_security_with_contracts(params, None)
}

pub(crate) fn application_security_with_contracts(
    params: TestApplicationSecurityParams<'_>,
    contracts: Option<ConnectContractRequirements>,
) -> TestApplicationSecurity {
    let TestApplicationSecurityParams {
        application_id,
        authorization_id,
        collection_id,
        operations,
        distribution,
        grant_agreement_public_key,
        file_capability,
    } = params;
    let installation_signing = SigningKey::random(&mut rand_core::OsRng);
    let grant_signing = SigningKey::random(&mut rand_core::OsRng);
    let installation_signing_public_key = URL_SAFE_NO_PAD.encode(
        installation_signing
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    let grant_signing_public_key = URL_SAFE_NO_PAD.encode(
        grant_signing
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    let issued_at = Utc::now();
    let flow = if distribution == "portable" {
        ApplicationAuthorizationFlow::DeviceCode
    } else {
        ApplicationAuthorizationFlow::AuthorizationCode
    };
    let requested_files = file_capability.map(|capability| ApplicationFileRequirement {
        actions: capability.actions.clone(),
        scope: capability.scope.clone(),
    });
    let binding = ApplicationAuthorizationBinding {
        protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
        authorization_id,
        application_id,
        application_manifest_digest: "00".repeat(32),
        application_installation_id: application_installation_id(&installation_signing_public_key)
            .unwrap(),
        installation_signing_public_key: installation_signing_public_key.clone(),
        grant_agreement_public_key,
        grant_signing_public_key,
        flow,
        authorization_nonce: URL_SAFE_NO_PAD.encode([7_u8; 32]),
        issued_at: issued_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: (issued_at + Duration::minutes(10))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        redirect_uri: (distribution != "portable")
            .then(|| "https://app.example/callback".to_string()),
        state: (distribution != "portable").then(|| "test-state".to_string()),
        code_challenge: URL_SAFE_NO_PAD.encode([8_u8; 32]),
        contracts: contracts.unwrap_or_else(|| {
            ConnectContractRequirements::current(authorization_requires_durable_mutation(
                operations,
                requested_files.as_ref(),
            ))
        }),
        requested_operations: operations.to_vec(),
        requested_files,
        collection_id: Some(collection_id),
    };
    let signature: Signature = installation_signing.sign(&binding.signing_message().unwrap());
    let signature = signature.normalize_s().unwrap_or(signature);
    let proof = ApplicationAuthorizationProof {
        binding: binding.clone(),
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    proof.verify().unwrap();
    TestApplicationSecurity { proof }
}
