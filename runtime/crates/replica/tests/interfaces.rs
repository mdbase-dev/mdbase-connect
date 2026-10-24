//! Smoke tests for the interface types.

use mdbn_replica::api::ErrorCode;
use mdbn_replica::store::{PendingRow, bucket16};
use mdbn_wire::client::ERROR_CODES;
use mdbn_wire::common::{B16, B32, Text};
use mdbn_wire::intent::{ConflictMode, Create, Mutation, Op, OpClock, Source};

#[test]
fn error_codes_match_the_wire_table() {
    assert_eq!(ErrorCode::ALL.len(), ERROR_CODES.len());
    for (code, (wire, recovery)) in ErrorCode::ALL.iter().zip(ERROR_CODES.iter()) {
        assert_eq!(code.as_str(), *wire);
        assert_eq!(code.recovery(), *recovery);
        assert_eq!(ErrorCode::parse(wire), Some(*code));
    }
}

#[test]
fn pending_row_round_trips() {
    let m = Mutation {
        id: B16([1; 16]),
        origin: B16([2; 16]),
        base_seq: 7,
        clock: OpClock {
            instant: 1_700_000_000_000,
            tz: "UTC".into(),
            local_date: "2023-11-14".into(),
        },
        seed: B32([3; 32]),
        source: Source::Api,
        ops: vec![Op::Create(Create {
            id: B16([4; 16]),
            path: Some("a.md".into()),
            type_name: None,
            frontmatter: None,
            body: Some(Text::from("hello")),
            document: None,
        })],
        on_behalf: None,
        conflict_mode: Some(ConflictMode::Reject),
        validated_at: None,
        room: None,
    };
    let row = PendingRow {
        order: 9,
        mutation: m.into(),
        effects: vec![],
        touches: vec!["i:x".into()],
        grant: Some(B16([5; 16])),
        uploads: vec![],
        refs: Vec::new(),
    };
    let back = PendingRow::from_bytes(&row.to_bytes()).expect("decodes");
    assert_eq!(back, row);
}

#[test]
fn bucket_is_first_two_digest_bytes() {
    let id = B16([0; 16]);
    let d = mdbn_wire::hash::sha256(&id.0);
    assert_eq!(bucket16(&id), u16::from_be_bytes([d.0[0], d.0[1]]));
}
