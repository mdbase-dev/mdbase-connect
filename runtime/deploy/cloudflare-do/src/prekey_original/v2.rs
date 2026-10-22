//! Private v2 DATA/crypto primitives. Neither a caller DTO nor serving authority.
//! The enclosing CLOSED producer still refuses until the external time/floor/drain
//! bridge qualifies. No SQL, config(), clocks, entropy or secret export here.

use mdbn_log_service::auth::{self, NonceCache, Principal, VerifiedCaller, VerifiedToken};
use mdbn_log_service::decode::Budget;
use mdbn_log_service::model::unhex;
use mdbn_log_service::policy::{OriginalCaller, OriginalPins, bind_original_caller, key_id};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::log_service::LsFrame;
use mdbn_wire::policy::CpCert;
use mdbn_wire::schema::Wire;

pub(super) const BODY_CAP: usize = 128 * 1024;
pub(super) const ENVELOPE_CAP: usize = 4096;
const CLAIMS_CAP: usize = 2048;
const BEGIN_CAP: usize = 128;
const MAX_SAFE: u64 = (1 << 53) - 1;
const MAX_SKEW_MS: i64 = 5000;
const DOMAIN: &str = "mdbase/v2/prekey-original-admission";

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Refused;
type Result<T> = std::result::Result<T, Refused>;

/// Owned native-only authenticated input. No serialization/constructor from JS.
pub(super) struct Authenticated {
    caller: VerifiedCaller,
    nonce: [u8; 32],
    transcript: B32,
    collection: B16,
    genesis: Vec<u8>,
    budget: Budget,
}

pub(super) struct HttpProof<'a> {
    pub token: &'a str,
    pub nonce: &'a str,
    pub signature: &'a str,
    pub path: &'a str,
}

pub(super) fn preflight(
    token: &str,
    issuers: &[B32],
    now: i64,
    budget: &Budget,
) -> Result<VerifiedToken> {
    if now < 0
        || now as u64 > MAX_SAFE
        || token.is_empty()
        || token.len() > 16 * 1024
        || issuers.is_empty()
        || issuers.len() > 2
    {
        return Err(Refused);
    }
    auth::verify_issuer_token_with_budget(token, issuers, now, budget).map_err(|_| Refused)
}

pub(super) struct VerifyInputs<'a> {
    pub verified: &'a VerifiedToken,
    pub secret: &'a [u8],
    pub seen: &'a NonceCache,
    pub now: i64,
    pub collection: B16,
    pub budget: Budget,
}

pub(super) fn authenticate(
    proof: HttpProof<'_>,
    body: &[u8],
    inputs: VerifyInputs<'_>,
) -> Result<Authenticated> {
    let VerifyInputs {
        verified,
        secret,
        seen,
        now,
        collection,
        budget,
    } = inputs;
    if now < 0
        || now as u64 > MAX_SAFE
        || proof.path != "/v1/rpc"
        || body.len() > BODY_CAP
        || secret.len() != 32
        || collection.0 == [0; 16]
    {
        return Err(Refused);
    }
    let nonce: [u8; 32] = unhex(proof.nonce)
        .and_then(|v| v.try_into().ok())
        .ok_or(Refused)?;
    nonce_time(&nonce)?; // Refuse unsafe unsigned timestamps before the existing verifier's i64 cast.
    let LsFrame::Request(request) = budget.wire::<LsFrame>(body).map_err(|_| Refused)? else {
        return Err(Refused);
    };
    if request.method != "create_log" {
        return Err(Refused);
    }
    let Cbor::Map(params) = &request.params else {
        return Err(Refused);
    };
    if params.len() != 2 || params[0] != (Cbor::Uint(0), Cbor::Bytes(collection.0.to_vec())) {
        return Err(Refused);
    }
    let (Cbor::Uint(1), Cbor::Bytes(genesis)) = &params[1] else {
        return Err(Refused);
    };
    if genesis.is_empty() || genesis.len() > 65536 {
        return Err(Refused);
    }
    let caller = auth::verify_http_verified_token(
        proof.token,
        proof.nonce,
        proof.signature,
        proof.path,
        &request.method,
        body,
        &collection.0,
        verified,
        secret,
        seen,
        now,
    )
    .map_err(|_| Refused)?;
    // Do not erase device kind/UUID into a CP principal or trust a body role.
    if caller.principal() != Principal::ControlPlane {
        return Err(Refused);
    }
    let transcript = auth::http_digest(
        &nonce,
        proof.path,
        &collection.0,
        proof.token,
        &request.method,
        body,
    );
    Ok(Authenticated {
        caller,
        nonce,
        transcript,
        collection,
        genesis: genesis.clone(),
        budget,
    })
}

fn nonce_time(nonce: &[u8; 32]) -> Result<i64> {
    let time = u64::from_be_bytes(nonce[..8].try_into().map_err(|_| Refused)?);
    if time > MAX_SAFE {
        return Err(Refused);
    }
    Ok(time as i64)
}

impl Authenticated {
    /// Non-consuming expiry recheck at authenticated CP time, NOT a receive-clock
    /// bridge. Never rerun first_use or create a replacement NonceCache here.
    fn fresh_at(&self, now: i64) -> Result<()> {
        let issued = nonce_time(&self.nonce)?;
        if now < 0
            || now as u64 > MAX_SAFE
            || self.caller.expires_at() <= now
            || now - issued > auth::HTTP_NONCE_TTL_MS
            || issued > now + MAX_SKEW_MS
        {
            return Err(Refused);
        }
        Ok(())
    }

    pub(super) fn begin_data(&self, handle: u64, challenge: [u8; 32]) -> Result<Vec<u8>> {
        if handle == 0 || handle > MAX_SAFE {
            return Err(Refused);
        }
        let bytes = cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(2),
            Cbor::Uint(handle),
            Cbor::Bytes(challenge.to_vec()),
            Cbor::Bytes(self.nonce.to_vec()),
            Cbor::Bytes(self.transcript.0.to_vec()),
        ]))
        .map_err(|_| Refused)?;
        if bytes.len() > BEGIN_CAP {
            return Err(Refused);
        }
        Ok(bytes)
    }

    /// Verify committed CP statement DATA and unchanged original binder. The
    /// caller still owes physical/wake/phase/receive-time/floor/current checks.
    /// Returning this historical binding does NOT release a positive witness.
    pub(super) fn admission(
        &self,
        envelope: &[u8],
        roots: &[B32],
        audience: &str,
        run: &str,
        challenge: &[u8; 32],
    ) -> Result<OriginalCaller> {
        if envelope.is_empty() || envelope.len() > ENVELOPE_CAP {
            return Err(Refused);
        }
        let outer = self.budget.raw(envelope).map_err(|_| Refused)?;
        let Cbor::Array(outer) = outer else {
            return Err(Refused);
        };
        let [
            Cbor::Uint(2),
            Cbor::Bytes(raw),
            cert_value,
            Cbor::Bytes(signature),
        ] = outer.as_slice()
        else {
            return Err(Refused);
        };
        if raw.is_empty() || raw.len() > CLAIMS_CAP || signature.len() != 64 {
            return Err(Refused);
        }
        let cert = CpCert::from_cbor(cert_value).map_err(|_| Refused)?;
        // Wire structs normally ignore unknown fields; this envelope is strict.
        if cert.to_cbor() != *cert_value
            || cert.policy_pk.0 == [0; 32]
            || cert.not_before < 0
            || cert.not_after < cert.not_before
        {
            return Err(Refused);
        }
        // Independent configured root BEFORE decoding any body-provided pins.
        let root = roots
            .iter()
            .find(|root| key_id(root) == cert.root)
            .ok_or(Refused)?;
        let digest = cert.signed_digest().map_err(|_| Refused)?;
        if !auth::verify_sig(&root.0, &digest.0, &cert.sig.0) {
            return Err(Refused);
        }
        let sig: [u8; 64] = signature.as_slice().try_into().map_err(|_| Refused)?;
        if !auth::verify_sig(&cert.policy_pk.0, &h(DOMAIN, raw).0, &sig) {
            return Err(Refused);
        }
        let claims = self.budget.raw(raw).map_err(|_| Refused)?;
        let Cbor::Array(claims) = claims else {
            return Err(Refused);
        };
        if claims.len() != 19
            || claims[0] != Cbor::Uint(2)
            || claims[1] != Cbor::Text(audience.into())
            || claims[2] != Cbor::Text(run.into())
            || claims[3] != Cbor::Text("original-caller-prekey".into())
            || claims[10] != Cbor::Uint(1)
            || claims[11..14] != [Cbor::Null, Cbor::Null, Cbor::Null]
        {
            return Err(Refused);
        }
        let collection = B16(fixed(&claims[4])?);
        let owner = B16(fixed(&claims[5])?);
        let root_pk = B32(fixed(&claims[6])?);
        let issuer_pk = B32(fixed(&claims[7])?);
        let transport_pk = B32(fixed(&claims[8])?);
        let genesis_sha256 = B32(fixed(&claims[9])?);
        let issued = timestamp(&claims[15])?;
        let expires = timestamp(&claims[16])?;
        if collection != self.collection
            || collection.0 == [0; 16]
            || owner.0 == [0; 16]
            || root_pk != *root
            || issuer_pk != self.caller.issuer_key()
            || transport_pk != self.caller.transport_key()
            || genesis_sha256 != sha256(&self.genesis)
            || fixed::<32>(&claims[14])? != *challenge
            || fixed::<32>(&claims[17])? != self.nonce
            || B32(fixed(&claims[18])?) != self.transcript
            || issued < cert.not_before
            || expires > cert.not_after
            || expires <= issued
            || expires - issued > 10_000
        {
            return Err(Refused);
        }
        self.fresh_at(issued)?;
        let pins = OriginalPins {
            collection,
            owner,
            root_pk,
            issuer_pk,
            transport_pk,
            genesis_sha256,
            enrollment_sha256: None,
            enrollment_seq: None,
        };
        bind_original_caller(
            &self.caller,
            &pins,
            &self.genesis,
            None,
            issued,
            &self.budget,
        )
        .map_err(|_| Refused)
    }
}

fn fixed<const N: usize>(value: &Cbor) -> Result<[u8; N]> {
    let Cbor::Bytes(bytes) = value else {
        return Err(Refused);
    };
    bytes.as_slice().try_into().map_err(|_| Refused)
}
fn timestamp(value: &Cbor) -> Result<i64> {
    let Cbor::Uint(value) = value else {
        return Err(Refused);
    };
    if *value > MAX_SAFE {
        return Err(Refused);
    }
    Ok(*value as i64)
}

#[cfg(test)]
mod tests;
