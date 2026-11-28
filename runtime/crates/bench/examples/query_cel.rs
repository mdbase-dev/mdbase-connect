//! Time a compiled CEL query over 10,000 pre-parsed records.
//! Run with `cargo run --release -p mdbn-bench --example query_cel`.
#![allow(clippy::disallowed_types, clippy::disallowed_methods)]

use std::hint::black_box;
use std::time::Instant;

use mdbn_core::query::{self, Query, QueryEnv, QueryRecord, Verdict};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::value::{Map, Value};

fn main() {
    let query = Query {
        where_: Some("priority >= 2 && status == 'open'".into()),
        ..Query::default()
    };
    let plan = query::compile(&query, &MemState::new().catalog()).expect("valid query");
    let env = QueryEnv {
        now_ms: 0,
        today: "1970-01-01".into(),
        tz: "UTC".into(),
    };
    for width in [8, 32] {
        let records: Vec<_> = (0..10_000)
            .map(|n| {
                let mut fields = Map::new();
                fields.insert("priority", Value::Int(n % 4));
                fields.insert(
                    "status",
                    Value::string(if n % 3 == 0 { "done" } else { "open" }),
                );
                for k in 2..width {
                    fields.insert(format!("property_{k}"), Value::Int(n + k));
                }
                (format!("tasks/{n}.md"), fields)
            })
            .collect();
        for _ in 0..5 {
            let start = Instant::now();
            let count = records
                .iter()
                .filter(|(path, fields)| {
                    let record = QueryRecord {
                        path,
                        types: &[],
                        frontmatter: fields,
                        body: None,
                        mtime: None,
                    };
                    black_box(plan.evaluate(&record, &env, None)).verdict == Verdict::Match
                })
                .count();
            let elapsed = start.elapsed();
            assert_eq!(count, 3333);
            println!("10k CEL filter, {width} fields: {elapsed:?}");
        }
    }
}
