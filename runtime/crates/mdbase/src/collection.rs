//! The collection handle.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use mdbn_core::types::Catalog;
use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, LockError, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, SystemZones, open_store,
};
use mdbn_replica::Store;
use mdbn_replica::api::{ClientApi, HoldResolution, Target as ApiTarget};
use mdbn_store_file::SqlStoreLimits;
use mdbn_wire::client::{Include, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent as wire;

use crate::error::{Error, Result, from_problem};
use crate::ops::{Create, Delete, Op, Rename, Replace, Target, Update};
use crate::query::Query;
use crate::record::{
    Change, ChangeKind, Changes, Hold, Issue, Links, OutgoingLink, Page, Record, Resolution, Status,
};
use crate::value::{RecordId, Revision, pairs_to_wire, to_wire};

/// The config file every collection has at its root.
pub const CONFIG_FILE: &str = "mdbase.yaml";

/// How to open a collection. Start with [`Collection::builder`].
#[derive(Debug, Clone)]
pub struct OpenOptions {
    root: PathBuf,
    state_dir: Option<PathBuf>,
    desktop: bool,
    timezone: Option<String>,
    take_over: bool,
    client: (String, String),
}

impl OpenOptions {
    fn new(root: &Path) -> OpenOptions {
        OpenOptions {
            root: root.to_owned(),
            state_dir: None,
            desktop: true,
            timezone: None,
            take_over: false,
            client: ("mdbase".into(), env!("CARGO_PKG_VERSION").into()),
        }
    }

    /// Where to keep this host's index and identity. Default:
    /// `<root>/.mdbase/library`.
    pub fn state_dir(mut self, dir: impl Into<PathBuf>) -> OpenOptions {
        self.state_dir = Some(dir.into());
        self
    }

    /// Use the constrained (mobile) resource profile instead of desktop limits.
    pub fn constrained(mut self) -> OpenOptions {
        self.desktop = false;
        self
    }

    /// The IANA zone for `today()` and lifecycle dates. Default: the
    /// collection's `settings.timezone`, else the machine's zone.
    pub fn timezone(mut self, tz: impl Into<String>) -> OpenOptions {
        self.timezone = Some(tz.into());
        self
    }

    /// Open even if another host's descriptor is present (for instance Obsidian
    /// announced itself and never cleaned up). Never overrides a held OS lock.
    pub fn take_over(mut self, yes: bool) -> OpenOptions {
        self.take_over = yes;
        self
    }

    /// Name and version of your application (diagnostics).
    pub fn client(mut self, name: impl Into<String>, version: impl Into<String>) -> OpenOptions {
        self.client = (name.into(), version.into());
        self
    }

    /// Open the collection.
    pub fn open(self) -> Result<Collection> {
        Collection::open_with(self)
    }
}

/// What [`Collection::init`] writes.
#[derive(Debug, Clone, Default)]
pub struct InitOptions {
    /// `name` in `mdbase.yaml`.
    pub name: Option<String>,
    /// `settings.timezone`.
    pub timezone: Option<String>,
}

struct Inner {
    rep: LocalReplica,
    _lock: HostLock,
}

/// An open collection: a folder of Markdown files with YAML frontmatter.
///
/// One `Collection` is one host of the folder: it holds the folder lock until
/// dropped or [`Collection::close`]d. It is single-threaded (`!Send`); share it
/// through your own channel or open it on the thread that uses it.
pub struct Collection {
    root: PathBuf,
    inner: RefCell<Inner>,
}

impl std::fmt::Debug for Collection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Collection")
            .field("root", &self.root)
            .finish()
    }
}

fn include(body: bool, document: bool, diagnostics: bool) -> Include {
    Include {
        effective: None,
        body: Some(body),
        document: Some(document),
        diagnostics: Some(diagnostics),
    }
}

impl Collection {
    /// Open the collection at `root`. Fails with [`Error::NotACollection`] if
    /// there is no `mdbase.yaml`, and with [`Error::AlreadyHosted`] if the daemon,
    /// Obsidian or another process hosts the folder.
    pub fn open(root: impl AsRef<Path>) -> Result<Collection> {
        OpenOptions::new(root.as_ref()).open()
    }

    /// Open with options.
    pub fn builder(root: impl AsRef<Path>) -> OpenOptions {
        OpenOptions::new(root.as_ref())
    }

    /// Create a collection at `root` (the folder and `mdbase.yaml` if missing)
    /// and open it. Existing files are left alone.
    pub fn init(root: impl AsRef<Path>, options: InitOptions) -> Result<Collection> {
        let root = root.as_ref();
        std::fs::create_dir_all(root)?;
        let config = root.join(CONFIG_FILE);
        if !config.exists() {
            let mut text = String::from("spec_version: \"0.3.0\"\n");
            if let Some(name) = &options.name {
                text.push_str(&format!("name: {}\n", yaml_quote(name)));
            }
            if let Some(tz) = &options.timezone {
                text.push_str(&format!("settings:\n  timezone: {}\n", yaml_quote(tz)));
            }
            std::fs::write(&config, text)?;
        }
        Collection::open(root)
    }

    fn open_with(o: OpenOptions) -> Result<Collection> {
        let root = std::path::absolute(&o.root)?;
        if !root.join(CONFIG_FILE).is_file() {
            return Err(Error::NotACollection { root });
        }
        let store_opts = StoreOptions {
            state_dir: o.state_dir.clone(),
            limits: if o.desktop {
                SqlStoreLimits::DESKTOP
            } else {
                SqlStoreLimits::MOBILE
            },
            ..StoreOptions::default()
        };
        // Someone who cannot take the OS lock (Obsidian) announces itself in
        // the descriptor. Present means hosted, fresh or not (a paused mobile
        // host still owns the folder), and a descriptor that exists but cannot
        // be read counts as present; only an explicit take-over proceeds.
        if !o.take_over {
            match mdbn_local_host::host_lock::descriptor_state(&root, &store_opts.private_dir) {
                mdbn_local_host::DescriptorState::Present(d) if d.host != HostKind::Library => {
                    return Err(Error::AlreadyHosted {
                        root,
                        stale: d.is_stale(mdbn_local_host::host::now_ms(), 60_000),
                        host: Some(d.host),
                    });
                }
                mdbn_local_host::DescriptorState::Unreadable(_) => {
                    return Err(Error::AlreadyHosted {
                        root,
                        stale: false,
                        host: None,
                    });
                }
                _ => {}
            }
        }
        let now = mdbn_local_host::host::now_ms();
        let lock = match HostLock::try_acquire(
            &root,
            &store_opts.private_dir,
            Some(Descriptor::new(HostKind::Library, now)),
        ) {
            Ok(l) => l,
            Err(LockError::Held(d)) => {
                return Err(Error::AlreadyHosted {
                    root,
                    stale: d.as_ref().is_some_and(|d| d.is_stale(now, 60_000)),
                    host: d.map(|d| d.host),
                });
            }
            Err(LockError::Unsafe(p)) => {
                return Err(Error::InvalidPath {
                    path: p.display().to_string(),
                    reason: "symlink or escapes the collection".into(),
                });
            }
            Err(LockError::Io(e)) => return Err(Error::Io(e)),
        };
        let state_dir = store_opts.state_dir(&root);
        std::fs::create_dir_all(&state_dir)?;
        let identity =
            Identity::load_or_create(&state_dir.join("identity.json"), now, &mut OsEntropy)?;
        let store = open_store(&root, &store_opts, Box::new(SystemClock))?;
        let zone = o.timezone.clone().or_else(|| {
            let cat = Catalog::load(
                store
                    .resources()
                    .ok()?
                    .iter()
                    .map(|(p, s)| (p.as_str(), s.as_str())),
            );
            cat.settings().timezone.clone()
        });
        let rep = LocalReplica::open(
            store,
            &identity,
            ReplicaOptions {
                client: o.client.clone(),
                zones: Some(Box::new(match zone {
                    Some(z) => SystemZones::new(z),
                    None => SystemZones::default(),
                })),
                ..ReplicaOptions::default()
            },
        )?;
        let col = Collection {
            root,
            inner: RefCell::new(Inner { rep, _lock: lock }),
        };
        col.rescan()?;
        Ok(col)
    }

    /// The collection root (absolute).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Flush and release the folder. Dropping does the same.
    pub fn close(self) {
        drop(self);
    }

    fn with<T>(&self, f: impl FnOnce(&mut LocalReplica) -> T) -> T {
        let mut inner = self.inner.borrow_mut();
        f(&mut inner.rep)
    }

    // ---- reads --------------------------------------------------------------

    /// The catalog: `mdbase.yaml`, types and contracts as compiled now.
    pub fn catalog(&self) -> Catalog {
        self.with(|rep| {
            let res = rep.replica_ref().store().resources().unwrap_or_default();
            Catalog::load(res.iter().map(|(p, s)| (p.as_str(), s.as_str())))
        })
    }

    /// The names of the collection's types.
    pub fn types(&self) -> Vec<String> {
        self.catalog()
            .types()
            .iter()
            .map(|t| t.name.clone())
            .collect()
    }

    /// One record, with its body, or `None`.
    pub fn get(&self, target: impl Into<Target>) -> Result<Option<Record>> {
        let target = target.into();
        self.with(|rep| {
            let session = rep.session();
            match rep
                .replica()
                .get(session, api_target(&target), include(true, false, true))
            {
                Ok(v) => Ok(Some(Record::from_view(&v))),
                Err(e) if e.problem().code == "not_found" => Ok(None),
                Err(e) => Err(from_problem(e.problem(), Some(&target.to_string()))),
            }
        })
    }

    /// One record's whole file text, or `None`.
    pub fn document(&self, target: impl Into<Target>) -> Result<Option<String>> {
        let target = target.into();
        self.with(|rep| {
            let session = rep.session();
            match rep
                .replica()
                .get(session, api_target(&target), include(false, true, false))
            {
                Ok(v) => Ok(v.document),
                Err(e) if e.problem().code == "not_found" => Ok(None),
                Err(e) => Err(from_problem(e.problem(), Some(&target.to_string()))),
            }
        })
    }

    /// Run a query.
    pub fn query(&self, query: impl Into<Query>) -> Result<Page> {
        let query = query.into();
        let body = query.wants_body();
        self.with(|rep| {
            let session = rep.session();
            let r = rep.replica().query(
                session,
                to_wire(&query.to_json()),
                include(body, false, false),
            )?;
            Ok(Page {
                records: r.records.iter().map(Record::from_view).collect(),
                complete: r.complete,
                issues: r
                    .diagnostics
                    .iter()
                    .flatten()
                    .map(Issue::from_wire)
                    .collect(),
            })
        })
    }

    /// Validate every record against the catalog, and report type or contract
    /// files on disk that the engine refused to load (they are not part of the
    /// catalog until fixed). Sorted by path; only paths with issues.
    pub fn validate(&self) -> Result<Vec<(String, Vec<Issue>)>> {
        let catalog = self.catalog();
        let mut out = self.rejected_resources(&catalog)?;
        let docs = self.with(|rep| {
            let session = rep.session();
            let q = to_wire(&serde_json::json!({}));
            rep.replica()
                .query(session, q, include(false, true, false))
                .map(|r| {
                    r.records
                        .into_iter()
                        .filter_map(|v| v.document.map(|d| (v.path, d)))
                        .collect::<Vec<_>>()
                })
        })?;
        out.extend(
            docs.iter()
                .map(|(path, doc)| (path.clone(), validate_doc(&catalog, path, doc)))
                .filter(|(_, issues)| !issues.is_empty()),
        );
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Type and contract files on disk whose bytes the engine does not hold as
    /// resources: it refused them. Their load issues say why.
    fn rejected_resources(&self, catalog: &Catalog) -> Result<Vec<(String, Vec<Issue>)>> {
        let held: std::collections::BTreeMap<String, String> = self
            .with(|rep| rep.replica_ref().store().resources())?
            .into_iter()
            .collect();
        let config = held.get(CONFIG_FILE).cloned().unwrap_or_default();
        let mut out = Vec::new();
        for folder in [
            catalog.settings().types_folder.as_str(),
            catalog.settings().contracts_folder.as_str(),
        ] {
            let dir = self.root.join(folder);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .collect();
            names.sort();
            for name in names {
                let path = format!("{folder}/{name}");
                let Ok(text) = std::fs::read_to_string(dir.join(&name)) else {
                    continue;
                };
                if held.get(&path).is_some_and(|h| *h == text) {
                    continue;
                }
                let probe = Catalog::load([
                    (CONFIG_FILE, config.as_str()),
                    (path.as_str(), text.as_str()),
                ]);
                let mut issues: Vec<Issue> = probe.issues().iter().map(Issue::from_core).collect();
                if issues.is_empty() {
                    issues.push(Issue {
                        code: "resource_rejected".into(),
                        severity: crate::record::Severity::Error,
                        message:
                            "the engine has not accepted this file; run `rescan()` or check holds"
                                .into(),
                        location: Some(path.clone()),
                        type_name: None,
                        details: None,
                    });
                }
                out.push((path, issues));
            }
        }
        Ok(out)
    }

    /// Validate one record.
    pub fn validate_one(&self, target: impl Into<Target>) -> Result<Vec<Issue>> {
        let target = target.into();
        let rec = self.with(|rep| {
            let session = rep.session();
            rep.replica()
                .get(session, api_target(&target), include(false, true, false))
                .map_err(|e| from_problem(e.problem(), Some(&target.to_string())))
        })?;
        let doc = rec.document.unwrap_or_default();
        Ok(validate_doc(&self.catalog(), &rec.path, &doc))
    }

    /// Links out of and into one record.
    pub fn links(&self, target: impl Into<Target>) -> Result<Links> {
        let target = target.into();
        let catalog = self.catalog();
        let rec = self.with(|rep| {
            let session = rep.session();
            rep.replica()
                .get(session, api_target(&target), include(false, true, false))
                .map_err(|e| from_problem(e.problem(), Some(&target.to_string())))
        })?;
        let doc = rec.document.clone().unwrap_or_default();
        let catalog = std::sync::Arc::new(catalog);
        let (outgoing, backlinks) = self.with(|rep| {
            let store = rep.replica_ref().store();
            let view = mdbn_replica::plan::StoreView::new(store, catalog.clone());
            let outgoing = mdbn_core::links::record_links(&catalog, &rec.path, &doc)
                .iter()
                .map(|link| OutgoingLink {
                    target: link.target.clone(),
                    resolved: match mdbn_core::links::resolve(link, &rec.path, &view) {
                        mdbn_core::links::Resolution::Record(id) => Some(RecordId(id.0)),
                        _ => None,
                    },
                })
                .collect::<Vec<_>>();
            // The store indexes each record's outgoing link keys under
            // `LINK_PREFIX`; records linking here are those whose keys include
            // one of this record's target keys.
            let keys: Vec<String> = mdbn_core::links::target_keys(&catalog, &rec.path, Some(&doc))
                .into_iter()
                .map(|k| format!("{}{}", mdbn_replica::plan::LINK_PREFIX, k.0))
                .collect();
            store.referrers(&keys).map(|b| (outgoing, b))
        })?;
        Ok(Links {
            outgoing,
            backlinks: backlinks
                .into_iter()
                .map(RecordId::from_wire)
                .filter(|id| *id != RecordId::from_wire(rec.id))
                .collect(),
        })
    }

    /// Changes since `cursor`. `None` returns no changes and the current
    /// cursor: keep it, write, and pass it back to see what changed.
    pub fn changes(&self, cursor: Option<&str>) -> Result<Changes> {
        self.with(|rep| {
            let session = rep.session();
            let r = rep
                .replica()
                .changes(session, cursor.map(str::to_owned), None, false)?;
            Ok(Changes {
                changes: r
                    .changes
                    .iter()
                    .map(|c| Change {
                        id: RecordId::from_wire(c.id),
                        path: c.path.clone(),
                        kind: match c.kind {
                            mdbn_wire::client::ChangeKind::Put => ChangeKind::Put,
                            mdbn_wire::client::ChangeKind::Remove => ChangeKind::Remove,
                        },
                    })
                    .collect(),
                cursor: r.cursor,
                reset: r.reset,
            })
        })
    }

    /// Files the engine set aside instead of overwriting.
    pub fn holds(&self) -> Result<Vec<Hold>> {
        self.with(|rep| {
            let session = rep.session();
            Ok(rep
                .replica()
                .list_holds(session)?
                .into_iter()
                .map(|h| Hold {
                    id: RecordId::from_wire(h.id),
                    path: h.path,
                    reason: format!("{:?}", h.reason).to_lowercase(),
                    since: h.since,
                })
                .collect())
        })
    }

    /// Resolve a hold.
    pub fn resolve_hold(&self, id: RecordId, how: Resolution) -> Result<()> {
        let how = match how {
            Resolution::KeepMine => HoldResolution::KeepMine,
            Resolution::TakeTheirs => HoldResolution::TakeTheirs,
            Resolution::Use(s) => HoldResolution::Use(s),
            Resolution::Delete => HoldResolution::Delete,
            Resolution::KeepBoth => HoldResolution::KeepBoth,
        };
        self.with(|rep| {
            let session = rep.session();
            rep.replica().resolve_hold(session, id.to_wire(), how)?;
            rep.tick();
            Ok(())
        })
    }

    /// Pending writes, holds and conflicts.
    pub fn status(&self) -> Result<Status> {
        self.with(|rep| {
            let session = rep.session();
            let s = rep.replica().status(session)?;
            Ok(Status {
                pending: s.pending,
                holds: s.holds,
                unresolved: s.unresolved,
            })
        })
    }

    // ---- folder -------------------------------------------------------------

    /// Walk the folder and ingest outside edits (files changed by other
    /// programs). Deletions and moves need their timers: call
    /// [`Collection::settle`] to wait for them.
    pub fn rescan(&self) -> Result<()> {
        self.with(|rep| rep.rescan())?;
        Ok(())
    }

    /// Run the engine's timers (quiet periods, missing-file rechecks, move
    /// pairing) until nothing is due, waiting up to `max_wait_ms`. Returns
    /// whether everything settled.
    pub fn settle(&self, max_wait_ms: u64) -> Result<bool> {
        Ok(self.with(|rep| rep.settle(max_wait_ms))?)
    }

    // ---- writes -------------------------------------------------------------

    /// Create a record and return it.
    pub fn create(&self, op: Create) -> Result<Record> {
        self.apply(op)
            .map(|r| r.into_iter().next().expect("a create returns its record"))
    }

    /// Update a record and return it.
    pub fn update(&self, op: Update) -> Result<Record> {
        self.apply(op)
            .map(|r| r.into_iter().next().expect("an update returns its record"))
    }

    /// Replace a record's document and return it.
    pub fn replace(&self, op: Replace) -> Result<Record> {
        self.apply(op)
            .map(|r| r.into_iter().next().expect("a replace returns its record"))
    }

    /// Delete a record.
    pub fn delete(&self, target: impl Into<Target>) -> Result<()> {
        self.apply(Delete::at(target)).map(|_| ())
    }

    /// Rename a record and return it.
    pub fn rename(&self, from: impl Into<Target>, to: impl Into<String>) -> Result<Record> {
        self.apply(Rename::new(from, to))
            .map(|r| r.into_iter().next().expect("a rename returns its record"))
    }

    /// Apply one operation as one mutation. Returns the written records
    /// (none for a delete).
    pub fn apply(&self, op: impl Into<Op>) -> Result<Vec<Record>> {
        self.batch([op.into()])
    }

    /// Apply several operations as one atomic mutation: all or nothing. Returns
    /// the written records in operation order (deletes contribute none).
    pub fn batch(&self, ops: impl IntoIterator<Item = Op>) -> Result<Vec<Record>> {
        let ops: Vec<Op> = ops.into_iter().collect();
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        let mut wire_ops = Vec::with_capacity(ops.len());
        let mut written: Vec<RecordId> = Vec::new();
        let now = mdbn_local_host::host::now_ms();
        for op in &ops {
            match op {
                Op::Create(c) => {
                    let id = B16(mdbn_local_host::host::uuid_v7(now, &mut OsEntropy));
                    written.push(RecordId::from_wire(id));
                    wire_ops.push(wire::Op::Create(wire::Create {
                        id,
                        path: c.path.clone(),
                        type_name: c.type_name.clone(),
                        frontmatter: (!c.frontmatter.is_empty() || c.document.is_none())
                            .then(|| pairs_to_wire(&c.frontmatter)),
                        body: c.body.clone().map(Text::Inline),
                        document: c.document.clone().map(Text::Inline),
                    }));
                }
                Op::Update(u) => {
                    let id = self.resolve(&u.target)?;
                    written.push(RecordId::from_wire(id));
                    wire_ops.push(wire::Op::Update(wire::Update {
                        id,
                        patch: (!u.set.is_empty()).then(|| pairs_to_wire(&u.set)),
                        unset: (!u.unset.is_empty()).then(|| u.unset.clone()),
                        add: list_map(&u.add),
                        remove: list_map(&u.remove),
                        body: u.body.clone().map(Text::Inline),
                        body_edits: None,
                        body_base: None,
                        body_base_text: None,
                        base: None,
                        if_revision: u.if_revision.map(Revision::to_wire),
                    }));
                }
                Op::Replace(r) => {
                    let id = self.resolve(&r.target)?;
                    let path = match &r.target {
                        Target::Path(p) => p.clone(),
                        Target::Id(_) => self
                            .get(r.target.clone())?
                            .map(|rec| rec.path)
                            .unwrap_or_default(),
                    };
                    written.push(RecordId::from_wire(id));
                    wire_ops.push(wire::Op::Document(wire::Document {
                        id,
                        base: None,
                        new: Some(wire::DocVersion {
                            path,
                            doc: Text::Inline(r.document.clone()),
                        }),
                        if_revision: r.if_revision.map(Revision::to_wire),
                    }));
                }
                Op::Delete(d) => {
                    let id = self.resolve(&d.target)?;
                    wire_ops.push(wire::Op::Delete(wire::Delete {
                        id,
                        base_revision: None,
                        if_revision: d.if_revision.map(Revision::to_wire),
                    }));
                }
                Op::Rename(r) => {
                    let (id, from) = match &r.target {
                        Target::Path(p) => (self.resolve(&r.target)?, p.clone()),
                        Target::Id(_) => {
                            let rec =
                                self.get(r.target.clone())?.ok_or_else(|| Error::NotFound {
                                    target: r.target.to_string(),
                                })?;
                            (rec.id.to_wire(), rec.path)
                        }
                    };
                    written.push(RecordId::from_wire(id));
                    wire_ops.push(wire::Op::Rename(wire::Rename {
                        id,
                        from,
                        to: r.to.clone(),
                        update_refs: r.update_refs,
                        if_revision: r.if_revision.map(Revision::to_wire),
                    }));
                }
            }
        }
        self.with(|rep| {
            let session = rep.session();
            let receipts = rep.replica().submit(
                session,
                SubmitParams {
                    ops: wire_ops,
                    mutation_id: None,
                    conflict_mode: Some(wire::ConflictMode::Reject),
                    timezone: None,
                    allow_partial: None,
                    mutation_ids: None,
                    dry_run: None,
                    include: None,
                    wait: None,
                },
            )?;
            rep.tick();
            let mutation = receipts
                .first()
                .map(|r| r.mutation)
                .ok_or_else(|| Error::Engine {
                    code: "internal".into(),
                    message: "submit returned no receipt".into(),
                })?;
            let receipt = rep.replica().receipt(session, mutation)?;
            match receipt.state {
                ReceiptState::Confirmed => {}
                ReceiptState::Rejected => {
                    let p = receipt.problem.ok_or_else(|| Error::Engine {
                        code: "internal".into(),
                        message: "rejected without a problem".into(),
                    })?;
                    return Err(from_problem(&p, None));
                }
                other => {
                    return Err(Error::Engine {
                        code: "internal".into(),
                        message: format!("local write ended in state {other:?}"),
                    });
                }
            }
            let mut out = Vec::with_capacity(written.len());
            for id in written {
                let v = rep.replica().get(
                    session,
                    ApiTarget::Id(id.to_wire()),
                    include(true, false, true),
                )?;
                out.push(Record::from_view(&v));
            }
            Ok(out)
        })
    }

    fn resolve(&self, target: &Target) -> Result<B16> {
        match target {
            Target::Id(id) => Ok(id.to_wire()),
            Target::Path(p) => self.with(|rep| {
                let session = rep.session();
                rep.replica()
                    .get(
                        session,
                        ApiTarget::Path(p.clone()),
                        include(false, false, false),
                    )
                    .map(|v| v.id)
                    .map_err(|e| from_problem(e.problem(), Some(p)))
            }),
        }
    }
}

fn api_target(t: &Target) -> ApiTarget {
    match t {
        Target::Path(p) => ApiTarget::Path(p.clone()),
        Target::Id(id) => ApiTarget::Id(id.to_wire()),
    }
}

fn list_map(
    v: &[(String, Vec<serde_json::Value>)],
) -> Option<mdbn_wire::common::DataMap<Vec<mdbn_wire::common::Value>>> {
    (!v.is_empty()).then(|| {
        mdbn_wire::common::DataMap(
            v.iter()
                .map(|(k, vals)| (k.clone(), vals.iter().map(to_wire).collect()))
                .collect(),
        )
    })
}

fn validate_doc(catalog: &Catalog, path: &str, doc: &str) -> Vec<Issue> {
    mdbn_core::validate::apply_level(
        mdbn_core::validate::validate_record(catalog, path, doc),
        catalog.settings().validation,
        true,
    )
    .iter()
    .map(Issue::from_core)
    .collect()
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
