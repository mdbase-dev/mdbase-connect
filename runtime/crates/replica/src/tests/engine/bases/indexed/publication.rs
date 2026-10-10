use super::*;
mod discovery;
mod window;
fn actor() -> (
    Replica<ProjectionStore>,
    SessionId,
    String,
    BTreeMap<String, String>,
) {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../../data/bases-first-slice.json")).unwrap();
    let source = expected["sources"][0]["source"]
        .as_str()
        .unwrap()
        .to_owned();
    let (svc, mut a, _) = configured();
    a.create(11, "Views/actual.base", &source);
    for (i, record) in expected["records"].as_array().unwrap().iter().enumerate() {
        a.create(
            (i + 1) as u8,
            record["path"].as_str().unwrap(),
            record["source"].as_str().unwrap(),
        );
    }
    settle(&mut [&mut a]);
    a.clock.set(expected["now_ms"].as_u64().unwrap());
    let mut r = projected(&svc, a);
    let (session, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "native codec fence test".into(),
                client_version: "test".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    (
        r,
        session,
        source,
        BTreeMap::from([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]),
    )
}
#[test]
fn qualified_read_runs_codec_and_original_two_source_reads_before_publication() {
    let (mut r, session, source, hints) = actor();
    let encoded = r
        .encode_indexed_bases_read(
            session,
            selection(&source, 0),
            &hints,
            "UTC",
            |result| {
                assert!(!result.rows.is_empty());
                Ok(1)
            },
            |_, size| {
                assert_eq!(size, 1);
                Ok(vec![0])
            },
        )
        .unwrap();
    assert_eq!(encoded, vec![0]);
    assert_eq!(r.store().reads.get(), 2);
    assert_eq!(r.store().pages.get(), 1);
}
#[test]
fn unknown_session_has_no_source_projection_measure_or_encode_effects() {
    let (mut r, _, source, hints) = actor();
    let measured = Cell::new(false);
    let encoded = Cell::new(false);
    assert!(
        r.encode_indexed_bases_read(
            SessionId(u64::MAX),
            selection(&source, 0),
            &hints,
            "UTC",
            |_| {
                measured.set(true);
                Ok(1)
            },
            |_, _| {
                encoded.set(true);
                Ok(vec![0])
            }
        )
        .is_err()
    );
    assert!(!measured.get());
    assert!(!encoded.get());
    assert_eq!(r.store().reads.get(), 0);
    assert_eq!(r.store().pages.get(), 0);
}
#[test]
fn publication_keeps_final_independent_source_and_raw_state_checks_after_encoding() {
    let (mut r, session, source, hints) = actor();
    let ready = r.store().ready.clone();
    let encoded = Cell::new(false);
    let result = r.encode_indexed_bases_read(
        session,
        selection(&source, 0),
        &hints,
        "UTC",
        |_| Ok(1),
        |_, _| {
            encoded.set(true);
            ready.set(false);
            Ok(vec![0])
        },
    );
    assert!(
        encoded.get(),
        "exercise post-codec final fence, not early refusal"
    );
    assert!(
        result.is_err(),
        "a private encoded buffer is not publication authority"
    );
}
#[test]
fn output_resident_charge_precedes_allocation_on_same_execution_ledger() {
    let (mut r, session, source, hints) = actor();
    let encoded = Cell::new(false);
    let result = r.encode_indexed_bases_read(
        session,
        selection(&source, 0),
        &hints,
        "UTC",
        |_| Ok(128 * 1024 * 1024),
        |_, _| {
            encoded.set(true);
            Ok(vec![])
        },
    );
    assert!(
        !encoded.get(),
        "no output allocation before retained budget admission"
    );
    assert!(result.is_err());
    let failure = result.unwrap_err();
    assert_eq!(failure.code(), Some(ErrorCode::InvalidRequest));
    assert_eq!(
        failure.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
}
