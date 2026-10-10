//! Possession proof for the log Worker's HTTP RPC (`POST /v1/rpc`, logsvc spec
//! `ls-http`, Connect #625/#614): the hosted service device signs one transcript
//! per request with its enrolled signing key. The key never leaves this crate; the
//! signer signs only this domain.
//!
//! ```text
//! m = UTF8(method) || 00 || "/v1/rpc" || 00 || params_key_0 (16 bytes or zeros)
//!     || SHA256(UTF8(bearer token)) || SHA256(exact request body) || nonce (32)
//! digest = SHA256(u8(17) || "mdbase/v1/ls-http" || m)
//! ```

use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_wire::hash::sha256;

const DOMAIN: &[u8] = b"mdbase/v1/ls-http";
const PATH: &[u8] = b"/v1/rpc";

/// The transcript digest.
pub fn digest(
    method: &str,
    params_key_0: Option<[u8; 16]>,
    token: &str,
    body: &[u8],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut m = Vec::with_capacity(method.len() + PATH.len() + 2 + 16 + 32 * 3);
    m.extend_from_slice(method.as_bytes());
    m.push(0);
    m.extend_from_slice(PATH);
    m.push(0);
    m.extend_from_slice(&params_key_0.unwrap_or([0; 16]));
    m.extend_from_slice(&sha256(token.as_bytes()).0);
    m.extend_from_slice(&sha256(body).0);
    m.extend_from_slice(nonce);
    let mut pre = Vec::with_capacity(1 + DOMAIN.len() + m.len());
    pre.push(DOMAIN.len() as u8);
    pre.extend_from_slice(DOMAIN);
    pre.extend_from_slice(&m);
    sha256(&pre).0
}

/// Signs `ls-http` transcripts with the service device's signing key.
pub struct LogHttpSigner(DeviceSigner);

impl std::fmt::Debug for LogHttpSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogHttpSigner(..)")
    }
}

impl LogHttpSigner {
    /// From the device's signing seed (RAM only; the signer zeroizes on drop).
    pub fn new(sign_seed: &[u8; 32]) -> LogHttpSigner {
        LogHttpSigner(DeviceSigner::from_seed(sign_seed))
    }

    /// The signature for one request. Refuses an empty token or method.
    pub fn sign(
        &self,
        method: &str,
        params_key_0: Option<[u8; 16]>,
        token: &str,
        body: &[u8],
        nonce: &[u8; 32],
    ) -> Option<[u8; 64]> {
        if method.is_empty() || token.is_empty() || method.len() > 64 || token.len() > 16 << 10 {
            return None;
        }
        Some(
            self.0
                .sign_digest(&digest(method, params_key_0, token, body, nonce)),
        )
    }

    /// The public key (to check against the enrolled `sign_pk`).
    pub fn public(&self) -> [u8; 32] {
        self.0.public()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Public, non-operational LS HTTP fixture: digest, public key and signature
    /// must match exactly. No endpoint or credential material is used.
    #[test]
    fn public_ls_http_vector() {
        let body = hex("a40000010102646865616403a1005022222222222222222222222222222222");
        let nonce: [u8; 32] = [0x11; 32];
        let key0 = Some([0x22; 16]);
        let d = digest("head", key0, "public-fixture-token", &body, &nonce);
        assert_eq!(
            d.to_vec(),
            hex("754b42cd0f5ffd33c1a5a25fc6b65bfe3d6dbe6f712ae38561fcfad7421c7bdb")
        );
        let s = LogHttpSigner::new(&[0x33; 32]);
        assert_eq!(
            s.public().to_vec(),
            hex("17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce")
        );
        let sig = s
            .sign("head", key0, "public-fixture-token", &body, &nonce)
            .unwrap();
        assert_eq!(
            sig.to_vec(),
            hex(
                "3920af542e0d7ea4bf756f8aed0d7c71c4e84d22812a40a4004528798f3ba46f58f14b7b4562383e8240964aceabb42aadad596cce36c5414f7dfb9fbe529a03"
            )
        );
        // Any changed component changes the digest.
        assert_ne!(
            digest("append", key0, "public-fixture-token", &body, &nonce),
            d
        );
        assert_ne!(
            digest("head", None, "public-fixture-token", &body, &nonce),
            d
        );
        assert_ne!(digest("head", key0, "other", &body, &nonce), d);
        assert_ne!(
            digest("head", key0, "public-fixture-token", &body, &[0; 32]),
            d
        );
        assert!(s.sign("head", key0, "", &body, &nonce).is_none());
    }
}
