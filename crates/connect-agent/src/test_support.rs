use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Duration, SecondsFormat, Utc};
use mdbase_connect_core::CollectionRegistry;
use mdbase_connect_protocol::crypto::RelayIdentity;
use mdbase_connect_protocol::{
    application_installation_id, ApplicationAuthorizationBinding, ApplicationAuthorizationFlow,
    ApplicationAuthorizationProof, ApplicationFileRequirement, ApplicationTrustPresentation,
    ApplicationTrustRequest, FileCapability, FirstContactBinding, FIRST_CONTACT_PROTOCOL_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use uuid::Uuid;

pub(crate) struct TestApplicationSecurity {
    pub authorization_id: Uuid,
    pub first_contact: FirstContactBinding,
    pub proof: ApplicationAuthorizationProof,
}

pub(crate) struct TestApplicationSecurityParams<'a> {
    pub application_id: Uuid,
    pub authorization_id: Uuid,
    pub collection_id: Uuid,
    pub operations: &'a [String],
    pub distribution: &'a str,
    pub connector_id: Uuid,
    pub connector_identity: &'a RelayIdentity,
    pub grant_agreement_public_key: String,
    pub file_capability: Option<&'a FileCapability>,
}

pub(crate) fn application_security(
    params: TestApplicationSecurityParams<'_>,
) -> TestApplicationSecurity {
    let TestApplicationSecurityParams {
        application_id,
        authorization_id,
        collection_id,
        operations,
        distribution,
        connector_id,
        connector_identity,
        grant_agreement_public_key,
        file_capability,
    } = params;
    let installation_agreement = RelayIdentity::generate();
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
    let binding = ApplicationAuthorizationBinding {
        protocol_version: FIRST_CONTACT_PROTOCOL_VERSION,
        authorization_id,
        application_id,
        application_manifest_digest: "00".repeat(32),
        application_installation_id: application_installation_id(
            &installation_agreement.public_key(),
            &installation_signing_public_key,
        )
        .unwrap(),
        installation_agreement_public_key: installation_agreement.public_key(),
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
        requested_operations: operations.to_vec(),
        requested_files: file_capability.map(|capability| ApplicationFileRequirement {
            actions: capability.actions.clone(),
            scope: capability.scope.clone(),
        }),
        collection_id: Some(collection_id),
    };
    let signature: Signature = installation_signing.sign(&binding.signing_message().unwrap());
    let signature = signature.normalize_s().unwrap_or(signature);
    let proof = ApplicationAuthorizationProof {
        binding: binding.clone(),
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    proof.verify().unwrap();
    TestApplicationSecurity {
        authorization_id,
        first_contact: FirstContactBinding {
            protocol_version: FIRST_CONTACT_PROTOCOL_VERSION,
            application_id,
            application_installation_id: binding.application_installation_id,
            application_agreement_public_key: binding.installation_agreement_public_key,
            application_signing_public_key: installation_signing_public_key,
            connector_id,
            connector_agreement_public_key: connector_identity.public_key(),
        },
        proof,
    }
}

pub(crate) fn trust_application(
    registry: &CollectionRegistry,
    security: &TestApplicationSecurity,
    distribution: &str,
) {
    let request = ApplicationTrustRequest {
        request_id: security.authorization_id,
        binding: security.first_contact.clone(),
        presentation: ApplicationTrustPresentation {
            application_name: "Test application".to_string(),
            application_distribution: distribution.to_string(),
            application_homepage: "https://app.example".to_string(),
            application_project_url: (distribution == "portable")
                .then(|| "https://app.example/project".to_string()),
            application_icon: None,
        },
        created_at: security.proof.binding.issued_at.clone(),
        expires_at: security.proof.binding.expires_at.clone(),
    };
    registry.record_application_trust_request(&request).unwrap();
    registry
        .accept_application_trust(request.request_id)
        .unwrap();
}
