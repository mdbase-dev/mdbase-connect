//! The fake log service behaves like the contract says (the parts replicas observe).

use mdbn_replica::fake::FakeLogService;
use mdbn_replica::log::{LogClient, LogError, LogErrorCode, LogRequest, LogResponse};
use mdbn_wire::common::{B16, B32, B64, Bytes, Hash};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash};
use mdbn_wire::log_service::{AppendParams, AppendResult, ReadParams};
use mdbn_wire::schema::Wire;

const COL: B16 = B16([7; 16]);

fn entry(seq: u64, prev: Hash, idem: u8, refs: Option<Vec<B32>>) -> Vec<u8> {
    Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(seq),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(B16([1; 16])),
        salt: Some(B16([seq as u8; 16])),
        idem: Some(B16([idem; 16])),
        refs,
        stream: None,
        body: Bytes(vec![seq as u8; 10]),
        sig: Some(B64([0; 64])),
    }
    .to_bytes()
    .unwrap()
}

fn append(
    c: &mut impl LogClient,
    seq: u64,
    prev: Hash,
    items: Vec<Vec<u8>>,
) -> Result<LogResponse, LogError> {
    c.call(LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: seq,
        expect_prev: prev,
        items: items.into_iter().map(Bytes).collect(),
    }))
}

#[test]
fn conditional_append_replay_and_tokens() {
    let svc = FakeLogService::new();
    let mut a = svc.client(B16([1; 16]));
    let mut b = svc.client(B16([2; 16]));
    let e1 = entry(1, CHAIN_ZERO, 1, None);
    let h1 = chain_hash(&e1);
    let e2 = entry(2, h1, 2, None);
    let r = append(&mut a, 1, CHAIN_ZERO, vec![e1.clone(), e2.clone()]).unwrap();
    let LogResponse::Append(AppendResult::Appended(ok)) = r else {
        panic!("{r:?}")
    };
    assert_eq!((ok.first, ok.last), (1, 2));
    // I4: byte-identical retry succeeds.
    let r = append(&mut a, 1, CHAIN_ZERO, vec![e1, e2.clone()]).unwrap();
    assert!(matches!(r, LogResponse::Append(AppendResult::Appended(_))));
    // I2: a stale writer sees head_moved.
    let other = entry(1, CHAIN_ZERO, 9, None);
    let r = append(&mut b, 1, CHAIN_ZERO, vec![other]).unwrap();
    let LogResponse::Append(AppendResult::HeadMoved(hm)) = r else {
        panic!("{r:?}")
    };
    assert_eq!(hm.head, 2);
    // I5: a repeated token is a duplicate.
    let h2 = chain_hash(&e2);
    let r = append(&mut b, 3, h2, vec![entry(3, h2, 1, None)]).unwrap();
    let LogResponse::Append(AppendResult::Duplicate(d)) = r else {
        panic!("{r:?}")
    };
    assert_eq!((d.index, d.seq), (0, 1));
    // A wrong chain inside the batch is invalid.
    let r = append(&mut b, 3, h2, vec![entry(3, B32([5; 32]), 3, None)]).unwrap_err();
    assert!(matches!(
        r,
        LogError::Service {
            code: LogErrorCode::Invalid,
            ..
        }
    ));
    // Refs must exist.
    let r = append(
        &mut b,
        3,
        h2,
        vec![entry(3, h2, 4, Some(vec![B32([8; 32])]))],
    )
    .unwrap_err();
    assert!(matches!(
        r,
        LogError::Service {
            code: LogErrorCode::RefsMissing,
            ..
        }
    ));
    // Subscribers got the items; reads return exact bytes.
    let r = b
        .call(LogRequest::Read(ReadParams {
            collection: COL,
            after: 0,
            limit: 10,
            kinds: None,
            max_bytes: None,
        }))
        .unwrap();
    let LogResponse::Read(rr) = r else { panic!() };
    assert_eq!(rr.items.len(), 2);
    assert_eq!(rr.items[1].item.0, svc.items(&COL)[1]);
}

#[test]
fn lost_reply_then_retry_same_bytes() {
    let svc = FakeLogService::new();
    let mut a = svc.client(B16([1; 16]));
    a.faults.lose_replies = 1;
    let e1 = entry(1, CHAIN_ZERO, 1, None);
    assert_eq!(
        append(&mut a, 1, CHAIN_ZERO, vec![e1.clone()]),
        Err(LogError::NoResponse)
    );
    assert_eq!(svc.head(&COL).0, 1, "it was committed");
    let r = append(&mut a, 1, CHAIN_ZERO, vec![e1]).unwrap();
    assert!(matches!(r, LogResponse::Append(AppendResult::Appended(_))));
}
