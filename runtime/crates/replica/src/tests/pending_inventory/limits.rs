use super::*;

#[test]
fn pending_inventory_byte_pages_keep_every_original_row_and_order() {
    let service = FakeLogService::new();
    let mut a = node(&service, 1, MemStore::new());
    settle(&mut [&mut a]);
    let mut expected = Vec::new();
    for id in 1..=64u8 {
        expected.push(
            a.create(id, &format!("bytes-{id}.md"), &"x".repeat(80_000))
                .mutation,
        );
    }
    assert_eq!(a.r.store().pending_count().unwrap(), 64);
    let first = a.r.list_pending(a.s, None).unwrap();
    assert!(first.pending.len() < 64);
    let encoded_bytes: usize = first
        .pending
        .iter()
        .map(|p| mdbn_wire::cbor::encode(&p.to_cbor()).unwrap().len())
        .sum();
    assert!(encoded_bytes <= 4 << 20);
    let mut actual: Vec<_> = first.pending.iter().map(|p| p.receipt.mutation).collect();
    let next = a.r.list_pending(a.s, first.next).unwrap();
    assert!(next.next.is_none());
    actual.extend(next.pending.iter().map(|p| p.receipt.mutation));
    assert_eq!(actual, expected);
    assert_eq!(a.r.store().pending_count().unwrap(), 64);
}

#[test]
fn pending_inventory_distinct_write_only_grants_are_scoped_and_revocation_closes_recovery() {
    use crate::api::SessionAuth;
    use crate::testkit::TestControlPlane;
    use mdbn_wire::client::HelloParams;
    use mdbn_wire::common::Version;
    use mdbn_wire::policy::{GrantRevoke, PolicyOp};
    let service = FakeLogService::new();
    let mut a = node(&service, 1, MemStore::new());
    settle(&mut [&mut a]);
    let first = granted(&service, &mut a, "records.create", None);
    let other_grant = B16([0x56; 16]);
    let mut cp = TestControlPlane::new(super::super::engine::COL);
    cp.approved_grant(
        &service,
        other_grant,
        [0x58; 32],
        &["records.create"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let other =
        a.r.hello(
            SessionAuth::Grant {
                grant: other_grant,
                client_pk: [0x58; 32],
            },
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "other-writer".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap()
        .0;
    let host = a.s;
    a.s = first;
    let original = a.create(10, "first.md", "first's original bytes").mutation;
    a.s = other;
    let second = a.create(11, "other.md", "other's original bytes").mutation;
    a.s = host;
    assert_eq!(
        a.r.list_pending(first, None)
            .unwrap()
            .pending
            .iter()
            .map(|p| p.receipt.mutation)
            .collect::<Vec<_>>(),
        vec![original]
    );
    assert_eq!(
        a.r.list_pending(other, None)
            .unwrap()
            .pending
            .iter()
            .map(|p| p.receipt.mutation)
            .collect::<Vec<_>>(),
        vec![second]
    );
    assert_eq!(a.r.list_pending(host, None).unwrap().pending.len(), 2);
    cp.append(
        &service,
        vec![PolicyOp::GrantRevoke(GrantRevoke {
            grant: B16([0x55; 16]),
        })],
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.list_pending(first, None).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}
