//! Local-read lifetime/custody fences; these are engine unit tests, not LAB evidence.
use super::*;

#[test]
fn pending_read_cut_retains_generation_catalogue_control_key_and_authority_fences() {
    for case in 0..9 {
        let (_, mut a, source) = configured();
        a.create(1, "pending.base", &source);
        let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
        assert!(a.r.collection_setup_capture_fence(None).is_err());
        match case {
            0 => a.r.store_generation += 1,
            1 => a.r.repair_generation += 1,
            2 => a.r.catalog = Arc::new((*a.r.catalog).clone()),
            3 => a.r.policy.ctl_chain = B32([99; 32]),
            4 => a.r.policy.epoch += 1,
            5 => a.r.policy.rekey_required = true,
            6 => a.r.policy.frozen = true,
            7 => {
                a.r.policy
                    .devices
                    .get_mut(&a.r.cfg.device_id)
                    .unwrap()
                    .active = false
            }
            8 => {
                let account = a.r.policy.devices[&a.r.cfg.device_id].account;
                a.r.policy
                    .members
                    .insert(account, mdbn_wire::policy::Role::Viewer);
            }
            _ => unreachable!(),
        }
        assert!(
            a.r.recheck_bases_discovery(&capture).is_err(),
            "cut mutation {case}"
        );
        if case >= 4 {
            assert!(
                a.r.capture_bases_discovery(Some("UTC")).is_err(),
                "admission mutation {case}"
            );
        }
    }
}
