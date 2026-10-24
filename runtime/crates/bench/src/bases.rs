//! TaskNotes views through the replica's Bases executor: the five unchanged
//! TaskNotes `.base` views from `crates/replica/src/tests/data/bases-first-slice.json`
//! (All Tasks, Today, Overdue, This Week, Kanban) over a task-heavy corpus.
//!
//! `bases.<view>` = capture execution inputs + execute the view (filter,
//! formulas, sort, group, cells), on a keyed signed device over `MemStore`.
//! Rendering is the UI's cost and is measured in the browser (phase 2).

use std::collections::BTreeMap;

use mdbn_core::views::bases::{DateGroupMode, NullOrder, OrderingCapture, StringOrder};
use mdbn_replica::replica::{BasesExecutionPolicies, BasesViewSelection};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent::{Create, Op, ResourcePut};
use mdbn_wire::policy::CState;

use crate::corpus::Rng;
use crate::measure::Sample;
use crate::sync::{Node, id, seed, settle, world};

const FIXTURE: &str = include_str!("../../replica/src/tests/data/bases-first-slice.json");

fn source_id(i: u8) -> B16 {
    B16([0xba, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
}

/// A TaskNotes task note in the shape the first-slice executor accepts:
/// frontmatter scalars and a `tags` list, no link-valued properties, no body.
fn task_doc(i: u64, rng: &mut Rng) -> String {
    let status = ["open", "open", "in-progress", "done"][rng.below(4) as usize];
    let priority = ["none", "low", "normal", "high"][rng.below(4) as usize];
    let mut d = format!("---\ntitle: \"Task {i}\"\nstatus: {status}\npriority: {priority}\n");
    if rng.pct(60) {
        d.push_str(&format!(
            "due: 2026-{:02}-{:02}\n",
            rng.range(1, 3),
            rng.range(1, 28)
        ));
    }
    if rng.pct(40) {
        d.push_str(&format!(
            "scheduled: 2026-{:02}-{:02}\n",
            rng.range(1, 2),
            rng.range(1, 28)
        ));
    }
    d.push_str("tags:\n  - task\n---\n");
    d
}

fn create(id: B16, path: &str, doc: &str) -> Op {
    Op::Create(Create {
        id,
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(Text::Inline(doc.into())),
    })
}

/// Run the Bases view scenarios over `notes` task notes.
pub fn run(notes: u32, iters: usize, out: &mut Vec<Sample>) {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture");
    let config = "spec_version: \"0.3.0\"\nname: \"Perf corpus\"\nsettings:\n  timezone: \"UTC\"\n  record_extensions: [md, base]\n";
    let mut resources = vec![Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: Text::Inline(config.into()),
        base_revision: None,
        must_not_exist: None,
    })];
    for r in fixture["resources"].as_array().expect("resources") {
        resources.push(Op::ResourcePut(ResourcePut {
            path: r["path"].as_str().expect("path").into(),
            doc: Text::Inline(r["source"].as_str().expect("source").into()),
            base_revision: None,
            must_not_exist: None,
        }));
    }
    let mut rng = Rng::new(3);
    let mut creates: Vec<Op> = (0..u64::from(notes))
        .map(|i| {
            create(
                id(i + 1),
                &format!("TaskNotes/Tasks/Task {i}.md"),
                &task_doc(i, &mut rng),
            )
        })
        .collect();
    let sources = fixture["sources"].as_array().expect("sources");
    let mut by_command = BTreeMap::new();
    for (i, src) in sources.iter().enumerate() {
        let command = src["command"].as_str().expect("command").to_string();
        let text = src["source"].as_str().expect("source").to_string();
        creates.push(create(
            source_id(i as u8),
            &format!("TaskNotes/Views/{command}.base"),
            &text,
        ));
        by_command.insert(command, (source_id(i as u8), text));
    }
    let svc = world(1, CState::E2e);
    let mut a = Node::open(&svc, 1);
    settle(&svc, &mut [&mut a], 50);
    seed(&svc, &mut a, resources, creates, 200);

    let hints: BTreeMap<String, String> = fixture["property_types"]
        .as_object()
        .expect("property_types")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
        .collect();
    let policies = || BasesExecutionPolicies {
        ordering: OrderingCapture {
            nulls: NullOrder::Last,
            strings: StringOrder::Utf16,
        },
        date_groups: DateGroupMode::Unavailable,
        inventory_ties: true,
    };
    for view in fixture["views"].as_array().expect("views") {
        let name = view["name"].as_str().expect("name");
        let (record, text) = &by_command[view["command"].as_str().expect("command")];
        let selection = BasesViewSelection {
            record: *record,
            revision: mdbn_wire::hash::sha256(text.as_bytes()),
            index: view["index"].as_u64().expect("index") as u32,
        };
        let scenario = format!("bases.{}", name.to_lowercase().replace(' ', "_"));
        let mut s = Sample::new(
            &scenario,
            notes,
            &format!("TaskNotes '{name}' view: capture inputs + execute over {notes} tasks"),
        );
        let mut rows = 0;
        let mut failed = None;
        for _ in 0..iters {
            let r = s.time(|| {
                let inputs =
                    a.r.capture_bases_execution_inputs(selection, Some(&hints), Some("UTC"))?;
                a.r.execute_captured_bases_view(inputs, policies(), &|| false)
            });
            match r {
                Ok(res) => rows = res.rows.len(),
                Err(e) => {
                    failed = Some(format!("{e}"));
                    break;
                }
            }
        }
        match failed {
            Some(e) => {
                s.ms.clear();
                s.note = format!("failed: {e}");
            }
            None => s.note.push_str(&format!("; {rows} rows")),
        }
        out.push(s);
    }

    // Real-shaped content the first slice refuses: one note each, then the
    // first view again.
    let first = by_command
        .values()
        .next()
        .map(|(id, text)| (*id, text.clone()));
    let probes = [
        ("inline_tag", "A note with an inline #tag.\n"),
        ("heading_link", "See [[Task 1#Notes]].\n"),
        (
            "link_property",
            "---\nprojects:\n  - \"[[Task 1]]\"\ntags:\n  - task\n---\n",
        ),
    ];
    for (k, (name, doc)) in probes.iter().enumerate() {
        let probe_id = source_id(0xf0 + k as u8);
        a.submit(vec![create(
            probe_id,
            &format!("Notes/probe {name}.md"),
            doc,
        )]);
        settle(&svc, &mut [&mut a], 50);
        let mut s = Sample::new(
            &format!("bases.probe_{name}"),
            notes,
            "first view after adding one such note",
        );
        if let Some((record, text)) = &first {
            let selection = BasesViewSelection {
                record: *record,
                revision: mdbn_wire::hash::sha256(text.as_bytes()),
                index: 0,
            };
            let r = s.time(|| {
                let inputs =
                    a.r.capture_bases_execution_inputs(selection, Some(&hints), Some("UTC"))?;
                a.r.execute_captured_bases_view(inputs, policies(), &|| false)
            });
            s.note = match r {
                Ok(res) => format!("executed: {} rows", res.rows.len()),
                Err(e) => format!("refused: {e}"),
            };
        }
        out.push(s);
        a.submit(vec![mdbn_wire::intent::Op::Delete(
            mdbn_wire::intent::Delete {
                id: probe_id,
                base_revision: None,
                if_revision: None,
            },
        )]);
        settle(&svc, &mut [&mut a], 50);
    }
}
