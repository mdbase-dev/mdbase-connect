//! `cargo run -p mdbase --example quickstart -- ./notes`
//!
//! Creates a collection (if needed), writes a task, queries it, updates it.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbase::{Collection, Create, InitOptions, Order, Query, Update};

fn main() -> mdbase::Result<()> {
    let root = std::env::args().nth(1).unwrap_or_else(|| "./notes".into());
    let col = Collection::init(
        &root,
        InitOptions {
            name: Some("Quickstart".into()),
            timezone: None,
        },
    )?;
    println!("opened {}", col.root().display());

    let task = col.create(
        Create::at("tasks/write-docs.md")
            .field("type", "task")
            .field("title", "Write the docs")
            .field("status", "open")
            .body("Everything a newcomer needs.\n"),
    )?;
    println!("created {} ({})", task.path, task.id);

    let open = col.query(
        Query::all()
            .filter("status == 'open'")
            .order_by("title", Order::Asc),
    )?;
    for r in &open.records {
        println!(
            "open: {} {}",
            r.path,
            r.get("title").and_then(|v| v.as_str()).unwrap_or("")
        );
    }

    let done = col.update(
        Update::at(&task)
            .set("status", "done")
            .if_revision(task.revision),
    )?;
    println!(
        "now {}",
        done.get("status").and_then(|v| v.as_str()).unwrap_or("?")
    );
    Ok(())
}
