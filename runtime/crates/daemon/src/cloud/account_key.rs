//! AK1 account-key calls, strict mode and their response parsers.

use super::*;

impl Cloud {
    /// A signed account-key request proof (Connect #635): a fresh challenge, then the
    /// device signs the shared [`proof::account_proof_digest`] of `kind`.
    async fn account_proof(
        &self,
        kind: proof::AccountProof,
        connector_id: &str,
        account: &[u8; 16],
        extra: Vec<mdbn_wire::cbor::Cbor>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<([u8; 32], [u8; 64]), CloudError> {
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::account_proof_digest(
            kind,
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*account),
            extra,
        );
        let sig = identity.sign_digest(&digest.0);
        Ok((challenge, sig))
    }

    /// AK1: this account's account-key record (`GET /v1/next/account-key`, proof in
    /// headers). Rate-limited per account by the control plane.
    pub async fn account_key_fetch(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<AccountKeyRecord, CloudError> {
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Fetch,
                connector_id,
                account,
                vec![],
                identity,
                current,
            )
            .await?;
        let request = self
            .http
            .get(format!("{}/v1/next/account-key", self.server))
            .bearer_auth(self.token.as_str())
            .header("x-mdbase-device-id", identity.public().device.clone())
            .header("x-mdbase-challenge", secrets::hex(&challenge))
            .header("x-mdbase-signature", secrets::hex(&sig));
        let v = self.send_current(request, current).await?;
        AccountKeyRecord::parse(&v)
    }

    /// AK1: this account's account-key metadata (`GET /v1/next/account-key/status`):
    /// mode, version and key id, no bundle. Not on the per-account fetch budget.
    pub async fn account_key_status(
        &self,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<AccountKeyRecord, CloudError> {
        let request = self
            .http
            .get(format!("{}/v1/next/account-key/status", self.server))
            .bearer_auth(self.token.as_str());
        let v = self.send_current(request, current).await?;
        AccountKeyRecord::parse_status(&v)
    }

    /// AK1: store a sealed bundle (create, re-wrap or rotate) with compare-and-set on
    /// `expected_version`. Returns the new version.
    ///
    /// Every write registers R's proof key (`proof_pk`); replacing an existing
    /// password-mode bundle also signs the rewrap digest with it (`proof_sig`), so a
    /// signed-in device without R cannot overwrite the bundle.
    #[allow(clippy::too_many_arguments)]
    pub async fn account_key_put(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        expected_version: u64,
        key_id: &[u8; 32],
        bundle: &[u8],
        proof: &mdbn_replica::crypto::sign::DeviceSigner,
        replacing: bool,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        use mdbn_wire::cbor::Cbor;
        let extra = vec![
            Cbor::Uint(expected_version),
            Cbor::Bytes(key_id.to_vec()),
            Cbor::Bytes(bundle.to_vec()),
        ];
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Put,
                connector_id,
                account,
                extra,
                identity,
                current,
            )
            .await?;
        let mut body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "expected_version": expected_version,
            "key_id": secrets::hex(key_id),
            "bundle": secrets::hex(bundle),
            "proof_pk": secrets::hex(&proof.public()),
        });
        if replacing {
            let digest = mdbn_replica::crypto::account_key::rewrap_digest(
                &mdbn_wire::common::B16(*account),
                bundle,
                expected_version,
            );
            body["proof_sig"] = json!(secrets::hex(&proof.sign_digest(&digest)));
        }
        let request = self
            .http
            .put(format!("{}/v1/next/account-key", self.server))
            .bearer_auth(self.token.as_str())
            .json(&body);
        let v = self.send_current(request, current).await?;
        v.get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// AK1: strict mode: the control plane drops the bundle and revokes the account's
    /// recovery devices. Returns the new version and the authoritative, complete set
    /// of the account's recovery devices (`recovery_devices`: every one ever enrolled
    /// in a current private collection), or `None` when the control plane did not
    /// send it (an older server: completion is then unknown, never assumed).
    pub async fn account_key_strict(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        expected_version: u64,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(u64, Option<RecoveryDevices>), CloudError> {
        use mdbn_wire::cbor::Cbor;
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Strict,
                connector_id,
                account,
                vec![Cbor::Uint(expected_version)],
                identity,
                current,
            )
            .await?;
        let body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "expected_version": expected_version,
        });
        let v = self
            .post_current("/v1/next/account-key/strict", &body, current)
            .await?;
        let version = v
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        Ok((version, parse_recovery_devices(&v)?))
    }

    /// Query replica-witness targets, or submit one immutable applied attestation.
    /// A normal device proof binds the entire optional witness to this request.
    pub async fn strict_witness_request(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        witness: Option<&mdbn_replica::replica::StrictWitness>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        use mdbn_wire::cbor::Cbor;
        let fields = if let Some(w) = witness {
            if w.collection.0 != *collection || w.reporter.0 != identity.device_id {
                return Err(CloudError::Local("witness_identity_mismatch".into()));
            }
            let Cbor::Array(mut fields) = w.fields() else {
                unreachable!()
            };
            fields.push(Cbor::Bytes(w.signature.0.to_vec()));
            Cbor::Array(fields)
        } else {
            Cbor::Array(Vec::new())
        };
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::StrictReport,
                connector_id,
                collection,
                vec![fields],
                identity,
                current,
            )
            .await?;
        let mut body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge), "sig": secrets::hex(&sig),
        });
        if let Some(w) = witness {
            body["witness"] = json!({
                "account_id": secrets::uuid_string(&w.account.0), "collection_id": secrets::uuid_string(collection),
                "recovery_device": secrets::uuid_string(&w.recovery_device.0), "strict_version": w.version,
                "revoked_at": w.revoked_at, "applied_at": w.applied_at, "epoch": w.epoch,
                "reporter": secrets::uuid_string(&w.reporter.0), "signature": secrets::hex(&w.signature.0),
            });
        }
        self.post_current(
            &format!(
                "/v1/next/collections/{}/private/strict-witness",
                secrets::uuid_string(collection)
            ),
            &body,
            current,
        )
        .await
    }

    /// AK1: enrol this account's recovery device of `collection`, with a proof of
    /// possession by the recovery key over the complete public tuple.
    pub async fn account_key_device_enrol(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        collection: &[u8; 16],
        recovery: &mdbn_replica::crypto::recovery::RecoveryKeys,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        current().map_err(CloudError::Local)?;
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let sign_pk = recovery.signer.public();
        let kem_pk = recovery.kem.pk;
        let rdev = recovery.device.0;
        let (caller, tuple) = proof::account_key_device_digests(
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
            &B16(*account),
            &B16(rdev),
            &sign_pk,
            &kem_pk,
        );
        let sig = identity.sign_digest(&caller.0);
        let pop = recovery.signer.sign_digest(&tuple.0);
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "recovery_device": recovery.device.to_uuid_string(),
            "sign_pk": secrets::hex(&sign_pk),
            "kem_pk": secrets::hex(&kem_pk),
            "pop": secrets::hex(&pop),
        });
        let v = self
            .post_current(
                &format!("/v1/next/collections/{id}/private/account-key-device"),
                &body,
                current,
            )
            .await?;
        v.get("enrolled_at")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }
}

/// Bound on the strict response's recovery-device set: larger is refused as
/// malformed, never truncated (a truncated set would claim completion early).
const MAX_RECOVERY_DEVICES: usize = 65_536;

/// An account's recovery devices: (collection ID, device ID).
pub type RecoveryDevices = Vec<(String, [u8; 16])>;

/// The strict response's authoritative `recovery_devices`: `None` when absent, an
/// error when malformed or over the bound.
fn parse_recovery_devices(v: &Value) -> Result<Option<RecoveryDevices>, CloudError> {
    let bad = || CloudError::Server(200, "malformed".into());
    let Some(list) = v.get("recovery_devices") else {
        return Ok(None);
    };
    let list = list.as_array().ok_or_else(bad)?;
    if list.len() > MAX_RECOVERY_DEVICES {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(list.len());
    for r in list {
        let c = r
            .get("collection_id")
            .and_then(Value::as_str)
            .filter(|c| crate::attest::uuid_bytes(c).is_some());
        let d = r
            .get("device_id")
            .and_then(Value::as_str)
            .and_then(crate::attest::uuid_bytes);
        match (c, d) {
            (Some(c), Some(d)) => out.push((c.to_ascii_lowercase(), d)),
            _ => return Err(bad()),
        }
    }
    Ok(Some(out))
}

fn parse_strict_completion(v: &Value) -> Result<(Option<bool>, Vec<Value>), CloudError> {
    let bad = || CloudError::Server(200, "malformed".into());
    let Some(complete) = v.get("complete") else {
        return Ok((None, Vec::new()));
    };
    let complete = complete.as_bool().ok_or_else(bad)?;
    let pending = v.get("pending").and_then(Value::as_array).ok_or_else(bad)?;
    if pending.len() > 1024 || complete != pending.is_empty() {
        return Err(bad());
    }
    let mut seen = std::collections::BTreeSet::new();
    for p in pending {
        let uuid = |name| {
            p.get(name)
                .and_then(Value::as_str)
                .and_then(crate::attest::uuid_bytes)
                .filter(|u| *u != [0; 16])
        };
        let pair = (
            uuid("collection_id").ok_or_else(bad)?,
            uuid("device_id").ok_or_else(bad)?,
        );
        if !seen.insert(pair)
            || !matches!(p.get("revoked_at"), Some(Value::Null))
                && p.get("revoked_at")
                    .and_then(Value::as_u64)
                    .filter(|s| *s > 0)
                    .is_none()
        {
            return Err(bad());
        }
    }
    Ok((Some(complete), pending.clone()))
}

/// AK1: this account's account-key record at the control plane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountKeyRecord {
    /// `none`, `password` or `strict`.
    pub mode: String,
    /// Compare-and-set version (0 when none).
    pub version: u64,
    /// The sealed bundle and its key id, in password mode (fetch only).
    pub bundle: Option<(Vec<u8>, [u8; 32])>,
    /// The key id, in password mode (fetch and status).
    pub key_id: Option<[u8; 32]>,
    /// CP aggregation of replica-applied witnesses; None on older servers.
    pub complete: Option<bool>,
    /// The CP's full missing-target list (never silently truncated).
    pub pending: Vec<Value>,
}

impl AccountKeyRecord {
    /// The status route's metadata: no bundle, the key id in password mode.
    fn parse_status(v: &Value) -> Result<AccountKeyRecord, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let mode = v.get("mode").and_then(Value::as_str).ok_or_else(bad)?;
        if !matches!(mode, "none" | "password" | "strict") {
            return Err(bad());
        }
        let version = v.get("version").and_then(Value::as_u64).ok_or_else(bad)?;
        let key_id = if mode == "password" {
            Some(
                v.get("key_id")
                    .and_then(Value::as_str)
                    .and_then(|h| secrets::hex_decode(h).ok())
                    .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
                    .ok_or_else(bad)?,
            )
        } else {
            None
        };
        let (complete, pending) = if mode == "strict" {
            parse_strict_completion(v)?
        } else {
            (None, Vec::new())
        };
        Ok(AccountKeyRecord {
            mode: mode.to_string(),
            version,
            bundle: None,
            key_id,
            complete,
            pending,
        })
    }

    fn parse(v: &Value) -> Result<AccountKeyRecord, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let mode = v.get("mode").and_then(Value::as_str).ok_or_else(bad)?;
        if !matches!(mode, "none" | "password" | "strict") {
            return Err(bad());
        }
        let version = v.get("version").and_then(Value::as_u64).ok_or_else(bad)?;
        let bundle = if mode == "password" {
            let b = v
                .get("bundle")
                .and_then(Value::as_str)
                .filter(|h| h.len() <= 1024)
                .and_then(|h| secrets::hex_decode(h).ok())
                .ok_or_else(bad)?;
            let k = v
                .get("key_id")
                .and_then(Value::as_str)
                .and_then(|h| secrets::hex_decode(h).ok())
                .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
                .ok_or_else(bad)?;
            Some((b.to_vec(), k))
        } else {
            None
        };
        Ok(AccountKeyRecord {
            mode: mode.to_string(),
            version,
            key_id: bundle.as_ref().map(|(_, k)| *k),
            bundle,
            complete: None,
            pending: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AK1 requests sign the shared account-proof digests over the served
    /// challenge (strict with its expected version; the recovery-device enrolment
    /// with the caller proof and the recovery key's possession proof).
    #[tokio::test]
    async fn account_key_calls_sign_the_shared_proof_digests() {
        use mdbn_wire::cbor::Cbor;
        const CONNECTOR: &str = "11111111-1111-4111-8111-111111111111";
        let account = [3u8; 16];
        let collection = [4u8; 16];
        let id = DeviceIdentity::generate().unwrap();
        let ok = || Ok(());
        let connector = B16(crate::attest::uuid_bytes(CONNECTOR).unwrap());
        let sig_of = |body: &Value, key: &str| -> [u8; 64] {
            secrets::hex_decode(body[key].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap()
        };
        let (line, body) = capture_proven(
            |cloud, id| {
                Box::pin(async move {
                    cloud
                        .account_key_strict(CONNECTOR, &account, 5, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.starts_with("POST /v1/next/account-key/strict "));
        assert_eq!(body["expected_version"], 5);
        let digest = proof::account_proof_digest(
            proof::AccountProof::Strict,
            &[7; 32],
            &connector,
            &B16(id.device_id),
            &B16(account),
            vec![Cbor::Uint(5)],
        );
        assert_eq!(sig_of(&body, "sig"), id.sign_digest(&digest.0));

        let recovery = Arc::new(
            mdbn_replica::crypto::recovery::RecoveryKey::generate(&mut mdbn_local_host::OsEntropy)
                .derive(&B16(collection)),
        );
        let held = recovery.clone();
        let (line, body) = capture_proven(
            move |cloud, id| {
                Box::pin(async move {
                    cloud
                        .account_key_device_enrol(CONNECTOR, &account, &collection, &held, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.contains("/private/account-key-device "), "{line}");
        let (caller, possession) = proof::account_key_device_digests(
            &[7; 32],
            &connector,
            &B16(id.device_id),
            &B16(collection),
            &B16(account),
            &recovery.device,
            &recovery.signer.public(),
            &recovery.kem.pk,
        );
        assert_eq!(sig_of(&body, "sig"), id.sign_digest(&caller.0));
        assert_eq!(
            sig_of(&body, "pop"),
            recovery.signer.sign_digest(&possession.0)
        );
    }

    /// Strict completion is computed over `recovery_devices` only: absent is
    /// unknown (None), malformed or oversized is an error, never a truncation.
    #[test]
    fn strict_completion_requires_explicit_cp_witness_aggregation() {
        assert_eq!(parse_strict_completion(&json!({})).unwrap(), (None, vec![]));
        assert_eq!(
            parse_strict_completion(&json!({"complete": true, "pending": []})).unwrap(),
            (Some(true), vec![])
        );
        let target = json!({"collection_id":"11111111-1111-1111-1111-111111111111",
            "device_id":"22222222-2222-2222-2222-222222222222", "revoked_at":3});
        assert_eq!(
            parse_strict_completion(&json!({"complete":false,"pending":[target.clone()]}))
                .unwrap()
                .0,
            Some(false)
        );
        for bad in [
            json!({"complete":true}),
            json!({"complete":"true","pending":[]}),
            json!({"complete":true,"pending":[target.clone()]}),
            json!({"complete":false,"pending":[]}),
            json!({"complete":false,"pending":[target.clone(),target.clone()]}),
            json!({"complete":false,"pending":[{"collection_id":"wrong","device_id":"wrong","revoked_at":3}]}),
            json!({"complete":false,"pending":vec![target; 1025]}),
        ] {
            assert!(parse_strict_completion(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn strict_witness_and_report_digests_match_connect() {
        use mdbn_replica::replica::StrictWitness;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::common::B64;
        let w = StrictWitness {
            account: B16([1; 16]),
            collection: B16([2; 16]),
            recovery_device: B16([3; 16]),
            version: 7,
            revoked_at: 11,
            applied_at: 12,
            epoch: 3,
            reporter: B16([4; 16]),
            signature: B64([0; 64]),
        };
        assert_eq!(
            secrets::hex(&w.digest().0),
            "ae322af8d0e5001a0bc752bedcfd9d721dd3355b379a6fb8b06da4b777713953"
        );
        let Cbor::Array(mut fields) = w.fields() else {
            unreachable!()
        };
        fields.push(Cbor::Bytes(w.signature.0.to_vec()));
        for (value, expected) in [
            (
                Cbor::Array(vec![]),
                "ca6ac42770c1a008b97e9e5279f0d969668d5e74abdb0e7f11944f8e847afa0b",
            ),
            (
                Cbor::Array(fields),
                "48169641c7f004ee96994c9e1d446cb27dcb5c118bfb980bff789750e8b356d4",
            ),
        ] {
            let d = proof::account_proof_digest(
                proof::AccountProof::StrictReport,
                &[5; 32],
                &B16([6; 16]),
                &B16([4; 16]),
                &B16([2; 16]),
                vec![value],
            );
            assert_eq!(secrets::hex(&d.0), expected);
        }
    }

    #[test]
    fn strict_recovery_set_is_authoritative_or_absent() {
        let c = "44444444-4444-4444-8444-444444444444";
        let d = "55555555-5555-4555-8555-555555555555";
        // The incremental `revocations` alone is not the set.
        let only_revocations = json!({ "version": 2, "revocations": [] });
        assert_eq!(parse_recovery_devices(&only_revocations).unwrap(), None);
        let ok =
            json!({ "recovery_devices": [{ "collection_id": c.to_uppercase(), "device_id": d }] });
        let set = parse_recovery_devices(&ok).unwrap().unwrap();
        assert_eq!(
            set,
            vec![(c.to_string(), crate::attest::uuid_bytes(d).unwrap())]
        );
        for bad in [
            json!({ "recovery_devices": {} }),
            json!({ "recovery_devices": [{ "collection_id": c }] }),
            json!({ "recovery_devices": [{ "collection_id": "x", "device_id": d }] }),
        ] {
            assert!(parse_recovery_devices(&bad).is_err(), "{bad}");
        }
        let many: Vec<Value> = (0..=MAX_RECOVERY_DEVICES)
            .map(|_| json!({ "collection_id": c, "device_id": d }))
            .collect();
        assert!(parse_recovery_devices(&json!({ "recovery_devices": many })).is_err());
    }
}
