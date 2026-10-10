//! A synced collection's local link state and its log credential.
//!
//! - **[`SyncConfig`]** (v2) lives at `<state>/collections/<id>/sync.json` (owner-only,
//!   atomic, non-secret). It binds the collection to an environment's trust pins
//!   ([`crate::trust::Trust`]), its log URL (which must be that environment's
//!   origin), the genesis pinned at create/join, the user's chosen state and
//!   cloud-copy opt-in, and the SAS/local signers. It holds no roots of its own and
//!   is not membership authority: membership comes from the verified log.
//! - **[`ConnectTokens`]** renews this device's role-0, one-collection log token
//!   through Connect (`POST /v1/next/collections/:id/log-token`, device proof). It
//!   caches it in RAM until a minute before expiry and drops it when refused. The
//!   current-authority fence is checked before a cached token is used and again
//!   after every await.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use mdbn_wire::policy::CState;
use serde::{Deserialize, Serialize};

use crate::fsutil;
use crate::logwire::{Token, TokenSource};
use crate::secrets::DeviceIdentity;
use crate::trust::Trust;

/// `sync.json`.
pub const FILE: &str = "sync.json";

/// Non-secret link state of one synced collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncConfig {
    /// Schema (2).
    pub schema_version: u32,
    /// The environment whose trust pins apply.
    pub environment: String,
    /// The collection this link belongs to (UUID).
    pub collection_id: String,
    /// Log service URL: exactly the environment's log origin.
    pub log_url: String,
    /// Chain hash of seq 1 (64 lower-case hex), from the verified create/join answer.
    pub genesis_hash: String,
    /// `cloud_copy` or `private`, as the user chose.
    pub chosen_state: String,
    /// SAS-approved or locally created signer devices (UUIDs).
    #[serde(default)]
    pub trusted_signers: Vec<String>,
    /// The user turned the cloud copy on.
    #[serde(default)]
    pub user_enabled_cloud_copy: bool,
}

/// Why `sync.json` is unusable. Messages carry no secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

/// The validated, typed form a runtime needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Log origin.
    pub log_url: String,
    /// Chosen state.
    pub chosen_state: CState,
    /// Pinned roots (from the environment's trust pins).
    pub trusted_roots: Vec<[u8; 32]>,
    /// Trusted signers.
    pub trusted_signers: Vec<[u8; 16]>,
    /// Cloud-copy opt-in.
    pub user_enabled_cloud_copy: bool,
    /// Pinned genesis chain hash.
    pub expected_genesis: [u8; 32],
}

impl SyncConfig {
    /// `<collections_dir>/<id>/sync.json`.
    pub fn path(collections_dir: &Path, id: &str) -> PathBuf {
        collections_dir.join(id).join(FILE)
    }

    /// Load, or `None` when the collection has no link yet. Must be owner-only.
    pub fn load(path: &Path) -> Result<Option<SyncConfig>, Invalid> {
        let bad = |e: &dyn std::fmt::Display| Invalid(format!("sync.json: {e}"));
        let Some(bytes) = fsutil::read_optional(path).map_err(|e| bad(&e))? else {
            return Ok(None);
        };
        fsutil::verify_owner_only(path).map_err(|e| bad(&e))?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| bad(&e))
    }

    /// Save atomically (the collection's private dir must exist), after validating
    /// against the collection and trust it is saved for.
    pub fn save(&self, path: &Path, collection: &[u8; 16], trust: &Trust) -> Result<(), Invalid> {
        self.validate(collection, trust)?;
        let mut b = serde_json::to_vec_pretty(self).map_err(|e| Invalid(e.to_string()))?;
        b.push(b'\n');
        fsutil::write_atomic(path, &b).map_err(|e| Invalid(format!("sync.json: {e}")))
    }

    /// Strict validation into the runtime's form, for `collection` under `trust`.
    pub fn validate(&self, collection: &[u8; 16], trust: &Trust) -> Result<Link, Invalid> {
        let bad = |m: &str| Err(Invalid(m.into()));
        if self.schema_version != 2 {
            return bad("unsupported sync.json schema; join again");
        }
        if self.environment != trust.environment {
            return bad("sync.json names another environment");
        }
        if crate::attest::uuid_bytes(&self.collection_id).as_ref() != Some(collection) {
            return bad("sync.json belongs to another collection");
        }
        if crate::trust::origin(&self.log_url).map_err(|e| Invalid(e.0))? != trust.log_origin {
            return bad("log URL is not the environment's log origin");
        }
        crate::logwire::ws_url(&self.log_url, &mdbn_wire::common::B16(*collection))
            .map_err(Invalid)?;
        if self.genesis_hash.len() != 64
            || self.genesis_hash != self.genesis_hash.to_ascii_lowercase()
        {
            return bad("genesis_hash must be 32 bytes of lower-case hex");
        }
        let expected_genesis: [u8; 32] = crate::secrets::hex_decode(&self.genesis_hash)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| Invalid("genesis_hash".into()))?;
        let chosen_state = match self.chosen_state.as_str() {
            "cloud_copy" => CState::CloudCopy,
            "private" => CState::E2e,
            _ => return bad("chosen_state must be cloud_copy or private"),
        };
        if self.user_enabled_cloud_copy && chosen_state != CState::CloudCopy {
            return bad("cloud-copy opt-in on a private collection");
        }
        let mut signers = Vec::new();
        for s in &self.trusted_signers {
            signers.push(crate::attest::uuid_bytes(s).ok_or_else(|| Invalid("signer".into()))?);
        }
        Ok(Link {
            log_url: self.log_url.clone(),
            chosen_state,
            trusted_roots: trust.roots.clone(),
            trusted_signers: signers,
            user_enabled_cloud_copy: self.user_enabled_cloud_copy,
            expected_genesis,
        })
    }
}

/// Verify a create/join answer's genesis before anything is persisted: the exact
/// seq-1 item of `collection`, a valid genesis policy under one of the pinned roots
/// (its certificate chains to the root; replica policy rules), in the `chosen`
/// state. Returns its chain hash, the value to pin as `genesis_hash`. Connect's
/// answer supplies candidate bytes only; this is what makes them trusted.
pub fn verify_genesis(
    item_bytes: &[u8],
    collection: &[u8; 16],
    trust: &Trust,
    chosen: CState,
) -> Result<[u8; 32], Invalid> {
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::schema::Wire;
    let bad = |m: &str| Err(Invalid(format!("genesis: {m}")));
    let item = Item::from_bytes(item_bytes).map_err(|e| Invalid(format!("genesis: {e}")))?;
    if item.seq != Some(1) || item.collection.0 != *collection || item.kind != ItemKind::Policy {
        return bad("not seq 1 of this collection's policy");
    }
    let chain = mdbn_wire::hash::chain_hash(item_bytes);
    let mut policy = mdbn_replica::policy::PolicyState::new();
    let env = mdbn_replica::policy::Env {
        verifier: &mdbn_replica::crypto::sign::Ed25519Verifier,
        trusted_roots: &trust.roots,
        policy_pins: Some(&trust.policy_pins),
    };
    if policy.apply_control(1, &chain, &item, &env).is_err() {
        return bad("not a valid genesis under the pinned roots");
    }
    if policy.cstate != Some(chosen) {
        return bad("collection state differs from the chosen state");
    }
    Ok(chain.0)
}

/// Log tokens from Connect for this device and one collection.
pub struct ConnectTokens {
    cloud: Arc<crate::cloud::Cloud>,
    connector_id: String,
    collection: [u8; 16],
    identity: Arc<DeviceIdentity>,
    fence: Fence,
    cached: Mutex<Option<Token>>,
}

/// The current-authority check (account epoch, registration, collection, not
/// paused or removed). Cached IDs are never authority on their own.
pub type Fence = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

impl ConnectTokens {
    /// For `collection`, through the signed-in connector, while `fence` holds.
    pub fn new(
        cloud: Arc<crate::cloud::Cloud>,
        connector_id: String,
        collection: [u8; 16],
        identity: Arc<DeviceIdentity>,
        fence: Fence,
    ) -> ConnectTokens {
        ConnectTokens {
            cloud,
            connector_id,
            collection,
            identity,
            fence,
            cached: Mutex::new(None),
        }
    }

    fn drop_cache(&self) {
        if let Ok(mut c) = self.cached.lock() {
            *c = None;
        }
    }

    fn check(&self) -> Result<(), String> {
        (self.fence)().inspect_err(|_| self.drop_cache())
    }
}

const RENEW_BEFORE_MS: i64 = 60_000;

/// Whether Connect will issue this device a log token for the collection: an
/// acknowledged enrolment of exactly this device, current membership, the next
/// runtime, with no revoke. Checked before a synced runtime touches user files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Eligibility {
    /// Connect answered: refused, with its reason. Nothing is opened.
    Refused(String),
    /// Connect could not be asked (network, TLS, 5xx).
    Unreachable(String),
}

impl ConnectTokens {
    async fn fetch(&self) -> Result<Token, Eligibility> {
        self.check().map_err(Eligibility::Refused)?;
        let now = i64::try_from(fsutil::now_ms()).unwrap_or(i64::MAX);
        if let Some(t) = self.cached.lock().ok().and_then(|c| c.clone())
            && t.expires_at_ms - RENEW_BEFORE_MS > now
        {
            return Ok(t);
        }
        let r = self
            .cloud
            .collection_log_token(
                &self.connector_id,
                &self.collection,
                &self.identity,
                &*self.fence,
            )
            .await;
        // The authority may have changed while the request was in flight.
        self.check().map_err(Eligibility::Refused)?;
        let (token, expires_at_ms) = r.map_err(|e| match e {
            crate::cloud::CloudError::Network(m) => Eligibility::Unreachable(m),
            crate::cloud::CloudError::Server(s, c) if s >= 500 => {
                Eligibility::Unreachable(format!("{s} {c}"))
            }
            crate::cloud::CloudError::Server(_, c) => Eligibility::Refused(c),
            crate::cloud::CloudError::Unauthenticated => {
                Eligibility::Refused("unauthenticated".into())
            }
            crate::cloud::CloudError::Local(m) => Eligibility::Refused(m),
        })?;
        let t = Token {
            token,
            expires_at_ms,
        };
        if let Ok(mut c) = self.cached.lock() {
            *c = Some(t.clone());
        }
        Ok(t)
    }

    /// Ask Connect for a token now (cached for the runtime's first connect).
    pub async fn eligibility(&self) -> Result<(), Eligibility> {
        self.fetch().await.map(|_| ())
    }
}

impl TokenSource for ConnectTokens {
    fn token(
        &self,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Token, String>> + Send + '_>> {
        Box::pin(async move {
            self.fetch().await.map_err(|e| match e {
                Eligibility::Refused(m) => format!("refused: {m}"),
                Eligibility::Unreachable(m) => format!("unreachable: {m}"),
            })
        })
    }

    fn refused(&self) {
        self.drop_cache();
    }
    fn current(&self) -> Result<(), String> {
        self.check()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: [u8; 16] = [0x33; 16];

    fn trust() -> Trust {
        Trust {
            environment: "lab".into(),
            cp_origin: "https://cp.example.dev".into(),
            log_origin: "https://log.example.dev".into(),
            roots: vec![[0xab; 32]],
            policy_pins: crate::trust::pins_for([0xab; 32], [0xcd; 32]),
        }
    }

    fn cfg() -> SyncConfig {
        SyncConfig {
            schema_version: 2,
            environment: "lab".into(),
            collection_id: "33333333-3333-3333-3333-333333333333".into(),
            log_url: "https://log.example.dev".into(),
            genesis_hash: "cd".repeat(32),
            chosen_state: "cloud_copy".into(),
            trusted_signers: vec![],
            user_enabled_cloud_copy: true,
        }
    }

    #[test]
    fn validates_strictly_against_the_collection_and_trust() {
        let l = cfg().validate(&C, &trust()).unwrap();
        assert_eq!(l.chosen_state, CState::CloudCopy);
        assert_eq!(l.trusted_roots, vec![[0xab; 32]], "roots come from trust");
        assert_eq!(l.expected_genesis, [0xcd; 32]);
        for bad in [
            SyncConfig {
                schema_version: 1,
                ..cfg()
            },
            SyncConfig {
                environment: "prod".into(),
                ..cfg()
            },
            SyncConfig {
                collection_id: "44444444-4444-4444-4444-444444444444".into(),
                ..cfg()
            },
            SyncConfig {
                log_url: "https://other.example.dev".into(),
                ..cfg()
            },
            SyncConfig {
                log_url: "http://log.example.dev".into(),
                ..cfg()
            },
            SyncConfig {
                genesis_hash: "CD".repeat(32),
                ..cfg()
            },
            SyncConfig {
                genesis_hash: "cd".repeat(31),
                ..cfg()
            },
            SyncConfig {
                chosen_state: "public".into(),
                ..cfg()
            },
            SyncConfig {
                chosen_state: "private".into(),
                ..cfg()
            },
            SyncConfig {
                trusted_signers: vec!["nope".into()],
                ..cfg()
            },
        ] {
            assert!(bad.validate(&C, &trust()).is_err(), "{bad:?}");
        }
        let private = SyncConfig {
            chosen_state: "private".into(),
            user_enabled_cloud_copy: false,
            ..cfg()
        };
        assert_eq!(
            private.validate(&C, &trust()).unwrap().chosen_state,
            CState::E2e
        );
        let local = Trust {
            log_origin: "http://127.0.0.1:7700".into(),
            ..trust()
        };
        let l = SyncConfig {
            log_url: "http://127.0.0.1:7700".into(),
            ..cfg()
        };
        assert!(l.validate(&C, &local).is_ok());
    }

    #[test]
    fn round_trips_owner_only_and_refuses_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("mdbn-sync-{}", std::process::id()));
        crate::fsutil::ensure_private_dir(&dir).unwrap();
        let p = dir.join(FILE);
        cfg().save(&p, &C, &trust()).unwrap();
        assert_eq!(SyncConfig::load(&p).unwrap(), Some(cfg()));
        assert!(cfg().save(&p, &[0; 16], &trust()).is_err());
        std::fs::write(&p, br#"{"schema_version":1,"log_url":"https://x","chosen_state":"private","trusted_roots":[]}"#).unwrap();
        assert!(SyncConfig::load(&p).is_err(), "v1 shape");
        assert_eq!(SyncConfig::load(&dir.join("absent.json")).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_genesis_is_verified_against_the_pinned_roots_before_it_is_pinned() {
        use mdbn_log_service::testkit::ControlPlane;
        use mdbn_wire::common::{B16, B32};
        use mdbn_wire::policy::{Genesis, MemberSet, PolicyOp, Role};
        let cp = ControlPlane::new("sync-genesis");
        let owner = B16([9; 16]);
        let genesis = |c: [u8; 16], state: CState, seq: u64| {
            cp.policy_item(
                B16(c),
                seq,
                B32([0; 32]),
                vec![
                    PolicyOp::Genesis(Genesis {
                        owner,
                        root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                        state,
                    }),
                    PolicyOp::MemberSet(MemberSet {
                        account: owner,
                        role: Role::Owner,
                    }),
                ],
                1,
            )
        };
        let policy_pk = cp.transport_key().verifying_key().to_bytes();
        let pinned = Trust {
            roots: vec![cp.root_pk().0],
            policy_pins: crate::trust::pins_for(cp.root_pk().0, policy_pk),
            ..trust()
        };
        let g = genesis(C, CState::E2e, 1);
        assert_eq!(
            verify_genesis(&g, &C, &pinned, CState::E2e).unwrap(),
            mdbn_wire::hash::chain_hash(&g).0
        );
        assert!(
            verify_genesis(&g, &C, &trust(), CState::E2e).is_err(),
            "unpinned root"
        );
        let other_key = Trust {
            policy_pins: crate::trust::pins_for(cp.root_pk().0, [0x77; 32]),
            ..pinned.clone()
        };
        assert!(
            verify_genesis(&g, &C, &other_key, CState::E2e).is_err(),
            "certified by an unpublished policy key"
        );
        assert!(
            verify_genesis(&g, &[0x44; 16], &pinned, CState::E2e).is_err(),
            "other collection"
        );
        assert!(
            verify_genesis(&g, &C, &pinned, CState::CloudCopy).is_err(),
            "other state"
        );
        assert!(
            verify_genesis(&genesis(C, CState::E2e, 2), &C, &pinned, CState::E2e).is_err(),
            "not seq 1"
        );
        let mut flipped = g.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        assert!(
            verify_genesis(&flipped, &C, &pinned, CState::E2e).is_err(),
            "tampered"
        );
    }

    #[test]
    fn connect_join_answers_parse_and_their_genesis_verifies_under_the_pinned_root() {
        // JOIN POST /v1/next/collections/:id/devices returns the following
        // answer shape for a newly enrolled device:
        // {collection_id, enrolled_at, log_url, genesis: {seq: 1, item: <hex of the
        // appended seq-1 policy item>}, device: mint(..)}; PRIVATE ENROL adds
        // approval: "pending". Keys are random per run, so the bytes are built here
        // the same way the control plane appends them.
        use mdbn_log_service::testkit::ControlPlane;
        use mdbn_wire::common::{B16, B32};
        use mdbn_wire::policy::{Genesis, MemberSet, PolicyOp, Role};
        let cp = ControlPlane::new("sync-join-interop");
        let owner = B16([9; 16]);
        let item = cp.policy_item(
            B16(C),
            1,
            B32([0; 32]),
            vec![
                PolicyOp::Genesis(Genesis {
                    owner,
                    root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                    state: CState::CloudCopy,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: owner,
                    role: Role::Owner,
                }),
            ],
            1,
        );
        let policy_pk = cp.transport_key().verifying_key().to_bytes();
        let pinned = Trust {
            roots: vec![cp.root_pk().0],
            policy_pins: crate::trust::pins_for(cp.root_pk().0, policy_pk),
            ..trust()
        };
        let answer = |approval: Option<&str>, item: &[u8]| {
            let mut v = serde_json::json!({
                "collection_id": crate::secrets::uuid_string(&C),
                "enrolled_at": 7,
                "log_url": "https://log.lab.mdbase.dev",
                "genesis": { "seq": 1, "item": crate::secrets::hex(item) },
                "device": { "token": "dev_fixture_token", "expires_at": 1_800_000_000_000i64 },
            });
            if let Some(a) = approval {
                v["approval"] = serde_json::json!(a);
            }
            v
        };
        for approval in [None, Some("pending")] {
            let joined = crate::cloud::Joined::parse(&answer(approval, &item)).unwrap();
            assert_eq!(
                joined.log_url.as_deref(),
                Some("https://log.lab.mdbase.dev")
            );
            assert_eq!(joined.expires_at, 1_800_000_000_000);
            let genesis = joined.genesis_item.as_deref().expect("genesis bytes");
            assert_eq!(genesis, &item[..]);
            assert_eq!(
                verify_genesis(genesis, &C, &pinned, CState::CloudCopy).unwrap(),
                mdbn_wire::hash::chain_hash(&item).0
            );
        }
        // Candidate bytes are never trusted on their own: a tampered item parses but
        // does not verify, and an answer without log_url/genesis parses with
        // neither, which the join path refuses as control_plane_outdated.
        let mut tampered = item.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        let joined = crate::cloud::Joined::parse(&answer(None, &tampered)).unwrap();
        assert!(
            verify_genesis(
                joined.genesis_item.as_deref().unwrap(),
                &C,
                &pinned,
                CState::CloudCopy
            )
            .is_err()
        );
        let old = serde_json::json!({
            "collection_id": crate::secrets::uuid_string(&C),
            "enrolled_at": 7,
            "device": { "token": "dev_fixture_token", "expires_at": 1_800_000_000_000i64 },
        });
        let joined = crate::cloud::Joined::parse(&old).unwrap();
        assert!(joined.log_url.is_none() && joined.genesis_item.is_none());
        let mut wrong_seq = answer(None, &item);
        wrong_seq["genesis"]["seq"] = serde_json::json!(2);
        assert!(crate::cloud::Joined::parse(&wrong_seq).is_err());
    }
}
