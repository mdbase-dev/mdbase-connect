use super::*;
use mdbn_replica::replica::BasesViewDescriptor;
#[test]
fn native_numeric_bytes_match_sdk_shared_discovery_fixture() {
    use mdbn_replica::replica::BasesImplementationDescriptor;
    let fixture = mdbn_core::yaml::parse_value(include_str!(
        "../../../../../../conformance/views/bases-app-discovery-codec.json"
    ))
    .unwrap()
    .unwrap();
    let bytes = |key: &str| {
        let text = fixture.get(key).unwrap().as_str().unwrap();
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect::<Vec<_>>()
    };
    let initial = PageRequest::decode(&bytes("initial_request_hex")).unwrap();
    assert_eq!(initial.limit, 2);
    assert_eq!(initial.zone, "UTC");
    assert!(initial.resume.is_none());
    let resumed = PageRequest::decode(&bytes("resume_request_hex")).unwrap();
    assert!(resumed.resume == Some(BasesDiscoveryHandle([0x55; 32])));
    let source_request = SourceRequest::decode(&bytes("source_request_hex")).unwrap();
    let text = fixture.get("source").unwrap().as_str().unwrap();
    let revision = mdbn_wire::hash::sha256(text.as_bytes());
    assert_eq!(source_request.selection.record, B16([0x11; 16]));
    assert_eq!(source_request.selection.revision, revision);
    assert_eq!(source_request.selection.index, 2);
    let view = |index| BasesViewDescriptor {
        record: B16([0x11; 16]),
        path: "Views/actual.base".into(),
        revision,
        index,
        name: Some("same".into()),
        view_type: "table".into(),
        implementations: vec![BasesImplementationDescriptor {
            type_name: "FixtureType".into(),
            version: "1.0.0".into(),
            contract_digest: B32([0x33; 32]),
            implementation_digest: B32([0x33; 32]),
        }],
    };
    let mut result = BasesDiscoveryPage {
        views: vec![view(0), view(2)],
        clock: native_clock(),
        collection_revision: B32([0x33; 32]),
        next: Some(BasesDiscoveryHandle([0x55; 32])),
    };
    for key in ["list_success_hex", "empty_progress_hex", "eof_hex"] {
        let output = encode(&mut IncrementalBasesBudget::new(), |writer| {
            page(writer, &result)
        })
        .unwrap();
        assert_eq!(output.0, bytes(key));
        result.views.clear();
        if key == "empty_progress_hex" {
            result.next = None;
        }
    }
    let result = BasesViewSource {
        view: view(2),
        source: text.into(),
        clock: native_clock(),
        collection_revision: B32([0x33; 32]),
    };
    let output = encode(&mut IncrementalBasesBudget::new(), |writer| {
        source(writer, &result)
    })
    .unwrap();
    assert_eq!(output.0, bytes("source_success_hex"));
}
fn list_request(limit: u64, resume: Cbor) -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Text("UTC".into())),
        (Cbor::Uint(2), Cbor::Uint(limit)),
        (Cbor::Uint(3), resume),
    ]))
    .unwrap()
}
fn descriptor() -> BasesViewDescriptor {
    BasesViewDescriptor {
        record: B16([1; 16]),
        path: "Views/native.base".into(),
        revision: B32([2; 32]),
        implementations: Vec::new(),
        index: 1,
        name: Some("actual".into()),
        view_type: "table".into(),
    }
}
fn native_clock() -> mdbn_core::intent::OpClock {
    mdbn_core::intent::OpClock {
        instant_ms: 0,
        tz: "UTC".into(),
        local_date: "1970-01-01".into(),
    }
}
#[test]
fn bounded_discovery_request_has_separate_fixed_handle_not_query_cursor() {
    assert!(PageRequest::decode(&list_request(0, Cbor::Null)).is_err());
    assert!(PageRequest::decode(&list_request(129, Cbor::Null)).is_err());
    assert!(PageRequest::decode(&list_request(1, Cbor::Text("query cursor".into()))).is_err());
    let request = PageRequest::decode(&list_request(128, Cbor::Bytes(vec![3; 32]))).unwrap();
    assert_eq!(request.limit, 128);
    assert_eq!(request.zone, "UTC");
    assert!(request.resume == Some(BasesDiscoveryHandle([3; 32])));
    let mut trailing = list_request(1, Cbor::Null);
    trailing.push(0);
    assert!(PageRequest::decode(&trailing).is_err());
}
#[test]
fn source_request_is_exact_identity_revision_ordinal_not_path() {
    let request = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Bytes(vec![1; 16])),
        (Cbor::Uint(2), Cbor::Bytes(vec![2; 32])),
        (Cbor::Uint(3), Cbor::Uint(7)),
        (Cbor::Uint(4), Cbor::Text("UTC".into())),
    ]))
    .unwrap();
    let parsed = SourceRequest::decode(&request).unwrap();
    assert_eq!(parsed.selection.record, B16([1; 16]));
    assert_eq!(parsed.selection.revision, B32([2; 32]));
    assert_eq!(parsed.selection.index, 7);
    assert!(SourceRequest::decode(&list_request(1, Cbor::Null)).is_err());
}
#[test]
fn zero_definition_page_preserves_real_continuation_not_false_eof() {
    let result = BasesDiscoveryPage {
        views: Vec::new(),
        clock: native_clock(),
        collection_revision: B32([4; 32]),
        next: Some(BasesDiscoveryHandle([5; 32])),
    };
    let encoded = encode(&mut IncrementalBasesBudget::new(), |writer| {
        page(writer, &result)
    })
    .unwrap();
    let actual = cbor::decode(&encoded.0).unwrap();
    let expected = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Array(Vec::new())),
        (
            Cbor::Uint(2),
            mdbn_wire::intent::OpClock {
                instant: 0,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            }
            .to_cbor(),
        ),
        (Cbor::Uint(3), Cbor::Bytes(vec![4; 32])),
        (Cbor::Uint(4), Cbor::Bytes(vec![5; 32])),
    ]);
    assert_eq!(actual, expected);
}
#[test]
fn exact_source_text_is_not_truncated_to_cell_text_limit() {
    let text = "é".repeat(3000);
    let result = BasesViewSource {
        view: descriptor(),
        source: text.clone(),
        clock: native_clock(),
        collection_revision: B32([4; 32]),
    };
    let encoded = encode(&mut IncrementalBasesBudget::new(), |writer| {
        source(writer, &result)
    })
    .unwrap();
    let Cbor::Map(fields) = cbor::decode(&encoded.0).unwrap() else {
        panic!("source envelope")
    };
    assert_eq!(fields[2], (Cbor::Uint(2), Cbor::Text(text)));
}
#[test]
fn oversize_source_and_descriptor_pages_refuse_without_output() {
    let result = BasesViewSource {
        view: descriptor(),
        source: "x".repeat(512 * 1024 + 1),
        clock: native_clock(),
        collection_revision: B32([4; 32]),
    };
    assert!(
        encode(&mut IncrementalBasesBudget::new(), |writer| source(
            writer, &result
        ))
        .is_err()
    );
    let result = BasesDiscoveryPage {
        views: (0..129).map(|_| descriptor()).collect(),
        clock: native_clock(),
        collection_revision: B32([4; 32]),
        next: None,
    };
    assert!(
        encode(&mut IncrementalBasesBudget::new(), |writer| page(
            writer, &result
        ))
        .is_err()
    );
}
