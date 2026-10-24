use super::*;
fn hello(a: &mut Node, grant: B16, key: [u8; 32]) -> SessionId {
    a.r.hello(
        SessionAuth::Grant {
            grant,
            client_pk: key,
        },
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "Bases read gate".into(),
            client_version: "test".into(),
            features: None,
            timezone: None,
        },
    )
    .unwrap()
    .0
}
#[test]
fn bases_read_gate_checks_current_session_read_and_full_scope() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    assert!(a.r.authorize_bases_read(a.s).is_ok());
    assert_eq!(
        a.r.authorize_bases_read(SessionId(u64::MAX))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    let cases = [
        (B16([0x51; 16]), [0x61; 32], vec!["collection.read"], None),
        (
            B16([0x52; 16]),
            [0x62; 32],
            vec!["collection.read"],
            Some(vec!["photos".into()]),
        ),
        (B16([0x53; 16]), [0x63; 32], vec!["records.create"], None),
    ];
    for (grant, key, caps, folders) in &cases {
        cp.approved_grant(&svc, *grant, *key, caps, folders.clone(), B16([101; 16]));
    }
    settle(&mut [&mut a]);
    let full = hello(&mut a, cases[0].0, cases[0].1);
    let narrow = hello(&mut a, cases[1].0, cases[1].1);
    let no_read = hello(&mut a, cases[2].0, cases[2].1);
    assert!(a.r.authorize_bases_read(full).is_ok());
    let denied = a.r.authorize_bases_read(narrow).unwrap_err();
    assert_eq!(denied.code(), Some(ErrorCode::Forbidden));
    assert_eq!(
        denied.problem().reason.as_deref(),
        Some("view_full_collection_required")
    );
    assert_eq!(
        a.r.authorize_bases_read(no_read).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
    cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::GrantRevoke(
            mdbn_wire::policy::GrantRevoke { grant: cases[0].0 },
        )],
    );
    settle(&mut [&mut a]);
    assert!(
        a.r.authorize_bases_read(full).is_err(),
        "publication recheck must reject revoked authority"
    );
    a.r.close(a.s);
    assert!(
        a.r.authorize_bases_read(a.s).is_err(),
        "unknown scope None is not full-collection authority"
    );
}
