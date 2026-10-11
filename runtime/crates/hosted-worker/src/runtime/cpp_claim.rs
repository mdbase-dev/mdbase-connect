//! Closed hosted-service CPP read authenticator; no transport or effect permit.
//! Audience provenance is the owned deployment/ControlClient origin at open, not
//! a request, custody record or per-sign argument. The actual host must perform
//! physical VOID checks before/after awaits and before signature invocation/output.

use super::{Engine, ObservedNativeTarget, OpenConfig, OpenFailure};
use mdbn_replica::{Host, HostedProfile, Store, crypto::sign::DeviceSigner};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B32, B64},
    schema::Wire,
};

const DOMAIN: &str = "mdbase/v1/cp-hosted-migration-claim-read";

/// Parsed configuration DATA, not authority. Never decoded from OpenConfig or
/// exposed via ABI; only the future owned deployment configuration bridge may
/// initialize it. This slice supports canonical DNS/IPv4 HTTPS origins only.
pub(crate) struct ConfiguredCppAudience(String);
impl std::fmt::Debug for ConfiguredCppAudience {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConfiguredCppAudience { .. }")
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CppClaimSignRefused;

impl ConfiguredCppAudience {
    // Intentionally not an authenticator or a request-facing setter.
    #[allow(dead_code)] // Owned deployment bridge is not implemented in this slice.
    pub(crate) fn from_owned_origin(origin: &str) -> Result<Self, CppClaimSignRefused> {
        if !canonical_origin(origin) {
            return Err(CppClaimSignRefused);
        }
        Ok(Self(origin.into()))
    }
}

fn canonical_origin(origin: &str) -> bool {
    if origin.len() > 255 || !origin.is_ascii() {
        return false;
    }
    let Some(authority) = origin.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        if p.is_empty()
            || (p.len() > 1 && p.starts_with('0'))
            || !p.bytes().all(|b| b.is_ascii_digit())
        {
            return false;
        }
        let Ok(n) = p.parse::<u16>() else {
            return false;
        };
        if n == 443 {
            return false;
        } // URL.origin omits the default HTTPS port.
    }
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let dns = host.strip_suffix('.').unwrap_or(host);
    let labels: Vec<_> = dns.split('.').collect();
    if labels.iter().any(|s| {
        s.is_empty()
            || s.len() > 63
            || s.starts_with('-')
            || s.ends_with('-')
            || !s
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) {
        return false;
    }
    // WHATWG canonical numeric hosts are full dotted decimal IPv4, not aliases.
    if labels.last().is_some_and(|s| s.starts_with("0x")) {
        return false;
    }
    if labels
        .last()
        .is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit()))
    {
        return host == dns
            && labels.len() == 4
            && labels
                .iter()
                .all(|s| !(s.len() > 1 && s.starts_with('0')) && s.parse::<u8>().is_ok());
    }
    true
}

pub(super) struct CppClaimSigner {
    audience: ConfiguredCppAudience,
    signer: DeviceSigner,
}
impl CppClaimSigner {
    pub(super) fn new(audience: ConfiguredCppAudience, seed: &[u8; 32]) -> Self {
        Self {
            audience,
            signer: DeviceSigner::from_seed(seed),
        }
    }
}

// Private fixed-template encoder, never a signer/message/digest API. Production
// calls below construct all six subject fields from actual native admission.
fn message(
    audience: &ConfiguredCppAudience,
    subject: [Cbor; 6],
    challenge: B32,
) -> Result<Vec<u8>, CppClaimSignRefused> {
    let collection =
        mdbn_wire::common::B16::from_cbor(&subject[0]).map_err(|_| CppClaimSignRefused)?;
    let path = format!(
        "/internal/v1/next/migration/collections/{}/claim/read",
        collection.to_uuid_string()
    );
    let mut fields = vec![
        Cbor::Uint(1),
        Cbor::Text(audience.0.clone()),
        Cbor::Text("POST".into()),
        Cbor::Text(path),
    ];
    fields.extend(subject);
    fields.push(challenge.to_cbor());
    cbor::encode(&Cbor::Array(fields)).map_err(|_| CppClaimSignRefused)
}
fn digest(
    audience: &ConfiguredCppAudience,
    native: &mdbn_replica::VerifiedHostedAdmission,
    challenge: B32,
) -> Result<B32, CppClaimSignRefused> {
    let bytes = message(
        audience,
        [
            native.collection().to_cbor(),
            native.device().to_cbor(),
            native.root_id().to_cbor(),
            native.identity().sign_pk.to_cbor(),
            native.identity().kem_pk.to_cbor(),
            native.noise_pk().to_cbor(),
        ],
        challenge,
    )?;
    Ok(mdbn_wire::hash::h(DOMAIN, &bytes))
}

impl<S: Store> Engine<S> {
    /// Internal once-per-wake configuration seam. Ordinary opens have no signer.
    /// Separate owned host ABI; no request selector, physical permit or H0 authority.
    #[allow(dead_code)] // Native non-WASM lib has no ABI consumer.
    pub(crate) fn open_for_cpp_claim(
        config: OpenConfig,
        store: S,
        host: Host,
        profile: HostedProfile,
        audience: super::ConfiguredCppAudience,
    ) -> Result<Self, OpenFailure> {
        config.validate_public_trust()?;
        let sealer = mdbn_replica::seal::KeyringSealer::new(
            config.cfg.collection,
            config.cfg.device_id,
            &config.secrets.sign_sk,
            &config.secrets.kem_sk,
        );
        let signer = CppClaimSigner::new(audience, &config.secrets.sign_sk);
        Self::open_with_cpp_signer(config, store, Box::new(sealer), host, profile, Some(signer))
    }

    /// Private bridge start: ordinary opens cannot even create a CPP ticket.
    #[allow(dead_code)] // Native non-WASM lib has no ABI consumer.
    pub(crate) fn observe_cpp_claim_target(
        &mut self,
    ) -> Result<ObservedNativeTarget, CppClaimSignRefused> {
        if self.cpp_claim_signer.is_none() {
            return Err(CppClaimSignRefused);
        }
        let observed = self
            .observe_native_target()
            .map_err(|_| CppClaimSignRefused)?;
        if self
            .cpp_claim_signer
            .as_ref()
            .ok_or(CppClaimSignRefused)?
            .signer
            .public()
            != observed.admission().identity().sign_pk.0
        {
            return Err(CppClaimSignRefused);
        }
        Ok(observed)
    }

    /// Authentication DATA only. Only challenge is remote input; all subject,
    /// key, audience/method/path/domain fields are fixed native/configuration data.
    #[allow(dead_code)] // Native non-WASM lib has no ABI consumer.
    pub(crate) fn sign_cpp_claim_challenge(
        &mut self,
        observed: &ObservedNativeTarget,
        challenge: B32,
    ) -> Result<B64, super::CppClaimSignRefused> {
        self.recheck_native_target(observed)
            .map_err(|_| CppClaimSignRefused)?;
        let signer = self.cpp_claim_signer.as_ref().ok_or(CppClaimSignRefused)?;
        if signer.signer.public() != observed.admission().identity().sign_pk.0 {
            return Err(CppClaimSignRefused);
        }
        let hash = digest(&signer.audience, observed.admission(), challenge)?;
        self.recheck_native_target(observed)
            .map_err(|_| CppClaimSignRefused)?;
        let signature = B64(self
            .cpp_claim_signer
            .as_ref()
            .ok_or(CppClaimSignRefused)?
            .signer
            .sign_digest(&hash.0));
        // No awaits; defensive store/read faults or context drift still close output.
        self.recheck_native_target(observed)
            .map_err(|_| CppClaimSignRefused)?;
        Ok(signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hex(s: &str) -> Vec<u8> {
        s.as_bytes()
            .chunks_exact(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn actual_cp_canonical_golden_bytes_digest_and_signature_match() {
        // PUBLIC CP-generated vector e3e0e0c7...16a6d, actual policy-wire.ts
        // encoder/domainHash and Node Ed25519/X25519, not native FULL authority.
        use mdbn_wire::common::B16;
        let audience =
            ConfiguredCppAudience::from_owned_origin("https://connect-lab.mdbase.dev").unwrap();
        let signer = DeviceSigner::from_seed(&[0x43; 32]);
        assert_eq!(
            mdbn_wire::render::hex(&signer.public()),
            "22fc297792f0b6ffc0bfcfdb7edb0c0aa14e025a365ec0e342e86e3829cb74b6"
        );
        let kem = mdbn_noise::public_key(&[0x44; 32]);
        let noise = mdbn_noise::public_key(&[0x47; 32]);
        assert_eq!(
            mdbn_wire::render::hex(&kem),
            "ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b"
        );
        assert_eq!(
            mdbn_wire::render::hex(&noise),
            "603fe5551330bf6d2c174a2736fa2996bf8311a259b38a9ed749425a83562909"
        );
        let encoded = message(
            &audience,
            [
                B16([0x11; 16]).to_cbor(),
                B16([0x12; 16]).to_cbor(),
                B16([0x13; 16]).to_cbor(),
                B32(signer.public()).to_cbor(),
                B32(kem).to_cbor(),
                B32(noise).to_cbor(),
            ],
            B32([0x55; 32]),
        )
        .unwrap();
        assert_eq!(DOMAIN.len(), 40);
        assert_eq!(encoded.len(), 315);
        assert_eq!(
            encoded,
            hex(
                "8b01781e68747470733a2f2f636f6e6e6563742d6c61622e6d64626173652e64657664504f535478572f696e7465726e616c2f76312f6e6578742f6d6967726174696f6e2f636f6c6c656374696f6e732f31313131313131312d313131312d313131312d313131312d3131313131313131313131312f636c61696d2f72656164501111111111111111111111111111111150121212121212121212121212121212125013131313131313131313131313131313582022fc297792f0b6ffc0bfcfdb7edb0c0aa14e025a365ec0e342e86e3829cb74b65820ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b5820603fe5551330bf6d2c174a2736fa2996bf8311a259b38a9ed749425a8356290958205555555555555555555555555555555555555555555555555555555555555555"
            )
        );
        let d = mdbn_wire::hash::h(DOMAIN, &encoded);
        assert_eq!(
            d.to_hex(),
            "eda06dcc1086bb5122cc2bfff22e95a60d098fd181bcb68e85846a32622cffb2"
        );
        let sig = signer.sign_digest(&d.0);
        assert_eq!(
            mdbn_wire::render::hex(&sig),
            "0768981fb641746406ce1e88d24c5173dc52dd452cc3fcb9f62293d1db34605d716bca2968a44435468e530977c68f529f161c9677240db8fdc82ccf236c7602"
        );
        assert!(mdbn_replica::crypto::sign::verify_digest(
            &signer.public(),
            &d.0,
            &sig
        ));
    }
    #[test]
    fn only_bounded_canonical_supported_https_origins() {
        for s in [
            "https://connect-lab.mdbase.dev",
            "https://example.test:8443",
            "https://127.0.0.1",
            "https://localhost",
            "https://example.test.",
        ] {
            assert!(ConfiguredCppAudience::from_owned_origin(s).is_ok(), "{s}");
        }
        for s in [
            "",
            "http://example.test",
            "HTTPS://example.test",
            "https://",
            "https://Example.test",
            "https://a/b",
            "https://a/",
            "https://a?x",
            "https://a#x",
            "https://u:p@a",
            "https://a:443",
            "https://a:0443",
            "https://a:65536",
            "https://a:",
            "https://a\\b",
            "https://a%2fb",
            "https://a\n",
            "https://é.test",
            "https://-a.test",
            "https://a..test",
            "https://123",
            "https://0x7f000001",
            "https://example.0xff",
            "https://127.1",
            "https://127.0.0.01",
            "https://[::1]",
        ] {
            assert_eq!(
                ConfiguredCppAudience::from_owned_origin(s).err(),
                Some(CppClaimSignRefused),
                "{s}"
            );
        }
        let max = format!(
            "https://{}.{}.{}.{}",
            "a".repeat(63),
            "a".repeat(63),
            "a".repeat(63),
            "a".repeat(55)
        );
        assert_eq!(max.len(), 255);
        assert!(ConfiguredCppAudience::from_owned_origin(&max).is_ok());
        assert!(ConfiguredCppAudience::from_owned_origin(&(max + "a")).is_err());
        assert!(
            ConfiguredCppAudience::from_owned_origin(&format!("https://{}", "a".repeat(256)))
                .is_err()
        );
        assert_eq!(
            format!(
                "{:?}",
                ConfiguredCppAudience::from_owned_origin("https://example.test").unwrap()
            ),
            "ConfiguredCppAudience { .. }"
        );
    }
}
