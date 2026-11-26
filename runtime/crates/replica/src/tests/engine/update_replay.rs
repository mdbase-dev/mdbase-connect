use super::*;
use crate::Store;
use mdbn_wire::intent::{ConflictMode, Update};

fn queue(node: &mut Node, op: Op) -> B16 {
    let receipts = node
        .r
        .submit(
            node.s,
            SubmitParams {
                ops: vec![op],
                conflict_mode: Some(ConflictMode::Reject),
                mutation_id: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
    assert_eq!(receipts[0].state, ReceiptState::Pending, "{receipts:?}");
    receipts[0].mutation
}

#[test]
fn pending_update_replays_with_its_captured_deletion_policy() {
    let mut outcomes = Vec::new();
    for (require_live, delete) in [(true, true), (false, true), (true, false)] {
        let log = FakeLogService::new();
        let mut writer = node(&log, 1, MemStore::new());
        let mut peer = node(&log, 2, MemStore::new());
        writer.r.planner = Box::new(crate::plan::CorePlanner);
        peer.r.planner = Box::new(crate::plan::CorePlanner);
        settle(&mut [&mut writer, &mut peer]);
        writer.create(1, "entry.md", "original\n");
        settle(&mut [&mut writer, &mut peer]);
        writer.log.faults.offline = true;
        let id = B16([1; 16]);
        let revision = writer.r.store().record(&id).unwrap().unwrap().revision;
        let update = Update {
            id,
            if_revision: Some(revision),
            body: Some(Text::Inline("edited\n".into())),
            body_base: Some(revision),
            patch: None,
            unset: None,
            add: None,
            remove: None,
            body_edits: None,
            body_base_text: None,
            base: None,
            update_refs: None,
        };
        let mutation = queue(
            &mut writer,
            if require_live {
                Op::UpdateLive(update)
            } else {
                Op::Update(update)
            },
        );
        if delete {
            queue(
                &mut peer,
                Op::Delete(Delete {
                    id,
                    base_revision: Some(revision),
                    if_revision: None,
                }),
            );
            settle(&mut [&mut peer]);
            assert_eq!(peer.doc(1), None);
        }
        let mut reopened = node(&log, 1, writer.r.into_store());
        reopened.r.planner = Box::new(crate::plan::CorePlanner);
        settle(&mut [&mut reopened, &mut peer]);
        assert_eq!(reopened.doc(1), peer.doc(1));
        let receipt = reopened.r.receipt(reopened.s, mutation).unwrap();
        outcomes.push(serde_json::json!({
            "requireLive": require_live, "delete": delete, "doc": peer.doc(1),
            "state": format!("{:?}", receipt.state), "status": receipt.status.map(|s| format!("{s:?}")),
            "problem": receipt.problem.map(|p| (p.code, p.reason)),
        }));
    }
    let expected: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../conformance/determinism/update-replay.expected.json"
    ))
    .unwrap();
    assert_eq!(outcomes, expected);
}
