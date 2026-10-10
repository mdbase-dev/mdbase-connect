//! Principals and authentication (`log-service-api.md` §3).
//!
//! **Token format (evaluation stand-in).** The control plane's access token is not
//! specified yet. This crate uses a minimal signed token with the properties §3
//! requires: short-lived, audience-bound, naming the subject and bound to the
//! device's signing key, so that proof of possession can be checked:
//!
//! ```text
//! token = hex(claims) "." hex(Ed25519(issuer, H("mdbase/v1/ls-token", claims)))
//! claims = mdb-cbor/1 { 0: role (0 device, 1 control plane), ? 1: device uuid,
//!                       2: sign_pk, 3: expires_at ms, 4: "mdbase-log",
//!                       ? 5: collection uuid }
//! ```
//!
//! Proof of possession is exactly §3: Ed25519 by `sign_pk` over
//! `H("mdbase/v1/ls-hello", server_nonce ‖ token)`. The control plane
//! uses the same mechanism here instead of mTLS.

use ed25519_dalek::{Signature, VerifyingKey};
use hmac::{Hmac, Mac};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::log_service::LsHelloParams;
use sha2::Sha256;

use crate::error::{Code, Result, ServiceError};
use crate::model::unhex;

/// Who is calling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// An enrolled device, holding the key `sign_pk`.
    Device {
        /// Device ID.
        id: Uuid,
        /// The key its token is bound to.
        sign_pk: B32,
        /// The collection the token is scoped to, if any (claim 5): requests naming
        /// another collection are refused (`forbidden`, reason `token_collection`).
        collection: Option<Uuid>,
    },
    /// The control plane.
    ControlPlane,
}

/// Token audience.
pub const AUDIENCE: &str = "mdbase-log";

/// Verify an Ed25519 signature strictly (`sealed-envelope.md` §6: `verify_strict`).
pub fn verify_sig(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    vk.verify_strict(msg, &Signature::from_bytes(sig)).is_ok()
}

/// Token claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// Control plane (true) or device.
    pub control_plane: bool,
    /// Device ID (devices only).
    pub device: Option<Uuid>,
    /// Key the token is bound to.
    pub sign_pk: B32,
    /// Expiry, ms.
    pub expires_at: i64,
    /// Scope to one collection (claim 5).
    pub collection: Option<Uuid>,
}

impl Claims {
    /// Canonical claim bytes.
    pub fn encode(&self) -> Vec<u8> {
        let mut m = vec![(Cbor::Uint(0), Cbor::Uint(self.control_plane as u64))];
        if let Some(d) = self.device {
            m.push((Cbor::Uint(1), Cbor::Bytes(d.0.to_vec())));
        }
        m.push((Cbor::Uint(2), Cbor::Bytes(self.sign_pk.0.to_vec())));
        m.push((Cbor::Uint(3), Cbor::int(self.expires_at)));
        m.push((Cbor::Uint(4), Cbor::Text(AUDIENCE.into())));
        if let Some(c) = self.collection {
            m.push((Cbor::Uint(5), Cbor::Bytes(c.0.to_vec())));
        }
        cbor::encode(&Cbor::Map(m)).expect("claims encode")
    }

    fn decode(value: Cbor) -> Option<Claims> {
        let Cbor::Map(m) = value else {
            return None;
        };
        let get = |k: u64| {
            m.iter()
                .find(|(kk, _)| *kk == Cbor::Uint(k))
                .map(|(_, v)| v)
        };
        let role = match get(0)? {
            Cbor::Uint(r) => *r,
            _ => return None,
        };
        let device = match get(1) {
            Some(Cbor::Bytes(x)) => Some(B16(x.as_slice().try_into().ok()?)),
            None => None,
            _ => return None,
        };
        let sign_pk = match get(2)? {
            Cbor::Bytes(x) => B32(x.as_slice().try_into().ok()?),
            _ => return None,
        };
        let expires_at = get(3)?.as_i64()?;
        if get(4)? != &Cbor::Text(AUDIENCE.into()) {
            return None;
        }
        let collection = match get(5) {
            Some(Cbor::Bytes(x)) => Some(B16(x.as_slice().try_into().ok()?)),
            None => None,
            _ => return None,
        };
        Some(Claims {
            control_plane: role == 1,
            device,
            sign_pk,
            expires_at,
            collection,
        })
    }
}

/// The digest the token issuer signs.
pub fn token_digest(claims: &[u8]) -> B32 {
    h("mdbase/v1/ls-token", claims)
}

/// The digest a device signs to prove possession at `hello`.
/// `H("mdbase/v1/ls-hello", server_nonce ‖ token)` (§3).
pub fn hello_digest(server_nonce: &[u8; 32], token: &str) -> B32 {
    let mut m = server_nonce.to_vec();
    m.extend_from_slice(token.as_bytes());
    h("mdbase/v1/ls-hello", &m)
}

/// The digest signed for a plain HTTPS request.
///
/// `H("mdbase/v1/ls-http", method ‖ 0x00 ‖ path ‖ 0x00 ‖ collection ‖ SHA-256(token)
/// ‖ SHA-256(body) ‖ nonce)` (§3). `collection` is the request's params key 0
/// (16 zero bytes when absent).
pub fn http_digest(
    nonce: &[u8; 32],
    path: &str,
    collection: &[u8; 16],
    token: &str,
    method: &str,
    body: &[u8],
) -> B32 {
    let mut m = method.as_bytes().to_vec();
    m.push(0);
    m.extend_from_slice(path.as_bytes());
    m.push(0);
    m.extend_from_slice(collection);
    m.extend_from_slice(&sha256(token.as_bytes()).0);
    m.extend_from_slice(&sha256(body).0);
    m.extend_from_slice(nonce);
    h("mdbase/v1/ls-http", &m)
}

/// The collection a request frame names (params key 0), for [`http_digest`].
pub fn request_collection(body: &[u8]) -> [u8; 16] {
    use mdbn_wire::log_service::LsFrame;
    let Ok(LsFrame::Request(r)) = crate::decode::wire::<LsFrame>(body) else {
        return [0; 16];
    };
    collection_from_params(&r.params)
}

/// Borrow a request's collection without decoding its body again.
pub fn collection_from_params(params: &Cbor) -> [u8; 16] {
    match params {
        Cbor::Map(m) => m
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(0))
            .and_then(|(_, v)| match v {
                Cbor::Bytes(b) => b.as_slice().try_into().ok(),
                _ => None,
            })
            .unwrap_or([0; 16]),
        _ => [0; 16],
    }
}

/// HTTPS nonces are single-use within their 60 s lifetime (per service instance;
/// requests of a collection always reach the same instance).
#[derive(Debug, Default)]
pub struct NonceCache {
    seen: std::sync::Mutex<std::collections::BTreeMap<[u8; 32], i64>>,
}

impl NonceCache {
    /// Record `nonce`; false if it was already used.
    pub fn first_use(&self, nonce: &[u8; 32], now: i64) -> bool {
        let mut s = self.seen.lock().unwrap();
        s.retain(|_, exp| *exp > now);
        s.insert(*nonce, now + HTTP_NONCE_TTL_MS).is_none()
    }
}

/// Lifetime of an HTTPS nonce.
pub const HTTP_NONCE_TTL_MS: i64 = 60_000;

/// Verify a token against a set of issuer keys (current + next, for rotation):
/// issuer signature, audience, expiry.
pub fn verify_token(token: &str, issuers: &[B32], now: i64) -> Result<Claims> {
    verify_token_with_budget(token, issuers, now, &crate::decode::Budget::default())
}

/// Verify claims with the enclosing request's shared decode budget.
pub fn verify_token_with_budget(
    token: &str,
    issuers: &[B32],
    now: i64,
    budget: &crate::decode::Budget,
) -> Result<Claims> {
    let unauth = |why: &str| ServiceError::reason(Code::Unauthenticated, why);
    if token.len() > 16 * 1024 {
        return Err(unauth("token"));
    }
    let (c, s) = token.split_once('.').ok_or_else(|| unauth("token"))?;
    if s.len() != 128 {
        return Err(unauth("token"));
    }
    let claims = unhex(c).ok_or_else(|| unauth("token"))?;
    let sig: [u8; 64] = unhex(s)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| unauth("token"))?;
    let digest = token_digest(&claims);
    if !issuers.iter().any(|pk| verify_sig(&pk.0, &digest.0, &sig)) {
        return Err(unauth("token_signature"));
    }
    let claims = Claims::decode(budget.raw(&claims)?).ok_or_else(|| unauth("token"))?;
    if claims.expires_at <= now {
        return Err(unauth("expired"));
    }
    if claims.control_plane == claims.device.is_some() {
        return Err(unauth("token"));
    }
    Ok(claims)
}

fn principal_of(claims: &Claims) -> Principal {
    match claims.device {
        Some(id) => Principal::Device {
            id,
            sign_pk: claims.sign_pk,
            collection: claims.collection,
        },
        None => Principal::ControlPlane,
    }
}

/// Verify `hello` (§3): token plus proof of possession over the server nonce.
pub fn verify_hello(
    p: &LsHelloParams,
    server_nonce: &[u8; 32],
    issuers: &[B32],
    now: i64,
) -> Result<Principal> {
    verify_hello_with_budget(
        p,
        server_nonce,
        issuers,
        now,
        &crate::decode::Budget::default(),
    )
}

/// Verify hello with the budget used to decode its enclosing frame.
pub fn verify_hello_with_budget(
    p: &LsHelloParams,
    server_nonce: &[u8; 32],
    issuers: &[B32],
    now: i64,
    budget: &crate::decode::Budget,
) -> Result<Principal> {
    if p.version.major != 1 {
        return Err(ServiceError::new(Code::UpgradeRequired));
    }
    let claims = verify_token_with_budget(&p.token, issuers, now, budget)?;
    if claims.device != p.device {
        return Err(ServiceError::reason(Code::Unauthenticated, "device"));
    }
    if !verify_sig(
        &claims.sign_pk.0,
        &hello_digest(server_nonce, &p.token).0,
        &p.sig.0,
    ) {
        return Err(ServiceError::reason(Code::Unauthenticated, "possession"));
    }
    Ok(principal_of(&claims))
}

type HmacSha256 = Hmac<Sha256>;

/// HMAC-SHA256.
pub fn hmac(secret: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut m = HmacSha256::new_from_slice(secret).expect("any key length");
    m.update(msg);
    m.finalize().into_bytes().into()
}

/// A stateless nonce for plain HTTPS:
/// `u64be(ms) ‖ random(8) ‖ HMAC(secret, ms ‖ random)[..16]`.
///
/// `random` comes from the host's CSPRNG. Without it, every nonce issued in the
/// same millisecond was identical, and the single-use check rejected all but the
/// first request that used it.
pub fn http_nonce(secret: &[u8], now: i64, random: [u8; 8]) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[..8].copy_from_slice(&(now as u64).to_be_bytes());
    n[8..16].copy_from_slice(&random);
    let mac = hmac(secret, &n[..16]);
    n[16..].copy_from_slice(&mac[..16]);
    n
}

/// Verify a plain HTTPS request (§3): token, a fresh nonce (≤ 5 minutes) and a
/// signature over the method and body hash.
pub fn verify_http(
    token: &str,
    nonce_hex: &str,
    sig_hex: &str,
    path: &str,
    method: &str,
    body: &[u8],
    issuers: &[B32],
    secret: &[u8],
    seen: &NonceCache,
    now: i64,
) -> Result<Principal> {
    let budget = crate::decode::Budget::default();
    let claims = verify_token_with_budget(token, issuers, now, &budget)?;
    // This standalone authentication helper historically uses zero collection
    // for non-request bodies; dispatchers separately require an ls-request.
    // Preserve that behavior, but never hide an exhausted resource budget.
    let collection = match budget.wire::<mdbn_wire::log_service::LsFrame>(body) {
        Ok(mdbn_wire::log_service::LsFrame::Request(request)) => {
            collection_from_params(&request.params)
        }
        Err(e) if crate::decode::is_resource_refusal(&e) => {
            return Err(e);
        }
        _ => [0; 16],
    };
    verify_http_claims(
        token,
        nonce_hex,
        sig_hex,
        path,
        method,
        body,
        &collection,
        &claims,
        secret,
        seen,
        now,
    )
}

/// Check possession/replay using already issuer-verified claims and a collection
/// borrowed from the already budgeted request. Callers MUST verify the issuer
/// with `verify_token_with_budget`; this function does not confer issuer trust.
pub fn verify_http_claims(
    token: &str,
    nonce_hex: &str,
    sig_hex: &str,
    path: &str,
    method: &str,
    body: &[u8],
    collection: &[u8; 16],
    claims: &Claims,
    secret: &[u8],
    seen: &NonceCache,
    now: i64,
) -> Result<Principal> {
    let unauth = |why: &str| ServiceError::reason(Code::Unauthenticated, why);
    if claims.expires_at <= now {
        return Err(unauth("expired"));
    }
    let nonce: [u8; 32] = unhex(nonce_hex)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| unauth("nonce"))?;
    let ts = u64::from_be_bytes(nonce[..8].try_into().unwrap()) as i64;
    if !crate::service::ct_eq(&hmac(secret, &nonce[..16])[..16], &nonce[16..])
        || now - ts > HTTP_NONCE_TTL_MS
        || ts > now + 5_000
    {
        return Err(unauth("nonce"));
    }
    let sig: [u8; 64] = unhex(sig_hex)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| unauth("possession"))?;
    if !verify_sig(
        &claims.sign_pk.0,
        &http_digest(&nonce, path, collection, token, method, body).0,
        &sig,
    ) {
        return Err(unauth("possession"));
    }
    if !seen.first_use(&nonce, now) {
        return Err(unauth("replay"));
    }
    Ok(principal_of(claims))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{ControlPlane, Device};

    #[test]
    fn public_http_head_interop_vector() {
        use ed25519_dalek::{Signer, SigningKey};
        let body = unhex("a40000010102646865616403a1005022222222222222222222222222222222").unwrap();
        let nonce = [0x11; 32];
        let collection = [0x22; 16];
        let token = "public-fixture-token";
        assert_eq!(request_collection(&body), collection);
        let digest = http_digest(&nonce, "/v1/rpc", &collection, token, "head", &body);
        assert_eq!(
            digest.to_hex(),
            "754b42cd0f5ffd33c1a5a25fc6b65bfe3d6dbe6f712ae38561fcfad7421c7bdb"
        );
        let key = SigningKey::from_bytes(&[0x33; 32]); // Public fixture only.
        assert_eq!(
            mdbn_wire::render::hex(key.verifying_key().as_bytes()),
            "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce"
        );
        let sig = key.sign(&digest.0).to_bytes();
        assert_eq!(
            mdbn_wire::render::hex(&sig),
            "3920af542e0d7ea4bf756f8aed0d7c71c4e84d22812a40a4004528798f3ba46f58f14b7b4562383e8240964aceabb42aadad596cce36c5414f7dfb9fbe529a03"
        );
        assert!(verify_sig(key.verifying_key().as_bytes(), &digest.0, &sig));
        for changed in [
            http_digest(&[0x12; 32], "/v1/rpc", &collection, token, "head", &body),
            http_digest(&nonce, "/v1/other", &collection, token, "head", &body),
            http_digest(&nonce, "/v1/rpc", &[0x23; 16], token, "head", &body),
            http_digest(
                &nonce,
                "/v1/rpc",
                &collection,
                "different-token",
                "head",
                &body,
            ),
            http_digest(&nonce, "/v1/rpc", &collection, token, "POST", &body),
            http_digest(&nonce, "/v1/rpc", &collection, token, "head", &[0xf6]),
        ] {
            assert!(!verify_sig(
                key.verifying_key().as_bytes(),
                &changed.0,
                &sig
            ));
        }
    }

    #[test]
    fn issuer_set_and_collection_claim() {
        let cur = ControlPlane::new("current");
        let next = ControlPlane::new("next");
        let d = Device::new("d", B16([1; 16]));
        let c = B16([9; 16]);
        let t = next.device_token_for(&d, 10_000, Some(c));
        // Rotation: accepted while either key is in the set.
        let claims = verify_token(&t, &[cur.issuer_pk(), next.issuer_pk()], 0).unwrap();
        assert_eq!(claims.collection, Some(c));
        assert!(verify_token(&t, &[cur.issuer_pk()], 0).is_err());
        assert!(
            verify_token(&t, &[next.issuer_pk()], 10_000).is_err(),
            "expired"
        );
    }

    fn check(
        n: &[u8; 32],
        d: &Device,
        cp: &ControlPlane,
        token: &str,
        secret: &[u8],
        seen: &NonceCache,
        now: i64,
    ) -> Result<Principal> {
        let body = b"frame";
        let sig = d.http_sig(n, "/v1/rpc", token, "head", body);
        verify_http(
            token,
            &mdbn_wire::render::hex(n),
            &mdbn_wire::render::hex(&sig.0),
            "/v1/rpc",
            "head",
            body,
            &[cp.issuer_pk()],
            secret,
            seen,
            now,
        )
    }

    /// Two requests whose nonces were issued in the same millisecond are both
    /// accepted; each nonce stays single-use, and the random part is MAC-bound.
    #[test]
    fn nonces_in_the_same_millisecond_are_distinct() {
        let cp = ControlPlane::new("cp");
        let d = Device::new("d", B16([1; 16]));
        let secret = [7u8; 32];
        let now = 1_000_000;
        let token = cp.device_token(&d, now + 60_000);
        let seen = NonceCache::default();
        let n1 = http_nonce(&secret, now, [1; 8]);
        let n2 = http_nonce(&secret, now, [2; 8]);
        assert_ne!(n1, n2);
        assert!(check(&n1, &d, &cp, &token, &secret, &seen, now).is_ok());
        assert!(check(&n2, &d, &cp, &token, &secret, &seen, now).is_ok());
        assert!(
            check(&n1, &d, &cp, &token, &secret, &seen, now).is_err(),
            "replay"
        );
        let mut forged = n1;
        forged[9] ^= 1;
        assert!(
            check(
                &forged,
                &d,
                &cp,
                &token,
                &secret,
                &NonceCache::default(),
                now
            )
            .is_err(),
            "forged"
        );
    }
}
