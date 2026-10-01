//! Payload-free synthetic timings. Never opens an existing collection.
//! MDBASE_OPEN_TIMING_NOTES=1000,10000,50000 cargo test --release --locked
//! -p mdbase-connect-core --test collection_open_timings -- --ignored --nocapture
use mdbase_connect_core::CollectionRegistry;
use serde_json::{json, Value};
use std::time::Instant;

fn timed<T>(notes: usize, round: usize, phase: &str, work: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let result = work();
    println!(
        "{}",
        json!({"notes":notes,"round":round,"phase":phase,"ms":start.elapsed().as_secs_f64()*1000.0})
    );
    result
}

fn query(registry: &CollectionRegistry, id: uuid::Uuid, cursor: Option<&str>) -> Value {
    let mut input = json!({"order_by":[{"field":"file.mtime","direction":"desc"}],"include_body":false,"frontmatter_mode":"both"});
    if let Some(cursor) = cursor {
        input["cursor"] = json!(cursor);
    } else {
        input["pagination"] = json!("cursor");
        input["limit"] = json!(200);
    }
    let output = registry.operation(id, "query", &input).unwrap();
    assert_ne!(output["valid"], false, "{output}");
    output
}

#[test]
#[ignore = "synthetic collection opening observation; run optimized"]
fn collection_open_timings() {
    let sizes = std::env::var("MDBASE_OPEN_TIMING_NOTES")
        .unwrap_or_else(|_| "1000,10000,50000".to_string())
        .split(',')
        .map(|s| s.parse::<usize>().unwrap())
        .collect::<Vec<_>>();
    for notes in sizes {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("collection");
        let registry = CollectionRegistry::open(directory.path().join("state")).unwrap();
        let body = "Synthetic content. ".repeat(60);
        for i in 0..notes {
            let folder = root.join(format!("notes/{:04}", i / 100));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(format!("note-{i:08}.md")), format!("---\nid: synthetic-{i}\ntitle: Synthetic note {i}\ntags: [test]\n---\n{body}\n")).unwrap();
        }
        let collection = timed(notes, 0, "initialize_register", || {
            registry
                .create(&root, Some("[test] opening timings"), "UTC")
                .unwrap()
        });
        let id = collection.id;
        timed(notes, 0, "runtime_synchronize", || {
            registry
                .synchronize_runtime(id, &mdbase::OperationCancellation::new())
                .unwrap()
        });
        timed(notes, 0, "runtime_finalize", || {
            registry
                .finalize_runtime_changes(id, &mdbase::OperationCancellation::new())
                .unwrap()
        });
        for round in 0..4 {
            timed(notes, round, "describe", || registry.describe(id).unwrap());
            let first = timed(notes, round, "query_first_200", || {
                query(&registry, id, None)
            });
            let path = first
                .pointer("/result/results/0/file/path")
                .or_else(|| first.pointer("/result/results/0/path"))
                .and_then(Value::as_str)
                .unwrap();
            timed(notes, round, "read_note", || {
                let output = registry
                    .operation(id, "read", &json!({"path":path,"include_document":true}))
                    .unwrap();
                assert_ne!(output["valid"], false, "{output}");
            });
            timed(notes, round, "query_remaining_pages", || {
                let mut cursor = first
                    .pointer("/result/meta/cursor")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let mut last_cursor = cursor.clone();
                let mut loaded = first["result"]["results"].as_array().unwrap().len();
                while let Some(current) = cursor {
                    let page = query(&registry, id, Some(&current));
                    last_cursor = Some(current);
                    loaded += page["result"]["results"].as_array().unwrap().len();
                    cursor = page
                        .pointer("/result/meta/cursor")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                assert_eq!(loaded, notes);
                if let Some(cursor) = last_cursor {
                    registry
                        .operation(id, "query", &json!({"release_cursor":cursor}))
                        .unwrap();
                }
            });
            timed(notes, round, "file_inventory_refresh", || {
                registry.refresh_file_index_if_needed(id).unwrap()
            });
            timed(notes, round, "file_inventory_enumerate", || {
                registry.indexed_files(id).unwrap()
            });
        }
        timed(notes, 4, "parallel_describe_first_page_files", || {
            std::thread::scope(|scope| {
                let description = scope.spawn(|| {
                    timed(notes, 4, "parallel.describe", || {
                        registry.describe(id).unwrap()
                    })
                });
                let page = scope.spawn(|| {
                    timed(notes, 4, "parallel.query_first_200", || {
                        query(&registry, id, None)
                    })
                });
                let files = scope.spawn(|| {
                    timed(notes, 4, "parallel.files", || {
                        registry.refresh_file_index_if_needed(id).unwrap();
                        registry.indexed_files(id).unwrap()
                    })
                });
                description.join().unwrap();
                let first = page.join().unwrap();
                if let Some(cursor) = first.pointer("/result/meta/cursor").and_then(Value::as_str) {
                    registry
                        .operation(id, "query", &json!({"release_cursor":cursor}))
                        .unwrap();
                }
                files.join().unwrap();
            });
        });
        registry.shutdown_runtimes();
    }
}
