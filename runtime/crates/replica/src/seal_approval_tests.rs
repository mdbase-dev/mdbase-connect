//! PUBLIC synthetic keys, real SAS/HPKE. No native custody/persistence claim.
use super::*;
use crate::approval::{Answer, ApprovalError, Approver, NewDevice};
use crate::crypto::{TestEntropy, keys::EnrolledKeys};
use crate::policy::{DeviceState, PolicyState};
use mdbn_wire::policy::{CState, DeviceKind, Role};

const COL: Uuid = B16([7; 16]);
const ACCOUNT: Uuid = B16([8; 16]);
const ME: Uuid = B16([1; 16]);
const NEW: Uuid = B16([2; 16]);

fn tuple(id: Uuid, seed: u8) -> EnrolledKeys {
    EnrolledKeys {
        device: id,
        sign_pk: DeviceSigner::from_seed(&[seed; 32]).public(),
        kem_pk: KemKeyPair::from_secret(&[seed; 32]).pk,
        noise_pk: KemKeyPair::from_secret(&[seed + 1; 32]).pk,
    }
}
fn device(k: &EnrolledKeys, keyed: bool, commit: Option<[u8; 32]>) -> DeviceState {
    DeviceState {
        account: ACCOUNT,
        kind: DeviceKind::Desktop,
        sign_pk: B32(k.sign_pk),
        kem_pk: B32(k.kem_pk),
        noise_pk: B32(k.noise_pk),
        active: true,
        keyed,
        introduced_by: None,
        delivered_by: None,
        local_root: None,
        sas_commit: commit.map(B32),
    }
}
fn exchange() -> (KeyringSealer, PolicyState, Approver, String) {
    let mut entropy = TestEntropy::new(71);
    let a = tuple(ME, 10);
    let n = tuple(NEW, 20);
    let mut joiner = NewDevice::new(COL, n, &mut entropy);
    let mut p = PolicyState::new();
    p.cstate = Some(CState::E2e);
    p.epoch = 1;
    p.members.insert(ACCOUNT, Role::Owner);
    p.devices.insert(ME, device(&a, true, None));
    p.devices
        .insert(NEW, device(&n, false, Some(joiner.commitment())));
    let mut approver = Approver::new(COL, ME);
    let r_a = approver.start(&p, &NEW, &mut entropy).unwrap();
    let Answer::Reveal { r_n, code, .. } = joiner.on_challenge(&p, &ME, &r_a) else {
        panic!("reveal");
    };
    // The expected value is deliberately not used for USER input.
    drop(approver.on_reveal(&p, &NEW, &r_n).unwrap());
    let mut sealer = KeyringSealer::new(COL, ME, &[10; 32], &[10; 32]);
    sealer.keys.insert(1, Secret32([0x80; 32]));
    sealer.set_epoch(1);
    (sealer, p, approver, code)
}

#[test]
fn private_bridge_real_wrap_decrypts_only_to_requester() {
    let (sealer, p, mut a, typed) = exchange();
    let payload = sealer
        .approve_private_device(&mut a, &p, ACCOUNT, &NEW, &typed, &mut TestEntropy::new(72))
        .unwrap();
    let commit = B32(keys::key_commit(&Secret32([0x80; 32]), &COL, 1).unwrap());
    let opened =
        keys::open_key_grant(&payload, &COL, &KemKeyPair::from_secret(&[20; 32]), &commit).unwrap();
    assert_eq!(opened.expose(), &[0x80; 32]);
    assert!(
        keys::open_key_grant(&payload, &COL, &KemKeyPair::from_secret(&[21; 32]), &commit).is_err()
    );
}

#[test]
fn private_bridge_denies_account_custody_epoch_and_mode_mismatches() {
    for case in 0..7 {
        let (mut sealer, mut p, mut a, typed) = exchange();
        let account = if case == 0 { B16([9; 16]) } else { ACCOUNT };
        match case {
            1 => p.devices.get_mut(&ME).unwrap().sign_pk = B32([0; 32]),
            2 => p.devices.get_mut(&ME).unwrap().kem_pk = B32([0; 32]),
            3 => sealer.set_epoch(2),
            4 => p.rekey_required = true,
            5 => p.cstate = Some(CState::CloudCopy),
            6 => a = Approver::new(B16([9; 16]), ME),
            _ => {}
        }
        assert_eq!(
            sealer.approve_private_device(
                &mut a,
                &p,
                account,
                &NEW,
                &typed,
                &mut TestEntropy::new(72)
            ),
            Err(ApprovalError::NotApprover),
            "case {case}"
        );
    }
}

#[test]
fn private_bridge_denies_service_targets_and_nonmembers() {
    for case in 0..3 {
        let (sealer, mut p, mut a, typed) = exchange();
        match case {
            0 => p.devices.get_mut(&NEW).unwrap().kind = DeviceKind::Escrow,
            1 => p.devices.get_mut(&NEW).unwrap().account = crate::policy::SERVICE_ACCOUNT,
            2 => {
                p.members.remove(&ACCOUNT);
            }
            _ => unreachable!(),
        }
        assert_eq!(
            sealer.approve_private_device(
                &mut a,
                &p,
                ACCOUNT,
                &NEW,
                &typed,
                &mut TestEntropy::new(72)
            ),
            Err(ApprovalError::NotWaiting)
        );
    }
}

#[test]
fn private_bridge_default_denies_plain_sealer_and_rechecks_latest_commit() {
    let (_, p, mut a, typed) = exchange();
    assert_eq!(
        PlainSealer::for_device(ME).approve_private_device(
            &mut a,
            &p,
            ACCOUNT,
            &NEW,
            &typed,
            &mut TestEntropy::new(72)
        ),
        Err(ApprovalError::NotApprover)
    );
    let (sealer, mut p, mut a, typed) = exchange();
    p.devices.get_mut(&NEW).unwrap().sas_commit = Some(B32([0x11; 32]));
    assert_eq!(
        sealer.approve_private_device(&mut a, &p, ACCOUNT, &NEW, &typed, &mut TestEntropy::new(72)),
        Err(ApprovalError::NotWaiting)
    );
}
