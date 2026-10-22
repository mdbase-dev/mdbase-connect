//! Real capture/visibility/runtime-family tests, not metadata-reference inventory.
mod limits;
use super::engine::{node, settle};
use super::resources::granted;
use crate::Store;
use crate::api::{ClientApi, ErrorCode};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use mdbn_wire::common::B16;

#[test]
fn pending_inventory_hidden_only_page_continues_without_exposing_foreign_mutations() {
    let service = FakeLogService::new();
    let mut a = node(&service, 1, MemStore::new());
    settle(&mut [&mut a]);
    let session = granted(&service, &mut a, "records.create", None);
    let mut hidden = Vec::new();
    for id in 1..=64u8 {
        hidden.push(
            a.create(id, &format!("hidden-{id}.md"), "foreign bytes")
                .mutation,
        );
    }
    let host = a.s;
    a.s = session;
    let own = a.create(200, "own.md", "own bytes").mutation;
    a.s = host;
    let first = a.r.list_pending(session, None).unwrap();
    assert!(first.pending.is_empty());
    let next = first.next.unwrap();
    assert!(!hidden.contains(&next));
    let tail = a.r.list_pending(session, Some(next)).unwrap();
    assert!(tail.next.is_none());
    assert_eq!(
        tail.pending
            .iter()
            .map(|p| p.receipt.mutation)
            .collect::<Vec<_>>(),
        vec![own]
    );
    assert_eq!(a.r.list_pending(host, None).unwrap().pending.len(), 64);
    assert_eq!(a.r.store().pending_count().unwrap(), 65);
    assert_eq!(
        a.r.list_pending(host, Some(next)).unwrap_err().code(),
        Some(ErrorCode::InvalidRequest)
    );
    let issued_at = a.r.now().max(a.r.clock_floor).max(a.r.log_time);
    a.clock.set(u64::try_from(issued_at).unwrap() + 300_001);
    assert_eq!(
        a.r.list_pending(session, Some(next)).unwrap_err().code(),
        Some(ErrorCode::InvalidRequest)
    );
}

struct Body(Vec<u8>);
impl crate::replica::AttachmentSource for Body {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), String> {
        out.copy_from_slice(&self.0[offset as usize..offset as usize + out.len()]);
        Ok(())
    }
}
#[test]
fn pending_inventory_contains_actual_file_attach_only_after_original_capture() {
    use crate::log::{LogClient, LogPort, LogRequest};
    let service = FakeLogService::new();
    let mut a = super::attachment_upload::attach_node(&service, 1);
    let session = granted(
        &service,
        &mut a,
        "records.create",
        Some(vec!["files".into()]),
    );
    let (mutation, file) =
        a.r.start_attachment_create(
            session,
            "files/pending.bin".into(),
            Some(B16([202; 16])),
            Box::new(Body(vec![0x41; 1234])),
        )
        .unwrap();
    // An upload/resume binding is NOT yet a pending write.
    assert!(a.r.list_pending(session, None).unwrap().pending.is_empty());
    let mut held = Vec::new();
    for _ in 0..100 {
        a.r.tick();
        for call in a.r.take_log_calls() {
            if matches!(call.request, LogRequest::Append(_)) {
                held.push(call);
            } else {
                let reply = a.log.call(call.request);
                a.r.on_log_reply(call.id, reply);
            }
        }
        if a.r.store().pending_get(&mutation).unwrap().is_some() {
            break;
        }
    }
    let row =
        a.r.store()
            .pending_get(&mutation)
            .unwrap()
            .expect("genuine runtime capture");
    let page = a.r.list_pending(session, None).unwrap();
    assert_eq!(page.pending.len(), 1);
    assert_eq!(page.pending[0].receipt.mutation, mutation);
    assert_eq!(page.pending[0].ops, row.mutation.ops);
    let mdbn_wire::attachment_runtime_v1::Op::FileAttach(op) = &page.pending[0].ops[0] else {
        panic!("original runtime operation")
    };
    assert_eq!(op.id, file);
    assert_eq!(op.path, "files/pending.bin");
    assert_eq!(row.grant, Some(B16([0x55; 16])));
    assert_eq!(a.r.store().pending_get(&mutation).unwrap(), Some(row));
    assert_eq!(
        a.r.list_pending(a.s, None).unwrap().pending[0]
            .receipt
            .mutation,
        mutation
    );
    assert_eq!(
        a.r.receipt(session, mutation).unwrap().state,
        mdbn_wire::client::ReceiptState::Pending,
        "no original ACK was driven"
    );
}

#[test]
fn pending_inventory_excludes_settled_rejection_even_if_capture_returned_pending() {
    use mdbn_wire::client::SubmitParams;
    use mdbn_wire::common::Text;
    use mdbn_wire::intent::{Create, Op};
    let service = FakeLogService::new();
    let mut a = node(&service, 1, MemStore::new());
    settle(&mut [&mut a]);
    let params = SubmitParams {
        ops: (1..=5)
            .map(|id| {
                Op::Create(Create {
                    id: B16([id; 16]),
                    path: Some(format!("large-{id}.md")),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline("x".repeat(900_000))),
                })
            })
            .collect(),
        mutation_id: Some(B16([203; 16])),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    };
    let receipt = a.r.submit(a.s, params).unwrap().remove(0);
    assert_eq!(receipt.state, mdbn_wire::client::ReceiptState::Pending);
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert!(a.r.list_pending(a.s, None).unwrap().pending.is_empty());
    let current = a.r.receipt(a.s, receipt.mutation).unwrap();
    assert_eq!(
        current.state,
        mdbn_wire::client::ReceiptState::Rejected,
        "{current:?}"
    );
    assert!(current.problem.is_some());
}

#[test]
fn pending_write_recovers_by_mutation_id_after_session_and_replica_reload() {
    use crate::api::SessionAuth;
    let service = FakeLogService::new();
    let mut a = node(&service, 1, MemStore::new());
    settle(&mut [&mut a]);
    let session = granted(&service, &mut a, "records.create", None);
    a.s = session;
    let own = a.create(200, "own.md", "own bytes").mutation;
    a.r.close(session);
    // A page reload: a fresh replica over the same store, then a new session
    // for the same grant, holding only the journaled mutation ID.
    let mut b = node(&service, 1, a.r.into_store());
    let hello = || mdbn_wire::client::HelloParams {
        versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
        client_name: "reload".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    };
    let auth = SessionAuth::Grant {
        grant: B16([0x55; 16]),
        client_pk: [0x57; 32],
    };
    let (fresh, _) = b.r.hello(auth.clone(), hello()).unwrap();
    let pending = b.r.list_pending(fresh, None).unwrap();
    assert_eq!(
        pending
            .pending
            .iter()
            .map(|p| p.receipt.mutation)
            .collect::<Vec<_>>(),
        vec![own]
    );
    assert_eq!(
        b.r.receipt(fresh, own).unwrap().state,
        mdbn_wire::client::ReceiptState::Pending
    );
    settle(&mut [&mut b]);
    let (later, _) = b.r.hello(auth, hello()).unwrap();
    assert_eq!(
        b.r.receipt(later, own).unwrap().state,
        mdbn_wire::client::ReceiptState::Confirmed
    );
    assert!(b.r.list_pending(later, None).unwrap().pending.is_empty());
}
