//! A test control plane: genesis and enrolment items for tests and the simulator.
//!
//! **Test only** (`cfg(test)` or the `testing` feature). Items are signed with the
//! all-zero signature that [`crate::seal::ZeroVerifier`] accepts, so they pair with
//! [`crate::seal::PlainSealer`]. Production control items come from the control
//! plane with real Ed25519 signatures.

use mdbn_wire::common::{B16, B32, B64, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyWrap, RekeyPayload, RekeyReason, SealedBox};
use mdbn_wire::log_service::AppendParams;
use mdbn_wire::policy::{
    CState, CpCert, DeviceEnrol, DeviceKind, DeviceRevoke, Genesis, MemberSet, PolicyOp,
    PolicyPayload, Role,
};
use mdbn_wire::schema::Wire;

use crate::crypto::sign::DeviceSigner;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogRequest, LogResponse};
use crate::policy::key_id;

/// The test root public key; put it in `ReplicaConfig::trusted_roots`.
pub const TEST_ROOT: [u8; 32] = [0x7a; 32];
/// The test control plane's policy key.
pub const TEST_CP: [u8; 32] = [0x7b; 32];
/// The test owner account.
pub const TEST_OWNER: Uuid = B16([0xa0; 16]);

/// A device to enrol.
#[derive(Debug, Clone, Copy)]
pub struct TestDevice {
    /// Device ID.
    pub device: Uuid,
    /// Its member account.
    pub account: Uuid,
    /// Kind.
    pub kind: DeviceKind,
}

/// Seeds of the signing test control plane's Ed25519 root and policy keys.
pub const SIGNED_ROOT_SEED: [u8; 32] = [0x71; 32];
/// Policy key seed.
pub const SIGNED_CP_SEED: [u8; 32] = [0x72; 32];

/// The signing test control plane's root public key.
pub fn signed_root() -> [u8; 32] {
    DeviceSigner::from_seed(&SIGNED_ROOT_SEED).public()
}

/// A test control plane appending to a [`FakeLogService`].
#[derive(Debug)]
pub struct TestControlPlane {
    collection: Uuid,
    issued: i64,
    /// Real Ed25519 signatures (for [`crate::seal::KeyringSealer`]); otherwise zero
    /// signatures for [`crate::seal::PlainSealer`].
    signed: bool,
}

impl TestControlPlane {
    fn root_pk(&self) -> [u8; 32] {
        if self.signed {
            signed_root()
        } else {
            TEST_ROOT
        }
    }

    fn cp_pk(&self) -> [u8; 32] {
        if self.signed {
            DeviceSigner::from_seed(&SIGNED_CP_SEED).public()
        } else {
            TEST_CP
        }
    }

    fn cert(&self) -> CpCert {
        let mut c = CpCert {
            policy_pk: B32(self.cp_pk()),
            not_before: 0,
            not_after: i64::MAX,
            root: key_id(&self.root_pk()),
            sig: B64([0; 64]),
        };
        if self.signed
            && let Ok(d) = c.signed_digest()
        {
            c.sig = B64(DeviceSigner::from_seed(&SIGNED_ROOT_SEED).sign_digest(&d.0));
        }
        c
    }

    /// A control plane that signs with real Ed25519 keys; trust [`signed_root`].
    pub fn signed(collection: Uuid) -> TestControlPlane {
        TestControlPlane {
            collection,
            issued: 1,
            signed: true,
        }
    }
}

impl TestControlPlane {
    /// A control plane for `collection`.
    pub fn new(collection: Uuid) -> TestControlPlane {
        TestControlPlane {
            collection,
            issued: 1,
            signed: false,
        }
    }

    /// Append one policy item with `ops` at the service's head.
    pub fn append(&mut self, svc: &FakeLogService, ops: Vec<PolicyOp>) -> u64 {
        let (head, prev) = svc.head(&self.collection);
        self.issued += 1;
        let payload = PolicyPayload {
            cert: self.cert(),
            issued_at: self.issued,
            ops,
        };
        let mut item = Item {
            kind: ItemKind::Policy,
            collection: self.collection,
            seq: Some(head + 1),
            prev: Some(prev),
            epoch: None,
            signer: Some(key_id(&self.cp_pk())),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(payload.to_bytes().unwrap_or_default()),
            sig: Some(B64([0; 64])),
        };
        if self.signed {
            let _ = DeviceSigner::from_seed(&SIGNED_CP_SEED).sign_item(&mut item);
        }
        let bytes = item.to_bytes().unwrap_or_default();
        let mut c = svc.client(B16([0xcc; 16]));
        let r = c.call(LogRequest::Append(AppendParams {
            collection: self.collection,
            expect_seq: head + 1,
            expect_prev: prev,
            items: vec![Bytes(bytes.clone())],
        }));
        assert!(matches!(r, Ok(LogResponse::Append(_))), "{r:?}");
        head + 1
    }

    /// Genesis with the owner and these devices enrolled and members set.
    pub fn genesis(&mut self, svc: &FakeLogService, state: CState, devices: &[TestDevice]) -> u64 {
        let mut ops = vec![
            PolicyOp::Genesis(Genesis {
                owner: TEST_OWNER,
                root: key_id(&self.root_pk()),
                state,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Owner,
            }),
        ];
        let mut members = std::collections::BTreeSet::new();
        for d in devices {
            if d.account != TEST_OWNER
                && d.account != crate::policy::SERVICE_ACCOUNT
                && members.insert(d.account)
            {
                ops.push(PolicyOp::MemberSet(MemberSet {
                    account: d.account,
                    role: Role::Editor,
                }));
            }
        }
        for d in devices {
            ops.push(enrol(d));
        }
        self.append(svc, ops)
    }

    /// Genesis with `devices` (all of the owner's account), then the `initial` rekey
    /// by the first device, wrapping for all of them. Every device is keyed at epoch 1
    /// from position 2. With [`crate::seal::PlainSealer`] only.
    pub fn bootstrap(&mut self, svc: &FakeLogService, state: CState, devices: &[Uuid]) -> u64 {
        let ds: Vec<TestDevice> = devices
            .iter()
            .map(|d| TestDevice {
                device: *d,
                account: TEST_OWNER,
                kind: DeviceKind::Desktop,
            })
            .collect();
        self.genesis(svc, state, &ds);
        let payload = RekeyPayload {
            epoch: 1,
            from: 0,
            commit: B32([0; 32]),
            wraps: {
                let mut v: Vec<Uuid> = devices.to_vec();
                v.sort();
                v.dedup();
                v.into_iter()
                    .map(|device| KeyWrap {
                        device,
                        enc: B32([0; 32]),
                        ct: Bytes(vec![0; 48]),
                    })
                    .collect()
            },
            history: SealedBox {
                salt: B16([0; 16]),
                ct: Bytes(Vec::new()),
            },
            reason: RekeyReason::Initial,
        };
        self.append_item(
            svc,
            ItemKind::Rekey,
            devices[0],
            payload.to_bytes().unwrap_or_default(),
        )
    }

    /// Append a clear device-signed control item (zero signature).
    pub fn append_item(
        &mut self,
        svc: &FakeLogService,
        kind: ItemKind,
        signer: Uuid,
        body: Vec<u8>,
    ) -> u64 {
        let (head, prev) = svc.head(&self.collection);
        let item = Item {
            kind,
            collection: self.collection,
            seq: Some(head + 1),
            prev: Some(prev),
            epoch: None,
            signer: Some(signer),
            salt: None,
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(body),
            sig: Some(B64([0; 64])),
        };
        let mut c = svc.client(B16([0xcd; 16]));
        let r = c.call(LogRequest::Append(AppendParams {
            collection: self.collection,
            expect_seq: head + 1,
            expect_prev: prev,
            items: vec![Bytes(item.to_bytes().unwrap_or_default())],
        }));
        assert!(matches!(r, Ok(LogResponse::Append(_))), "{r:?}");
        head + 1
    }

    /// A grant for an app, approved by `approver` (a keyed owner device) with these
    /// capabilities and folders, as an e2e collection requires. With
    /// [`crate::seal::PlainSealer`] only (the approval's sealed body is plaintext).
    pub fn approved_grant(
        &mut self,
        svc: &FakeLogService,
        grant: Uuid,
        client_pk: [u8; 32],
        capabilities: &[&str],
        folders: Option<Vec<String>>,
        approver: Uuid,
    ) -> u64 {
        let caps: Vec<String> = capabilities.iter().map(|c| c.to_string()).collect();
        self.append(
            svc,
            vec![PolicyOp::Grant(mdbn_wire::policy::Grant {
                grant,
                installation: B16([0x56; 16]),
                app_id: "app".into(),
                account: TEST_OWNER,
                capabilities: caps.clone(),
                client_pk: B32(client_pk),
                file_folders: None,
                folder_scoped: folders.as_ref().map(|_| true),
            })],
        );
        let body = mdbn_wire::policy::GrantApprovalPayload {
            grant,
            client_pk: B32(client_pk),
            capabilities: caps,
            file_folders: folders,
        }
        .to_bytes()
        .unwrap_or_default();
        let (head, prev) = svc.head(&self.collection);
        let item = Item {
            kind: ItemKind::GrantApproval,
            collection: self.collection,
            seq: Some(head + 1),
            prev: Some(prev),
            epoch: Some(1),
            signer: Some(approver),
            salt: Some(B16([0; 16])),
            idem: None,
            refs: None,
            stream: None,
            body: Bytes(body),
            sig: Some(B64([0; 64])),
        };
        let mut c = svc.client(B16([0xce; 16]));
        let r = c.call(LogRequest::Append(AppendParams {
            collection: self.collection,
            expect_seq: head + 1,
            expect_prev: prev,
            items: vec![Bytes(item.to_bytes().unwrap_or_default())],
        }));
        assert!(matches!(r, Ok(LogResponse::Append(_))), "{r:?}");
        head + 1
    }

    /// Revoke a device.
    pub fn revoke(&mut self, svc: &FakeLogService, device: Uuid) -> u64 {
        self.append(svc, vec![PolicyOp::DeviceRevoke(DeviceRevoke { device })])
    }

    /// Enrol another device.
    pub fn enrol(&mut self, svc: &FakeLogService, d: TestDevice) -> u64 {
        self.append(svc, vec![enrol(&d)])
    }

    /// Genesis enrolling one device with real keys (`sign_seed`, `kem_sk`), for a
    /// replica running [`crate::seal::KeyringSealer`]; it does the initial rekey.
    pub fn genesis_with_keys(
        &mut self,
        svc: &FakeLogService,
        state: CState,
        device: Uuid,
        sign_seed: &[u8; 32],
        kem_sk: &[u8; 32],
    ) -> u64 {
        let sign_pk = DeviceSigner::from_seed(sign_seed).public();
        let kem_pk = crate::crypto::hpke::KemKeyPair::from_secret(kem_sk).pk;
        let ops = vec![
            PolicyOp::Genesis(Genesis {
                owner: TEST_OWNER,
                root: key_id(&self.root_pk()),
                state,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Owner,
            }),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device,
                account: TEST_OWNER,
                kind: DeviceKind::Desktop,
                sign_pk: B32(sign_pk),
                kem_pk: B32(kem_pk),
                noise_pk: B32([9; 32]),
                sas_commit: None,
                local_root: None,
            }),
        ];
        self.append(svc, ops)
    }
}

fn enrol(d: &TestDevice) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device: d.device,
        account: d.account,
        kind: d.kind,
        sign_pk: B32([d.device.0[0]; 32]),
        kem_pk: B32([d.device.0[0]; 32]),
        noise_pk: B32([d.device.0[0]; 32]),
        sas_commit: None,
        local_root: None,
    })
}
