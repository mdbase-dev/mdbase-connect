//! # mdbase: typed Markdown collections
//!
//! A collection is a folder of Markdown files with YAML frontmatter, plus an
//! `mdbase.yaml` and optional type definitions. This crate opens such a folder
//! and gives you typed reads, CEL queries, validation and safe writes, all
//! through the same engine the mdbase daemon and the Obsidian plugin use.
//!
//! No account, daemon or sync is needed. Files stay plain Markdown; the engine
//! keeps its index under `<root>/.mdbase/library/` and never puts IDs or
//! metadata into your files.
//!
//! ```no_run
//! use mdbase::{Collection, Create, Order, Query, Update};
//!
//! # fn main() -> mdbase::Result<()> {
//! let col = Collection::open("./notes")?;              // or Collection::init(..)
//!
//! let task = col.create(
//!     Create::at("tasks/write-docs.md")
//!         .field("type", "task")
//!         .field("status", "open")
//!         .body("Write the docs.\n"),
//! )?;
//!
//! let open = col.query(
//!     Query::of_type("task")
//!         .filter("status == 'open'")
//!         .order_by("created", Order::Desc)
//!         .limit(50),
//! )?;
//! println!("{} open tasks", open.records.len());
//!
//! col.update(Update::at(&task).set("status", "done").if_revision(task.revision))?;
//! col.rename("tasks/write-docs.md", "tasks/done/write-docs.md")?;
//! col.delete("tasks/done/write-docs.md")?;
//! # Ok(()) }
//! ```
//!
//! ## Two writers
//!
//! One process hosts a folder at a time. If the mdbase daemon or Obsidian hosts
//! it, [`Collection::open`] fails with [`Error::AlreadyHosted`] and its
//! [`Error::help`] says what to do. Other programs may still edit the files
//! directly: [`Collection::rescan`] picks those edits up, and a file the
//! engine would otherwise overwrite is set aside as a [`Hold`] instead.
//!
//! ## Errors
//!
//! Every function returns [`Result`] with one [`Error`] enum. `Display` prints
//! the problem and what to do; [`Error::code`] is stable for matching.
//!
//! ## Pure helpers
//!
//! The engine's pure parts (contract digests, JSON Schema, catalog loading,
//! type packs) are the [`core`] module, re-exported from `mdbn-core`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod collection;
mod error;
mod ops;
mod query;
mod record;
mod value;

pub use collection::{CONFIG_FILE, Collection, InitOptions, OpenOptions};
pub use error::{Error, Result};
pub use ops::{Create, Delete, Op, Rename, Replace, Target, Update};
pub use query::{Order, Query};
pub use record::{
    Change, ChangeKind, Changes, Hold, Issue, Links, OutgoingLink, Page, Record, Resolution,
    Severity, Status,
};
pub use value::{RecordId, Revision};

/// The pure core: catalog, contracts and digests, JSON Schema, type packs.
pub use mdbn_core as core;

/// This crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
