use super::*;

#[test]
fn hello_negotiates_file_identity_minor_without_dropping_older_clients() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    for (minors, expected) in [
        (vec![0], 0),
        (vec![1], 1),
        (vec![0, 9, 1], 1),
        (vec![0, 9, 2, 1], 2),
    ] {
        let params = HelloParams {
            versions: minors
                .into_iter()
                .map(|minor| Version { major: 1, minor })
                .collect(),
            client_name: "file-identity-test".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        };
        let (session, hello) = a.r.hello(SessionAuth::Host, params).unwrap();
        assert_eq!(
            hello.version,
            Version {
                major: 1,
                minor: expected
            }
        );
        a.r.close(session);
    }
    let params = HelloParams {
        versions: vec![Version { major: 1, minor: 3 }],
        client_name: "future-only".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    assert_eq!(
        a.r.hello(SessionAuth::Host, params).unwrap_err().code(),
        Some(ErrorCode::UpgradeRequired)
    );
}
