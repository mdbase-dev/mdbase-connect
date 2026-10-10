//! Control-plane request proof digests: the ONE implementation of every
//! device-signed transcript a native or app host sends to Connect's `next` API.
//!
//! Each function returns the 32-byte digest the device signs with its Ed25519
//! key (`DeviceSigner::sign_digest`); signing stays with the caller's key custody.
//! Every digest is `H(domain, transcript)` ([`mdbn_wire::hash::h`]). Transcripts
//! are built here and zeroized after hashing: challenges and commitments never
//! outlive the call.
//!
//! | Digest | Domain | Transcript |
//! |---|---|---|
//! | [`cp_enrol_digest`] | `cp-enrol` | `challenge ‖ connector ‖ device ‖ sign_pk ‖ kem_pk ‖ noise_pk` |
//! | [`relay_device_digest`] | `relay-device` | `connector ‖ utf8(session_id) ‖ nonce` |
//! | [`collection_log_token_digest`] | `collection-log-token` | `cbor[challenge, connector, device, collection]` |
//! | [`collection_proof_digest`] | [`CollectionProof::domain`] | `cbor[challenge, connector, device, collection, ?sas_commit]` |
//! | [`account_proof_digest`] | [`AccountProof::domain`] | `cbor[challenge, connector, device, subject, ..extra]` |
//! | [`account_key_device_digests`] | `account-key-device`, `account-key-enrol` | see the function |
//! | [`approval_peer_read_digest`] | `device-approval-peer-inbox`, `device-approval-peer-ack` | `cbor[challenge, connector, device, collection, ?[queue ids]]` |
//!
//! [`client_fingerprint_display`] is the one display form of a grant's client key
//! fingerprint (`policy.md` §5.1: the first 8 bytes of `H("mdbase/v1/client-fp",
//! client_pk)`, [`mdbn_wire::policy::client_fingerprint`]), grouped for reading.
//!
//! UUIDs and keys are CBOR byte strings. The vectors in the tests are Connect's
//! own (its TypeScript `domainHash`/`encodeCbor`), plus independently computed
//! ones for the raw-concatenation transcripts.

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::hash::h;
use zeroize::Zeroizing;

fn bytes(b: &[u8]) -> Cbor {
    Cbor::Bytes(b.to_vec())
}

/// `H(domain, cbor(fields))`, zeroizing the encoding and the field copies.
fn cbor_digest(domain: &str, fields: Vec<Cbor>) -> B32 {
    let value = Cbor::Array(fields);
    // Encoding a flat array of byte strings and unsigned integers cannot fail; a
    // failure would be a bug in the encoder, never input-dependent.
    let encoded = Zeroizing::new(cbor::encode(&value).expect("proof transcript encodes"));
    wipe(value);
    h(domain, &encoded)
}

fn wipe(value: Cbor) {
    match value {
        Cbor::Bytes(b) => drop(Zeroizing::new(b)),
        Cbor::Array(items) => items.into_iter().for_each(wipe),
        _ => {}
    }
}

/// Device registration to a connector (`POST /v1/next/devices`).
pub fn cp_enrol_digest(
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    sign_pk: &[u8; 32],
    kem_pk: &[u8; 32],
    noise_pk: &[u8; 32],
) -> B32 {
    let mut m = Zeroizing::new(Vec::with_capacity(32 + 16 + 16 + 96));
    m.extend_from_slice(challenge);
    m.extend_from_slice(&connector.0);
    m.extend_from_slice(&device.0);
    m.extend_from_slice(sign_pk);
    m.extend_from_slice(kem_pk);
    m.extend_from_slice(noise_pk);
    h("mdbase/v1/cp-enrol", &m)
}

/// The relay's device bind of a connector session.
pub fn relay_device_digest(connector: &Uuid, session_id: &str, nonce: &[u8; 32]) -> B32 {
    let mut m = Zeroizing::new(Vec::with_capacity(16 + session_id.len() + 32));
    m.extend_from_slice(&connector.0);
    m.extend_from_slice(session_id.as_bytes());
    m.extend_from_slice(nonce);
    h("mdbase/v1/relay-device", &m)
}

/// A synced collection's role-0 log token renewal
/// (`POST /v1/next/collections/:id/log-token`; Connect `collectionLogTokenDigest`).
pub fn collection_log_token_digest(
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    collection: &Uuid,
) -> B32 {
    cbor_digest(
        "mdbase/v1/collection-log-token",
        vec![
            bytes(challenge),
            bytes(&connector.0),
            bytes(&device.0),
            bytes(&collection.0),
        ],
    )
}

/// The collection bootstrap proofs (Connect `cloudCopyCreateDigest`,
/// `cloudCopyJoinDigest`, `privateCreateDigest`, `privateDeviceEnrolDigest`,
/// `privateApprovalRequestDigest`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionProof {
    /// `POST /v1/next/collections/cloud-copy`.
    CloudCopyCreate,
    /// `POST /v1/next/collections/:id/devices`.
    CloudCopyJoin,
    /// `POST /v1/next/collections/private`.
    PrivateCreate,
    /// `POST /v1/next/collections/:id/private/devices` (carries the SAS commitment).
    PrivateDeviceEnrol,
    /// `POST /v1/next/collections/:id/private/devices/approval-request` (carries a
    /// fresh SAS commitment).
    PrivateApprovalRequest,
}

impl CollectionProof {
    /// The domain tag.
    pub const fn domain(self) -> &'static str {
        match self {
            CollectionProof::CloudCopyCreate => "mdbase/v1/cloud-copy-create",
            CollectionProof::CloudCopyJoin => "mdbase/v1/cloud-copy-join",
            CollectionProof::PrivateCreate => "mdbase/v1/private-create",
            CollectionProof::PrivateDeviceEnrol => "mdbase/v1/private-device-enrol",
            CollectionProof::PrivateApprovalRequest => "mdbase/v1/private-approval-request",
        }
    }

    /// Whether the transcript carries a SAS commitment.
    pub const fn carries_sas_commit(self) -> bool {
        matches!(
            self,
            CollectionProof::PrivateDeviceEnrol | CollectionProof::PrivateApprovalRequest
        )
    }
}

/// `H(kind.domain(), cbor[challenge, connector, device, collection, ?sas_commit])`.
/// `None` when `sas_commit` is present for a kind that does not carry one, or
/// absent for one that does: a proof is never built for the wrong shape.
pub fn collection_proof_digest(
    kind: CollectionProof,
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    collection: &Uuid,
    sas_commit: Option<&[u8; 32]>,
) -> Option<B32> {
    if kind.carries_sas_commit() != sas_commit.is_some() {
        return None;
    }
    let mut fields = vec![
        bytes(challenge),
        bytes(&connector.0),
        bytes(&device.0),
        bytes(&collection.0),
    ];
    if let Some(c) = sas_commit {
        fields.push(bytes(c));
    }
    Some(cbor_digest(kind.domain(), fields))
}

/// The account-key (AK1) request proofs (Connect #635 `accountKey*Digest`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountProof {
    /// `GET /v1/next/account-key`; subject: the account; no extra fields.
    Fetch,
    /// `PUT /v1/next/account-key`; subject: the account; extra:
    /// `[expected_version, key_id, bundle]`.
    Put,
    /// `POST /v1/next/account-key/strict`; subject: the account; extra:
    /// `[expected_version]`.
    Strict,
    /// `POST /v1/next/collections/:id/private/strict-witness`; subject: the
    /// collection; extra: `[witness fields ‖ signature, or []]`.
    StrictReport,
}

impl AccountProof {
    /// The domain tag.
    pub const fn domain(self) -> &'static str {
        match self {
            AccountProof::Fetch => "mdbase/v1/account-key-fetch",
            AccountProof::Put => "mdbase/v1/account-key-put",
            AccountProof::Strict => "mdbase/v1/account-key-strict",
            AccountProof::StrictReport => "mdbase/v1/account-key-strict-report",
        }
    }
}

/// `H(kind.domain(), cbor[challenge, connector, device, subject, ..extra])`.
pub fn account_proof_digest(
    kind: AccountProof,
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    subject: &Uuid,
    extra: Vec<Cbor>,
) -> B32 {
    let mut fields = vec![
        bytes(challenge),
        bytes(&connector.0),
        bytes(&device.0),
        bytes(&subject.0),
    ];
    fields.extend(extra);
    cbor_digest(kind.domain(), fields)
}

/// The two digests of an account-key (recovery) device enrolment:
/// - the caller proof `H("mdbase/v1/account-key-device", cbor[challenge, connector,
///   device, collection, recovery, sign_pk, kem_pk])`, signed by the calling device;
/// - the possession proof `H("mdbase/v1/account-key-enrol", cbor[challenge,
///   collection, recovery, account, sign_pk, kem_pk, zero32])`, signed by the
///   recovery device's key.
#[allow(clippy::too_many_arguments)]
pub fn account_key_device_digests(
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    collection: &Uuid,
    account: &Uuid,
    recovery: &Uuid,
    sign_pk: &[u8; 32],
    kem_pk: &[u8; 32],
) -> (B32, B32) {
    let caller = cbor_digest(
        "mdbase/v1/account-key-device",
        vec![
            bytes(challenge),
            bytes(&connector.0),
            bytes(&device.0),
            bytes(&collection.0),
            bytes(&recovery.0),
            bytes(sign_pk),
            bytes(kem_pk),
        ],
    );
    let possession = cbor_digest(
        "mdbase/v1/account-key-enrol",
        vec![
            bytes(challenge),
            bytes(&collection.0),
            bytes(&recovery.0),
            bytes(&account.0),
            bytes(sign_pk),
            bytes(kem_pk),
            bytes(&[0u8; 32]),
        ],
    );
    (caller, possession)
}

/// The grant client-key fingerprint as shown to a user: the canonical 16 hex
/// digits ([`mdbn_wire::policy::client_fingerprint`]) in four groups of four,
/// `xxxx-xxxx-xxxx-xxxx`. Every surface that shows a client key uses this form.
pub fn client_fingerprint_display(client_pk: &B32) -> String {
    let hex = mdbn_wire::policy::client_fingerprint(client_pk);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

/// A device-approval peer queue read (Connect #634).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPeerRead<'a> {
    /// Fetch this device's inbox.
    Inbox,
    /// Acknowledge these queue IDs (the caller bounds and de-duplicates them).
    Ack(&'a [Uuid]),
}

/// `H(domain, cbor[challenge, connector, device, collection, ?[queue ids]])`:
/// `device-approval-peer-inbox` for an inbox read, `device-approval-peer-ack`
/// (with the ID array) for an acknowledgement. Never a collection-proof shape.
pub fn approval_peer_read_digest(
    read: ApprovalPeerRead<'_>,
    challenge: &[u8; 32],
    connector: &Uuid,
    device: &Uuid,
    collection: &Uuid,
) -> B32 {
    let mut fields = vec![
        bytes(challenge),
        bytes(&connector.0),
        bytes(&device.0),
        bytes(&collection.0),
    ];
    let domain = match read {
        ApprovalPeerRead::Inbox => "mdbase/v1/device-approval-peer-inbox",
        ApprovalPeerRead::Ack(ids) => {
            fields.push(Cbor::Array(ids.iter().map(|id| bytes(&id.0)).collect()));
            "mdbase/v1/device-approval-peer-ack"
        }
    };
    cbor_digest(domain, fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;

    fn hex(b: B32) -> String {
        b.0.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn uuid(s: &str) -> Uuid {
        let hex: Vec<u8> = s.bytes().filter(|b| *b != b'-').collect();
        let mut out = [0u8; 16];
        for (i, pair) in hex.chunks(2).enumerate() {
            out[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
        }
        B16(out)
    }

    fn ids() -> (Uuid, Uuid, Uuid) {
        (
            uuid("11111111-1111-4111-8111-111111111111"),
            uuid("22222222-2222-4222-8222-222222222222"),
            uuid("33333333-3333-4333-8333-333333333333"),
        )
    }

    /// Connect's TypeScript digests, byte for byte.
    #[test]
    fn collection_proofs_match_connect() {
        let (c, d, col) = ids();
        let ch = [1u8; 32];
        let sas = [9u8; 32];
        for (kind, commit, want) in [
            (
                CollectionProof::CloudCopyCreate,
                None,
                "c183210caaed2eac1ac21104b509b1985c58c097b6b66b96b2d37137ced63daa",
            ),
            (
                CollectionProof::CloudCopyJoin,
                None,
                "1d9ac4490d2e66e823897b8ccf995e1d68afae93b7320bdbc26448062bf23fbe",
            ),
            (
                CollectionProof::PrivateCreate,
                None,
                "462b15a1ca0f8709e8fd36da5cfea4df07c581bde53d4e3f9f9219bd66e45a65",
            ),
            (
                CollectionProof::PrivateDeviceEnrol,
                Some(&sas),
                "a5eb9de0e81f2f5e330b778de0b4e21e68bdfaade25c0a1faa568531bbbdae20",
            ),
            (
                CollectionProof::PrivateApprovalRequest,
                Some(&sas),
                "54be7d4bc361c917386fa2dc4cae615f9a0dadc153b77c124c7517bb74dd3120",
            ),
        ] {
            let got = collection_proof_digest(kind, &ch, &c, &d, &col, commit).unwrap();
            assert_eq!(hex(got), want, "{kind:?}");
            // The wrong commitment shape is refused, never silently built.
            let flipped = if commit.is_some() { None } else { Some(&sas) };
            assert_eq!(
                collection_proof_digest(kind, &ch, &c, &d, &col, flipped),
                None,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn log_token_matches_connect() {
        let (c, d, col) = ids();
        assert_eq!(
            hex(collection_log_token_digest(&[7; 32], &c, &d, &col)),
            "38d7072a110cb73ae03e52c1f537ae2fc8a37b43db156e7eab11731928c69b17"
        );
    }

    /// Raw-concatenation transcripts, computed independently (Python `hashlib`).
    #[test]
    fn raw_transcripts_match_independent_vectors() {
        let (c, d, _) = ids();
        assert_eq!(
            hex(cp_enrol_digest(
                &[1; 32], &c, &d, &[7; 32], &[8; 32], &[9; 32]
            )),
            "233243f5f08ed5454c61eba88772b1279bbd4c6743406e51d5de3eab90a18b8c"
        );
        assert_eq!(
            hex(relay_device_digest(&c, "session-1", &[3; 32])),
            "75564aa7e0804a7a802e655bd7a36223c95d5c8e9792adcb65384ab1e697f934"
        );
    }

    /// Connect #635's `accountKey*Digest` for fixed inputs.
    #[test]
    fn account_proofs_match_connect() {
        let (connector, device, account) = ids();
        let collection = uuid("44444444-4444-4444-8444-444444444444");
        let ch = [1u8; 32];
        let d = |kind, extra| {
            hex(account_proof_digest(
                kind, &ch, &connector, &device, &account, extra,
            ))
        };
        assert_eq!(
            d(AccountProof::Fetch, vec![]),
            "dcc2409db3d636db4dd5e4731ab211eb34552f1e17fc92cae2b5519d0b45d090"
        );
        assert_eq!(
            d(
                AccountProof::Put,
                vec![
                    Cbor::Uint(3),
                    Cbor::Bytes(vec![5; 32]),
                    Cbor::Bytes(vec![6; 100])
                ]
            ),
            "33f629cb2b3da7d151f833743c07f3c0d6ea2224687efbc14a5448f984dd30e3"
        );
        assert_eq!(
            d(AccountProof::Strict, vec![Cbor::Uint(3)]),
            "5287fcabdc611828b39c534ad145454cb13ac17fd2804edd0dbb1911d9b1fbec"
        );
        assert_eq!(
            hex(account_proof_digest(
                AccountProof::StrictReport,
                &[5; 32],
                &B16([6; 16]),
                &B16([4; 16]),
                &B16([2; 16]),
                vec![Cbor::Array(vec![])],
            )),
            "ca6ac42770c1a008b97e9e5279f0d969668d5e74abdb0e7f11944f8e847afa0b"
        );
        let (sign_pk, kem_pk) = ([7u8; 32], [8u8; 32]);
        let mut m = collection.0.to_vec();
        m.extend_from_slice(&sign_pk);
        let mut rid = [0u8; 16];
        rid.copy_from_slice(&h("mdbase/v1/recovery-id", &m).0[..16]);
        let recovery = B16(rid);
        assert_eq!(
            recovery.to_uuid_string(),
            "9d781c9d-4e6c-a467-56b6-cd2220dfed44"
        );
        let (caller, pop) = account_key_device_digests(
            &ch,
            &connector,
            &device,
            &collection,
            &account,
            &recovery,
            &sign_pk,
            &kem_pk,
        );
        assert_eq!(
            hex(caller),
            "71bb8c2015008bbc1ff96fb73232ff184654c442f26691ae43a098ef630b9fc6"
        );
        assert_eq!(
            hex(pop),
            "bd5d1ac3ba7b07b4ae0e4f1a12a6cd6e97912046e870946999ee78e12d6f048d"
        );
    }

    /// policy.md §5.1: `H` with its tag-length prefix (independent vectors).
    #[test]
    fn client_fingerprint_follows_the_spec() {
        assert_eq!(
            mdbn_wire::policy::client_fingerprint(&B32([0; 32])),
            "535bc23763edcd6a"
        );
        assert_eq!(
            client_fingerprint_display(&B32([0; 32])),
            "535b-c237-63ed-cd6a"
        );
        let mut pk = [0u8; 32];
        pk.iter_mut().enumerate().for_each(|(i, b)| *b = i as u8);
        assert_eq!(client_fingerprint_display(&B32(pk)), "cc31-54be-d86e-848a");
        // Not the unprefixed SHA-256(tag || pk) ("d685e7a289a8c34e" for zero).
        assert_ne!(
            client_fingerprint_display(&B32([0; 32])),
            "d685-e7a2-89a8-c34e"
        );
    }

    #[test]
    fn domains_are_distinct() {
        let mut all: Vec<&str> = [
            CollectionProof::CloudCopyCreate,
            CollectionProof::CloudCopyJoin,
            CollectionProof::PrivateCreate,
            CollectionProof::PrivateDeviceEnrol,
            CollectionProof::PrivateApprovalRequest,
        ]
        .map(CollectionProof::domain)
        .into_iter()
        .chain(
            [
                AccountProof::Fetch,
                AccountProof::Put,
                AccountProof::Strict,
                AccountProof::StrictReport,
            ]
            .map(AccountProof::domain),
        )
        .collect();
        let n = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), n);
    }

    #[test]
    fn approval_peer_reads_are_domain_separated_cbor_transcripts() {
        let (ch, c, d, col) = ([3u8; 32], B16([1; 16]), B16([2; 16]), B16([4; 16]));
        let ids = [B16([5; 16]), B16([6; 16])];
        let enc = |extra: Option<&[Uuid]>| {
            let mut f = vec![
                Cbor::Bytes(ch.to_vec()),
                Cbor::Bytes(c.0.to_vec()),
                Cbor::Bytes(d.0.to_vec()),
                Cbor::Bytes(col.0.to_vec()),
            ];
            if let Some(ids) = extra {
                f.push(Cbor::Array(
                    ids.iter().map(|i| Cbor::Bytes(i.0.to_vec())).collect(),
                ));
            }
            cbor::encode(&Cbor::Array(f)).unwrap()
        };
        let inbox = approval_peer_read_digest(ApprovalPeerRead::Inbox, &ch, &c, &d, &col);
        let ack = approval_peer_read_digest(ApprovalPeerRead::Ack(&ids), &ch, &c, &d, &col);
        assert_eq!(inbox, h("mdbase/v1/device-approval-peer-inbox", &enc(None)));
        assert_eq!(
            ack,
            h("mdbase/v1/device-approval-peer-ack", &enc(Some(&ids)))
        );
        assert_ne!(inbox, ack);
        // Never the shape of a SAS-carrying collection proof.
        assert_ne!(
            Some(ack),
            collection_proof_digest(
                CollectionProof::PrivateApprovalRequest,
                &ch,
                &c,
                &d,
                &col,
                Some(&[5; 32])
            )
        );
    }
}
