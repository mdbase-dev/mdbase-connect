use super::*;

#[test]
fn saved_projects_contains_text_and_status_control_in_both_executors() {
    for (filter, expected) in [
        (
            "projects.contains(\"planning\")",
            vec!["a.md", "b.md", "c.md"],
        ),
        ("status == \"open\"", vec!["a.md", "c.md", "d.md", "e.md"]),
    ] {
        let (svc, mut node, _) = configured();
        let source = format!("filters: {filter}\nviews: [{{type: table, order: [file.name]}}]\n");
        node.create(11, "View.base", &source);
        for (id, path, projects, status) in [
            (1, "a.md", "[planning]", "open"),
            (2, "b.md", "[planning, later]", "done"),
            (3, "c.md", "[later, planning]", "open"),
            (4, "d.md", "['[[Other]]']", "open"),
            (5, "e.md", "[later]", "open"),
        ] {
            node.create(
                id,
                path,
                &format!("---\nprojects: {projects}\nstatus: {status}\n---\n"),
            );
        }
        settle(&mut [&mut node]);
        let (captured, indexed) = run_both(node, &svc, &source);
        assert_eq!(captured.unwrap(), expected);
        assert_eq!(indexed.unwrap(), expected);
    }
}

#[test]
fn populated_custom_today_source_preserves_status_archive_and_planned_date_precedence() {
    // Original synthetic app output at 8be4dd96d185eb0983bf21b33249204c2bf4152b,
    // corpus app/10-custom-fields-statuses-Today. This protects whole execution,
    // not just expression admission or the historical default-field fixture.
    let source = include_str!("../../../data/today-custom-fields.base");
    let (svc, mut a, _) = configured();
    a.create(11, "Views/custom-today.base", source);
    let cases = [
        ("unplanned", "workflow_state: open\n", true),
        (
            "due-today",
            "workflow_state: open\ndeadline: 2026-06-10\n",
            true,
        ),
        (
            "due-past",
            "workflow_state: open\ndeadline: 2026-06-09\n",
            true,
        ),
        (
            "due-future",
            "workflow_state: open\ndeadline: 2026-06-11\n",
            false,
        ),
        (
            "planned-today",
            "workflow_state: open\nplan_date: 2026-06-10\ndeadline: 2026-06-11\n",
            true,
        ),
        (
            "planned-past",
            "workflow_state: open\nplan_date: 2026-06-09\ndeadline: 2026-06-11\n",
            true,
        ),
        (
            "planned-future-overdue",
            "workflow_state: open\nplan_date: 2026-06-11\ndeadline: 2026-06-09\n",
            false,
        ),
        (
            "planned-future-undated",
            "workflow_state: open\nplan_date: 2026-06-11\n",
            false,
        ),
        (
            "configured-completed",
            "workflow_state: custom-state-3\ndeadline: 2026-06-09\n",
            false,
        ),
        (
            "other-done-label",
            "workflow_state: done\ndeadline: 2026-06-09\n",
            true,
        ),
        (
            "archived",
            "workflow_state: open\ndeadline: 2026-06-09\ntags: [archived]\n",
            false,
        ),
        (
            "archive-prefix",
            "workflow_state: open\ntags: [archived-later]\n",
            true,
        ),
        ("missing-status", "deadline: 2026-06-09\n", false),
        (
            "empty-status",
            "workflow_state: ''\ndeadline: 2026-06-09\n",
            false,
        ),
        (
            "null-status",
            "workflow_state: null\ndeadline: 2026-06-09\n",
            false,
        ),
        (
            "legacy-fields-only",
            "status: open\ndue: 2026-06-09\n",
            false,
        ),
    ];
    let mut expected = std::collections::BTreeSet::new();
    let mut documents = Vec::new();
    for (index, (name, fields, included)) in cases.into_iter().enumerate() {
        let id = u8::try_from(index + 40).unwrap();
        let path = format!("Tasks/{name}.md");
        let document = format!("---\n\"task title\": {name}\n{fields}---\n");
        a.create(id, &path, &document);
        documents.push((id, document));
        if included {
            expected.insert((B16([id; 16]), path));
        }
    }
    settle(&mut [&mut a]);
    for (id, document) in documents {
        assert_eq!(
            a.doc(id).as_deref(),
            Some(document.as_str()),
            "original confirmed fixture document"
        );
    }
    a.clock.set(1_781_075_828_070); // 2026-06-10, captured UTC today.
    let mut r = projected(&svc, a);
    let hints = BTreeMap::from_iter([
        ("plan_date".into(), "date".into()),
        ("deadline".into(), "date".into()),
    ]);
    let result = r
        .execute_indexed_bases_view(
            selection(source, 0),
            Some(&hints),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .unwrap();
    let actual: std::collections::BTreeSet<_> = result
        .rows
        .iter()
        .map(|row| (row.record, row.path.clone()))
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(
        result.rows.len(),
        expected.len(),
        "no duplicates or partial output"
    );
}
