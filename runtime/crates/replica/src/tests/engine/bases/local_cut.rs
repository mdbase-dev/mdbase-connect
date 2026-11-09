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

/// A local-only replica (the app's unsynced collection) with the fixture's
/// Base contract and one Base source: no log, keys or policy device.
fn local_only(source: &str) -> (Replica<MemStore>, SessionId) {
    let device = B16([101; 16]);
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([1; 16]),
        device_id: device,
        mode: mdbn_wire::client::SyncMode::LocalOnly,
        log_endpoint: EndpointId(0),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![],
        trusted_signers: vec![device],
        e2e: false,
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    };
    let mut r = Replica::open(
        cfg,
        MemStore::new(),
        Box::new(crate::plan::CorePlanner),
        Box::new(PlainSealer::for_device(device)),
        Host {
            clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "app".into(),
                client_version: "test".into(),
                features: None,
                timezone: Some("UTC".into()),
            },
        )
        .unwrap();
    let mut ops = setup_ops();
    ops.push(Op::Create(Create {
        id: B16([1; 16]),
        path: Some("view.base".into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(Text::Inline(source.into())),
    }));
    r.submit(s, submission(ops)).unwrap();
    r.tick();
    assert_eq!(r.store.pending_count().unwrap(), 0, "local commits confirm");
    (r, s)
}

#[test]
fn local_only_reads_bases_under_the_same_generation_catalogue_and_head_fence() {
    let source = fixture()["source"].as_str().unwrap().to_owned();
    for case in 0..5 {
        let (mut r, s) = local_only(&source);
        assert!(r.policy.devices.is_empty(), "no keyed device to name");
        r.authorize_bases_read(s).unwrap();
        let capture = r.capture_bases_discovery(Some("UTC")).unwrap();
        assert_eq!(capture.views()[0].record, B16([1; 16]));
        r.recheck_bases_discovery(&capture).unwrap();
        match case {
            0 => r.store_generation += 1,
            1 => r.repair_generation += 1,
            2 => r.catalog = Arc::new((*r.catalog).clone()),
            // A later local commit moves the head.
            3 => {
                let create = Op::Create(Create {
                    id: B16([2; 16]),
                    path: Some("task.md".into()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline("---\nstatus: open\n---\n".into())),
                });
                r.submit(s, submission(vec![create])).unwrap();
                r.tick();
            }
            4 => r.apply_fault = true,
            _ => unreachable!(),
        }
        assert!(
            r.recheck_bases_discovery(&capture).is_err(),
            "cut mutation {case}"
        );
    }
}

#[test]
fn only_local_only_mode_takes_the_unkeyed_read_authority() {
    let source = fixture()["source"].as_str().unwrap().to_owned();
    let (mut r, _) = local_only(&source);
    r.capture_bases_discovery(Some("UTC")).unwrap();
    // The same unkeyed replica in synced mode is refused exactly as before.
    r.cfg.mode = mdbn_wire::client::SyncMode::Synced;
    let error = r.capture_bases_discovery(Some("UTC")).err().unwrap();
    assert_eq!(error.code(), Some(ErrorCode::Forbidden));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("view_requires_keyed_device")
    );
}
