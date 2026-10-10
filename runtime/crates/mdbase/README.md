# mdbase

Typed Markdown collections for Rust. Open a folder of Markdown files with YAML
frontmatter and read, query (CEL), validate and write records through the same
engine the mdbase daemon and the Obsidian plugin use. Files stay plain Markdown;
no account, daemon or sync is needed.

```toml
[dependencies]
mdbase = "0.5.0-rc.1"
```

```rust
use mdbase::{Collection, Create, Order, Query, Update};

let col = Collection::open("./notes")?;              // or Collection::init("./notes", Default::default())

let task = col.create(
    Create::at("tasks/write-docs.md")
        .field("type", "task")
        .field("status", "open")
        .body("Write the docs.\n"),
)?;

let open = col.query(
    Query::of_type("task").filter("status == 'open'").order_by("created", Order::Desc).limit(50),
)?;

col.update(Update::at(&task).set("status", "done").if_revision(task.revision))?;
col.rename("tasks/write-docs.md", "tasks/done/write-docs.md")?;
col.delete("tasks/done/write-docs.md")?;
```

Run the example: `cargo run -p mdbase --example quickstart -- ./notes`.

## What you get

| | |
|---|---|
| `Collection::open` / `init` / `builder` | one host per folder, folder lock, state under `.mdbase/library/` |
| `get`, `document`, `query(Query)` | reads; `Query` builds spec 11 queries (types, CEL `where`, `order_by`, `limit`, `offset`), or wrap raw JSON |
| `create`, `update`, `replace`, `delete`, `rename` | one operation, one mutation, the written `Record` back |
| `apply(op)`, `batch(ops)` | the same as plain data (`Create`, `Update`, `Replace`, `Delete`, `Rename`); a batch is atomic |
| `if_revision` | optimistic concurrency on every write |
| `validate()`, `validate_one()` | spec diagnostics against the catalog |
| `catalog()`, `types()` | `mdbase.yaml`, type files and contracts, compiled |
| `links()` | outgoing links (resolved) and backlinks |
| `changes(cursor)` | the change feed |
| `rescan()`, `settle()` | pick up edits other programs made; wait for delete/move timers |
| `holds()`, `resolve_hold()` | files the engine refused to overwrite |
| `mdbase::core` | the pure engine: digests, JSON Schema, catalog loading, type packs |

Every function returns `mdbase::Result`. The `Error` enum has a stable
`code()` and a `help()` line, and `Display` prints both:

```text
conflict (revision): the record changed. The record changed since you read it. Read it again and retry with the new revision, or drop the `if_revision` guard.
```

## Two writers

One process hosts a folder at a time. If the mdbase daemon or Obsidian hosts
it, `open` fails with `Error::AlreadyHosted` and says what to do. Other programs
may still edit the files directly: `rescan()` ingests their changes, and a file
the engine would otherwise overwrite is set aside as a hold instead of being
clobbered.

## Compatibility

- Public API: semver from 0.5.0. The `mdbn-*` crates it is built from are
  implementation details and not covered.
- On-disk state (`.mdbase/library/`) is rebuilt from the files if deleted.
- Supported spec version: 0.3.0.
