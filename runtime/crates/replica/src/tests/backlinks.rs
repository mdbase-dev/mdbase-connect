//! `backlinks` over the real Replica: Core resolution from the link index,
//! path-ordered pages and session-bound continuations.
use super::engine::{Node, node, settle};
use crate::api::{ApiResult, Backlinks, ClientApi, Target};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use mdbn_wire::client::{BacklinksResult, Include, LinkKind};
use mdbn_wire::common::B16;

fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

fn page(
    n: &mut Node,
    target: &str,
    limit: Option<u32>,
    cursor: Option<String>,
) -> ApiResult<BacklinksResult> {
    n.r.backlinks(
        n.s,
        Backlinks {
            target: Target::Path(target.into()),
            include: include(),
            limit,
            cursor,
        },
    )
}

fn paths(result: &BacklinksResult) -> Vec<&str> {
    result
        .backlinks
        .iter()
        .map(|b| b.record.path.as_str())
        .collect()
}

fn collection(svc: &FakeLogService) -> Node {
    let mut a = node(svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(
        10,
        "notes/Target.md",
        "# Target\n\nI link to [[Target]] myself.\n",
    );
    // Deeper, so plain `[[Target]]` prefers notes/Target.md (Core: shallowest).
    a.create(11, "archive/old/Target.md", "# A different target\n");
    a.create(20, "b/two.md", "See [[Target]] and ![[Target]].\n");
    a.create(21, "a/one.md", "A [markdown link](../notes/Target.md).\n");
    // Same stem as the target, so the index offers it; it resolves elsewhere.
    a.create(22, "c/three.md", "Only [[archive/old/Target]].\n");
    a.create(23, "d/four.md", "Mentions Target without linking.\n");
    a.create(24, "e/five.md", "[[notes/Target|aliased]]\n");
    settle(&mut [&mut a]);
    a
}

#[test]
fn backlinks_are_core_resolved_referrers_in_path_order() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let result = page(&mut a, "notes/Target.md", None, None).unwrap();
    assert_eq!(paths(&result), ["a/one.md", "b/two.md", "e/five.md"]);
    assert!(result.complete);
    assert!(result.cursor.is_none());
    let two = &result.backlinks[1];
    assert_eq!(two.record.id, B16([20; 16]));
    assert_eq!(
        two.links
            .iter()
            .map(|l| (l.raw.as_str(), l.embed))
            .collect::<Vec<_>>(),
        [("[[Target]]", false), ("![[Target]]", true)]
    );
    for link in result.backlinks.iter().flat_map(|b| &b.links) {
        assert_eq!(link.resolution.kind, LinkKind::Record);
        assert_eq!(link.resolution.target, Some(B16([10; 16])));
        assert_eq!(link.resolution.path.as_deref(), Some("notes/Target.md"));
        assert_eq!(link.field, None);
    }
    // The other same-stem record has its own, separate referrers.
    let other = page(&mut a, "archive/old/Target.md", None, None).unwrap();
    assert_eq!(paths(&other), ["c/three.md"]);
}

#[test]
fn backlinks_include_pending_local_changes() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    a.create(25, "f/pending.md", "Draft about [[Target]].\n");
    let result = page(&mut a, "notes/Target.md", None, None).unwrap();
    assert_eq!(
        paths(&result),
        ["a/one.md", "b/two.md", "e/five.md", "f/pending.md"]
    );
    assert_eq!(
        result.backlinks[3].record.state.state,
        mdbn_wire::client::Confirmation::Pending
    );
}

#[test]
fn backlinks_page_through_one_view_and_refuse_a_changed_one() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let result = page(&mut a, "notes/Target.md", Some(1), cursor.take()).unwrap();
        assert_eq!(result.backlinks.len(), 1);
        seen.extend(paths(&result).into_iter().map(str::to_owned));
        match result.cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(seen, ["a/one.md", "b/two.md", "e/five.md"]);

    let first = page(&mut a, "notes/Target.md", Some(1), None).unwrap();
    let next = first.cursor.unwrap();
    // A cursor belongs to its exact selection.
    let other = page(&mut a, "notes/Target.md", Some(2), Some(next.clone())).unwrap_err();
    assert_eq!(
        other.problem().reason.as_deref(),
        Some("invalid_backlinks_cursor")
    );
    let malformed = page(&mut a, "notes/Target.md", Some(1), Some("r1.00".into())).unwrap_err();
    assert_eq!(
        malformed.problem().reason.as_deref(),
        Some("invalid_backlinks_cursor")
    );
    // Any local change ends the old view; the caller restarts.
    a.create(26, "z/new.md", "Unrelated.\n");
    let stale = page(&mut a, "notes/Target.md", Some(1), Some(next)).unwrap_err();
    assert_eq!(stale.problem().reason.as_deref(), Some("cursor_stale"));
}

#[test]
fn backlinks_of_a_missing_record_are_not_found() {
    let svc = FakeLogService::new();
    let mut a = collection(&svc);
    let error = page(&mut a, "notes/Missing.md", None, None).unwrap_err();
    assert_eq!(error.problem().code, "not_found");
}
