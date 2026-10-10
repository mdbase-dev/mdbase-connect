//! Smoke test: the README quickstart, from a project that depends only on `mdbase`.

use mdbase::{Collection, Create, InitOptions, Order, Query, Update};

fn main() -> mdbase::Result<()> {
    let root = std::env::temp_dir().join(format!("mdbase-clean-install-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let col = Collection::init(&root, InitOptions::default())?;
    let task = col.create(
        Create::at("tasks/write-docs.md")
            .field("status", "open")
            .body("Write the docs.\n"),
    )?;
    let open = col.query(Query::all().filter("status == 'open'").order_by("status", Order::Asc))?;
    assert_eq!(open.records.len(), 1);
    let done = col.update(Update::at(&task).set("status", "done").if_revision(task.revision))?;
    assert_eq!(done.get("status"), Some(&serde_json::json!("done")));
    col.rename("tasks/write-docs.md", "done/write-docs.md")?;
    col.delete("done/write-docs.md")?;
    assert!(col.get("done/write-docs.md")?.is_none());
    drop(col);
    let _ = std::fs::remove_dir_all(&root);
    println!("mdbase clean install: ok");
    Ok(())
}
