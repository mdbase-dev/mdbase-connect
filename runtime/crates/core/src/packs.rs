//! Type packs (spec 05A "Type Packs", "Assessment And Transactional Apply").
//!
//! - [`load_pack`] validates a `mdbase-pack.yaml` manifest and its resource
//!   bytes into a [`Pack`].
//! - [`assess_type_pack`] is pure and read-only. Over a [`StateView`] it plans
//!   every resource, retired resources and the `mdbase.lock.yaml` update. It
//!   stages the result to validate the combined catalog, and computes the
//!   `assessment_digest`.
//! - [`apply_type_pack`] re-assesses (at head), rejects with
//!   `concurrent_modification` when the digest differs, and returns the ops
//!   of **one mutation**: `resource_put`/`resource_delete` guarded by
//!   `base_revision`, plus the lock. The mutation is atomic and ordered by the
//!   log like any resource write.

// Diagnostics are the cold path; boxing them would only complicate callers.
#![allow(clippy::result_large_err)]

use std::collections::{BTreeMap, BTreeSet};

use crate::contracts::{Version, jcs_digest};
use crate::doc::{Document, LineEnding, RecordFormat};
use crate::ids::{Hash, revision};
use crate::intent::{Op, ResourceDelete, ResourcePut};
use crate::plan::Effect;
use crate::state::{Overlay, StateView};
use crate::types::LOCK_PATH;
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};

fn err(code: &str, msg: impl Into<String>) -> Issue {
    Issue::new(code, Severity::Error, Tier::Request, msg)
}

fn invalid(msg: impl Into<String>) -> Issue {
    err("invalid_type_pack", msg)
}

/// Resource ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Mode {
    /// Owned by the pack.
    Managed,
    /// Created once, then user-owned.
    Seed,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Managed => "managed",
            Mode::Seed => "seed",
        }
    }
}

/// A seed type's upgrade baseline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Baseline {
    /// SHA-256 of `document`.
    pub digest: Hash,
    /// The publisher's earlier starter, exact bytes.
    pub document: String,
    /// The `version` that document declares (presentation only).
    pub version: Option<i64>,
}

/// One manifest resource with its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackResource {
    /// `contract`, `type` or `schema`.
    pub kind: String,
    /// `managed` or `seed`.
    pub mode: Mode,
    /// Source path in the pack.
    pub source: String,
    /// Canonical collection target.
    pub target: String,
    /// SHA-256 of `document`.
    pub digest: Hash,
    /// The exact bytes.
    pub document: String,
    /// `upgrade_from` baselines.
    pub baselines: Vec<Baseline>,
}

/// A validated pack.
#[derive(Debug, Clone, PartialEq)]
pub struct Pack {
    /// Pack ID.
    pub id: String,
    /// Exact version.
    pub version: Version,
    /// The pack digest: JCS of the manifest.
    pub digest: Hash,
    /// Resources in manifest order.
    pub resources: Vec<PackResource>,
}

fn safe_path(p: &str) -> bool {
    crate::paths::check_path(p).is_ok()
}

fn is_identifier(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=150).contains(&s.len())
        && b[0].is_ascii_lowercase()
        && s.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
        && s.contains(['.', '_', '-'])
        && !s.ends_with(['.', '_', '-'])
        && !s.contains("..")
}

fn split_frontmatter(doc: &str) -> Option<Map> {
    let d = Document::parse(doc, RecordFormat::Markdown);
    (d.problem().is_none() && d.has_frontmatter()).then(|| d.frontmatter().clone())
}

/// Validate a manifest and its resources. `source(path)` returns the bytes
/// of a pack-relative source path.
pub fn load_pack(manifest: &str, source: &dyn Fn(&str) -> Option<String>) -> Result<Pack, Issue> {
    let m = match crate::yaml::parse_value(manifest) {
        Ok(Some(Value::Map(m))) => m,
        _ => return Err(invalid("the manifest is not a YAML mapping")),
    };
    for k in m.keys() {
        if !matches!(
            k,
            "kind" | "id" | "version" | "name" | "description" | "resources"
        ) && !k.starts_with("x-")
        {
            return Err(invalid(format!("unknown manifest member `{k}`")));
        }
    }
    if m.get("kind").and_then(Value::as_str) != Some("mdbase.type-pack") {
        return Err(invalid("`kind` must be mdbase.type-pack"));
    }
    let id = m
        .get("id")
        .and_then(Value::as_str)
        .filter(|i| is_identifier(i))
        .ok_or_else(|| invalid("`id` is not a pack identifier"))?;
    let version = m
        .get("version")
        .and_then(Value::as_str)
        .and_then(Version::parse)
        .ok_or_else(|| invalid("`version` is not a semantic version"))?;
    let Some(Value::List(items)) = m.get("resources") else {
        return Err(invalid("`resources` must be a non-empty list"));
    };
    if items.is_empty() {
        return Err(invalid("`resources` must be a non-empty list"));
    }
    let mut resources = Vec::new();
    let mut targets = BTreeSet::new();
    for (i, r) in items.iter().enumerate() {
        let Value::Map(r) = r else {
            return Err(invalid(format!("resource {i} is not a mapping")));
        };
        for k in r.keys() {
            if !matches!(
                k,
                "kind" | "mode" | "source" | "target" | "digest" | "upgrade_from"
            ) {
                return Err(invalid(format!("resource {i}: unknown member `{k}`")));
            }
        }
        let text = |k: &str| r.get(k).and_then(Value::as_str);
        let kind = text("kind").filter(|k| matches!(*k, "contract" | "type" | "schema"));
        let mode = match text("mode") {
            Some("managed") => Some(Mode::Managed),
            Some("seed") => Some(Mode::Seed),
            _ => None,
        };
        let (Some(kind), Some(mode), Some(src), Some(target), Some(digest)) = (
            kind,
            mode,
            text("source").filter(|p| safe_path(p)),
            text("target").filter(|p| safe_path(p)),
            text("digest").and_then(|d| d.starts_with("sha256:").then(|| Hash::parse(d)).flatten()),
        ) else {
            return Err(invalid(format!(
                "resource {i} lacks a valid kind, mode, source, target or digest"
            )));
        };
        if !targets.insert(crate::paths::path_key(target)) {
            return Err(invalid(format!("two resources target `{target}`")));
        }
        let document = source(src).ok_or_else(|| invalid(format!("missing source `{src}`")))?;
        if revision(&document) != digest {
            return Err(invalid(format!("digest mismatch for `{src}`")));
        }
        let mut res = PackResource {
            kind: kind.to_owned(),
            mode,
            source: src.to_owned(),
            target: target.to_owned(),
            digest,
            document,
            baselines: Vec::new(),
        };
        if let Some(up) = r.get("upgrade_from") {
            res.baselines = baselines(&res, up)?;
        }
        resources.push(res);
    }
    Ok(Pack {
        id: id.to_owned(),
        version,
        digest: jcs_digest(&Value::Map(m)),
        resources,
    })
}

fn baselines(res: &PackResource, declared: &Value) -> Result<Vec<Baseline>, Issue> {
    if res.kind != "type" || res.mode != Mode::Seed {
        return Err(invalid("upgrade_from is only valid on seed type resources"));
    }
    let entries: Vec<&Value> = match declared {
        Value::List(l) if l.is_empty() => return Err(invalid("upgrade_from is an empty list")),
        Value::List(l) => l.iter().collect(),
        other => vec![other],
    };
    let desired = split_frontmatter(&res.document)
        .ok_or_else(|| invalid("the seed type has no frontmatter"))?;
    let mut out: Vec<Baseline> = Vec::new();
    for e in entries {
        let Value::Map(e) = e else {
            return Err(invalid("an upgrade baseline is a mapping"));
        };
        if e.keys()
            .any(|k| !matches!(k, "digest" | "document" | "version"))
        {
            return Err(invalid("an upgrade baseline has an unknown member"));
        }
        let (Some(digest), Some(document)) = (
            e.get("digest")
                .and_then(Value::as_str)
                .and_then(Hash::parse),
            e.get("document").and_then(Value::as_str),
        ) else {
            return Err(invalid("an upgrade baseline needs `digest` and `document`"));
        };
        if revision(document) != digest {
            return Err(invalid(
                "an upgrade baseline's digest does not match its document",
            ));
        }
        if out.iter().any(|b| b.digest == digest) {
            return Err(invalid("upgrade baselines must have distinct digests"));
        }
        if digest == res.digest {
            return Err(invalid(
                "an upgrade baseline cannot be the desired document",
            ));
        }
        let fm = split_frontmatter(document)
            .ok_or_else(|| invalid("an upgrade baseline has no frontmatter"))?;
        if fm.get("kind") != desired.get("kind") || fm.get("name") != desired.get("name") {
            return Err(invalid(
                "an upgrade baseline must be the same type kind and name",
            ));
        }
        let version = match e.get("version") {
            None => None,
            Some(v) => {
                let v = v
                    .as_number()
                    .and_then(crate::value::Number::as_i64)
                    .filter(|v| *v >= 1);
                if v.is_none()
                    || fm
                        .get("version")
                        .and_then(Value::as_number)
                        .and_then(crate::value::Number::as_i64)
                        != v
                {
                    return Err(invalid(
                        "an upgrade baseline's version differs from its document",
                    ));
                }
                v
            }
        };
        out.push(Baseline {
            digest,
            document: document.to_owned(),
            version,
        });
    }
    Ok(out)
}

// -------------------------------------------------------------------- lock

/// One lock resource entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockResource {
    /// Kind.
    pub kind: String,
    /// Mode.
    pub mode: Mode,
    /// Canonical source.
    pub source: String,
    /// Resolved collection target.
    pub target: String,
    /// Installed digest (the pack's resource digest).
    pub digest: Hash,
    /// Seeds only: the publisher document the live target descends from.
    pub origin_digest: Option<Hash>,
}

/// One installed pack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    /// Pack ID.
    pub id: String,
    /// Version.
    pub version: String,
    /// Pack digest.
    pub digest: Hash,
    /// Installer identity.
    pub installed_by: String,
    /// Resources.
    pub resources: Vec<LockResource>,
}

/// `mdbase.lock.yaml`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Lock {
    /// Receipts, ordered by pack ID.
    pub packs: Vec<Receipt>,
}

impl Lock {
    /// Parse a lock document.
    pub fn parse(src: &str) -> Result<Lock, Issue> {
        let bad = || invalid("mdbase.lock.yaml is not a valid lock");
        let Ok(Some(Value::Map(m))) = crate::yaml::parse_value(src) else {
            return Err(bad());
        };
        if m.get("kind").and_then(Value::as_str) != Some("mdbase.type-pack-lock")
            || m.get("lock_version") != Some(&Value::Int(1))
        {
            return Err(bad());
        }
        let mut packs = Vec::new();
        for p in m.get("packs").and_then(Value::as_list).ok_or_else(bad)? {
            let t = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
            let mut resources = Vec::new();
            for r in p
                .get("resources")
                .and_then(Value::as_list)
                .ok_or_else(bad)?
            {
                let rt = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
                resources.push(LockResource {
                    kind: rt("kind").ok_or_else(bad)?,
                    mode: match rt("mode").as_deref() {
                        Some("managed") => Mode::Managed,
                        Some("seed") => Mode::Seed,
                        _ => return Err(bad()),
                    },
                    source: rt("source").ok_or_else(bad)?,
                    target: rt("target").ok_or_else(bad)?,
                    digest: rt("digest").and_then(|d| Hash::parse(&d)).ok_or_else(bad)?,
                    origin_digest: rt("origin_digest").and_then(|d| Hash::parse(&d)),
                });
            }
            packs.push(Receipt {
                id: t("id").ok_or_else(bad)?,
                version: t("version").ok_or_else(bad)?,
                digest: t("digest").and_then(|d| Hash::parse(&d)).ok_or_else(bad)?,
                installed_by: t("installed_by").ok_or_else(bad)?,
                resources,
            });
        }
        Ok(Lock { packs })
    }

    /// The lock as a value (deterministic order).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind", Value::string("mdbase.type-pack-lock"));
        m.insert("lock_version", Value::Int(1));
        m.insert(
            "packs",
            Value::List(self.packs.iter().map(Receipt::to_value).collect()),
        );
        Value::Map(m)
    }

    /// The lock document (deterministic YAML).
    pub fn render(&self) -> String {
        let Value::Map(m) = self.to_value() else {
            return String::new();
        };
        crate::writer::render_new(&m, "", RecordFormat::YamlDocument, LineEnding::Lf)
            .unwrap_or_default()
    }

    /// The receipt of pack `id`.
    pub fn receipt(&self, id: &str) -> Option<&Receipt> {
        self.packs.iter().find(|p| p.id == id)
    }
}

impl Receipt {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id", Value::string(self.id.clone()));
        m.insert("version", Value::string(self.version.clone()));
        m.insert("digest", Value::string(self.digest.to_string()));
        m.insert("installed_by", Value::string(self.installed_by.clone()));
        m.insert(
            "resources",
            Value::List(
                self.resources
                    .iter()
                    .map(|r| {
                        let mut e = Map::new();
                        e.insert("kind", Value::string(r.kind.clone()));
                        e.insert("mode", Value::string(r.mode.as_str()));
                        e.insert("source", Value::string(r.source.clone()));
                        e.insert("target", Value::string(r.target.clone()));
                        e.insert("digest", Value::string(r.digest.to_string()));
                        if let Some(o) = r.origin_digest {
                            e.insert("origin_digest", Value::string(o.to_string()));
                        }
                        Value::Map(e)
                    })
                    .collect(),
            ),
        );
        Value::Map(m)
    }
}

// -------------------------------------------------------------- assessment

/// A resource action (spec 05A).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Action {
    /// Write a new target.
    Create,
    /// Replace the target.
    Update,
    /// Remove a retired managed target.
    Delete,
    /// Record an existing byte-identical target as managed.
    Adopt,
    /// Nothing to do.
    Unchanged,
    /// A seed left as the user has it.
    Preserve,
    /// Not applicable.
    Conflict,
}

impl Action {
    /// The spec name.
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Create => "create",
            Action::Update => "update",
            Action::Delete => "delete",
            Action::Adopt => "adopt",
            Action::Unchanged => "unchanged",
            Action::Preserve => "preserve",
            Action::Conflict => "conflict",
        }
    }
}

/// The assessment status (spec 05A).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PackStatus {
    /// Installed and identical.
    Current,
    /// Not installed.
    Install,
    /// A newer version.
    Upgrade,
    /// An older version (needs `allow_downgrade`).
    Downgrade,
    /// The same pack resolved to different targets.
    Reconfigure,
    /// Not applicable.
    Conflict,
}

impl PackStatus {
    /// The spec name.
    pub fn as_str(self) -> &'static str {
        match self {
            PackStatus::Current => "current",
            PackStatus::Install => "install",
            PackStatus::Upgrade => "upgrade",
            PackStatus::Downgrade => "downgrade",
            PackStatus::Reconfigure => "reconfigure",
            PackStatus::Conflict => "conflict",
        }
    }
}

/// One planned resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedResource {
    /// Kind.
    pub kind: String,
    /// Mode.
    pub mode: Mode,
    /// Canonical source (empty for a retired resource).
    pub source: String,
    /// Resolved target.
    pub target: String,
    /// The action.
    pub action: Action,
    /// Digest of the live target, if it exists.
    pub live: Option<Hash>,
    /// The bytes to write (create/update).
    pub document: Option<String>,
    /// Digest after the action.
    pub result: Option<Hash>,
    /// Seeds: the origin digest the lock records afterwards.
    pub origin: Option<Hash>,
    /// Why (preserve without a baseline, conflicts).
    pub reason: Option<String>,
    /// Seed updates: the baseline used, `(digest, version)`.
    pub upgrade_baseline: Option<(Hash, Option<i64>)>,
}

/// Caller decisions (spec 05A).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssessOptions {
    /// Stable reverse-domain installer identity.
    pub installed_by: String,
    /// Canonical target → collection target.
    pub target_overrides: BTreeMap<String, String>,
    /// Explicit adoptions: unmanaged target → its exact current digest.
    pub adopt: BTreeMap<String, Hash>,
    /// Seed targets intentionally omitted.
    pub preserve_seed_targets: BTreeSet<String>,
    /// Permit a downgrade.
    pub allow_downgrade: bool,
}

/// The read-only assessment.
#[derive(Debug, Clone, PartialEq)]
pub struct Assessment {
    /// Status.
    pub status: PackStatus,
    /// The installed receipt, if any.
    pub current: Option<Receipt>,
    /// Pack ID, version and digest.
    pub pack: (String, String, Hash),
    /// Every resource: desired ones in manifest order, then retired ones.
    pub resources: Vec<PlannedResource>,
    /// `create`, `update` or `unchanged`.
    pub lock_action: Action,
    /// The lock document after apply.
    pub lock_document: String,
    /// Its digest.
    pub lock_digest: Hash,
    /// Problems found by validating the staged collection.
    pub issues: Vec<Issue>,
    /// Binds the pack, the lock entry, every relevant live target and the
    /// options (spec 05A).
    pub assessment_digest: Hash,
}

impl Assessment {
    /// Whether apply may proceed.
    pub fn applicable(&self) -> bool {
        !matches!(self.status, PackStatus::Conflict)
            && self.issues.is_empty()
            && self.resources.iter().all(|r| r.action != Action::Conflict)
    }
}

fn live_doc(state: &dyn StateView, path: &str) -> Option<String> {
    state.resource(path).map(|s| s.to_string())
}

/// Assess `pack` against `state` (read-only).
pub fn assess_type_pack(
    state: &dyn StateView,
    pack: &Pack,
    opts: &AssessOptions,
) -> Result<Assessment, Issue> {
    if !is_identifier(&opts.installed_by) {
        return Err(invalid(
            "`installed_by` must be a reverse-domain identifier",
        ));
    }
    // Pack's public fields can change after load/assessment. Recheck its input
    // invariants at every assessment (including apply), not just at load time.
    // Namespace/filesystem confinement and authorization remain caller gates.
    if !is_identifier(&pack.id) || pack.resources.is_empty() {
        return Err(invalid("pack identity and resources must be valid"));
    }
    let mut desired_targets = BTreeSet::new();
    for resource in &pack.resources {
        if !safe_path(&resource.source) || !safe_path(&resource.target) {
            return Err(invalid("pack source and target paths must be portable"));
        }
        if !matches!(resource.kind.as_str(), "contract" | "type" | "schema")
            || !desired_targets.insert(crate::paths::path_key(&resource.target))
        {
            return Err(invalid(
                "pack resources need valid kinds and distinct targets",
            ));
        }
        if revision(&resource.document) != resource.digest {
            return Err(invalid(
                "a desired resource's digest does not match its document",
            ));
        }
        if !resource.baselines.is_empty() {
            // Reuse the loader's baseline checks: exact bytes, distinct hashes,
            // kind/name, seed-only, and optional declared version consistency.
            let declared = Value::List(
                resource
                    .baselines
                    .iter()
                    .map(|b| {
                        let mut value = Map::new();
                        value.insert("digest", Value::string(b.digest.to_string()));
                        value.insert("document", Value::string(b.document.clone()));
                        if let Some(v) = b.version {
                            value.insert("version", Value::Int(v));
                        }
                        Value::Map(value)
                    })
                    .collect(),
            );
            baselines(resource, &declared)?;
        }
    }
    for (from, to) in &opts.target_overrides {
        if !pack.resources.iter().any(|r| r.target == *from) || !safe_path(to) {
            return Err(invalid(format!(
                "target override `{from}` → `{to}` is not valid"
            )));
        }
    }
    let target_of = |r: &PackResource| {
        opts.target_overrides
            .get(&r.target)
            .cloned()
            .unwrap_or_else(|| r.target.clone())
    };
    for t in &opts.preserve_seed_targets {
        if !pack
            .resources
            .iter()
            .any(|r| r.mode == Mode::Seed && target_of(r) == *t)
        {
            return Err(invalid(format!("`{t}` is not a seed target of this pack")));
        }
    }
    for t in opts.adopt.keys() {
        if !pack
            .resources
            .iter()
            .any(|r| r.mode == Mode::Managed && target_of(r) == *t)
        {
            return Err(invalid(format!(
                "`{t}` is not a managed target of this pack"
            )));
        }
    }
    let lock_src = live_doc(state, LOCK_PATH);
    let lock = match &lock_src {
        Some(s) => Lock::parse(s)?,
        None => Lock::default(),
    };
    let receipt = lock.receipt(&pack.id).cloned();
    let entry_of = |target: &str| {
        receipt
            .as_ref()
            .and_then(|r| r.resources.iter().find(|e| e.target == target))
    };
    let mut planned: Vec<PlannedResource> = Vec::new();
    for r in &pack.resources {
        let target = target_of(r);
        let live = live_doc(state, &target);
        let entry = entry_of(&target);
        let mut p = PlannedResource {
            kind: r.kind.clone(),
            mode: r.mode,
            source: r.source.clone(),
            target: target.clone(),
            action: Action::Unchanged,
            live: live.as_deref().map(revision),
            document: None,
            result: live.as_deref().map(revision),
            origin: None,
            reason: None,
            upgrade_baseline: None,
        };
        match r.mode {
            Mode::Managed => {
                plan_managed(r, entry, live.as_deref(), opts.adopt.get(&target), &mut p)
            }
            Mode::Seed => plan_seed(
                r,
                entry,
                live.as_deref(),
                opts.preserve_seed_targets.contains(&target),
                &mut p,
            ),
        }
        if let Some(d) = &p.document {
            p.result = Some(revision(d));
        }
        planned.push(p);
    }
    // Retired resources: in the receipt, not in the pack (or moved).
    if let Some(rc) = &receipt {
        for e in &rc.resources {
            if planned.iter().any(|p| p.target == e.target) {
                continue;
            }
            let live = live_doc(state, &e.target);
            let live_digest = live.as_deref().map(revision);
            let (action, reason) = match (e.mode, live_digest) {
                (_, None) => (Action::Unchanged, None),
                (Mode::Seed, Some(_)) => (Action::Preserve, None),
                (Mode::Managed, Some(d)) if d == e.digest => (Action::Delete, None),
                (Mode::Managed, Some(_)) => (
                    Action::Conflict,
                    Some(format!(
                        "{}: retired managed resource was modified",
                        e.target
                    )),
                ),
            };
            planned.push(PlannedResource {
                kind: e.kind.clone(),
                mode: e.mode,
                source: String::new(),
                target: e.target.clone(),
                action,
                live: live_digest,
                document: None,
                result: if action == Action::Delete {
                    None
                } else {
                    live_digest
                },
                origin: e.origin_digest,
                reason,
                upgrade_baseline: None,
            });
        }
    }
    // Status.
    let targets_changed = receipt.as_ref().is_some_and(|rc| {
        pack.resources.iter().any(|r| {
            !rc.resources
                .iter()
                .any(|e| e.source == r.source && e.target == target_of(r))
        })
    });
    let mut status = match &receipt {
        _ if planned.iter().any(|p| p.action == Action::Conflict) => PackStatus::Conflict,
        None => PackStatus::Install,
        Some(rc) => {
            let installed = Version::parse(&rc.version);
            match installed.as_ref().map(|v| pack.version.cmp(v)) {
                Some(std::cmp::Ordering::Equal) if rc.digest == pack.digest && !targets_changed => {
                    PackStatus::Current
                }
                Some(std::cmp::Ordering::Equal) if rc.digest == pack.digest => {
                    PackStatus::Reconfigure
                }
                Some(std::cmp::Ordering::Less) => PackStatus::Downgrade,
                _ => PackStatus::Upgrade,
            }
        }
    };
    // The new lock.
    let new_receipt = Receipt {
        id: pack.id.clone(),
        version: pack.version.to_string(),
        digest: pack.digest,
        installed_by: receipt
            .as_ref()
            .map_or_else(|| opts.installed_by.clone(), |r| r.installed_by.clone()),
        resources: pack
            .resources
            .iter()
            .zip(&planned)
            .map(|(r, p)| LockResource {
                kind: r.kind.clone(),
                mode: r.mode,
                source: r.source.clone(),
                target: p.target.clone(),
                digest: r.digest,
                origin_digest: if r.mode == Mode::Seed { p.origin } else { None },
            })
            .collect(),
    };
    let mut new_lock = lock.clone();
    new_lock.packs.retain(|p| p.id != pack.id);
    new_lock.packs.push(new_receipt);
    new_lock.packs.sort_by(|a, b| a.id.cmp(&b.id));
    let lock_document = new_lock.render();
    let lock_action = match &lock_src {
        None => Action::Create,
        Some(s) if *s == lock_document => Action::Unchanged,
        Some(_) => Action::Update,
    };
    // Validate the staged collection.
    let mut staged = Overlay::new(state);
    for p in &planned {
        match (&p.document, p.action) {
            (Some(d), _) => staged.apply_effect(&Effect::PutResource {
                path: p.target.clone(),
                doc: d.clone(),
            }),
            (None, Action::Delete) => staged.apply_effect(&Effect::RemoveResource {
                path: p.target.clone(),
            }),
            _ => {}
        }
    }
    let catalog = staged.catalog();
    let touched: BTreeSet<&str> = planned.iter().map(|p| p.target.as_str()).collect();
    let issues: Vec<Issue> = catalog
        .issues()
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .filter(|i| {
            i.location.as_deref().is_some_and(|l| touched.contains(l)) || !catalog.is_valid()
        })
        .cloned()
        .collect();
    if status == PackStatus::Downgrade && !opts.allow_downgrade {
        status = PackStatus::Conflict;
    }
    // The assessment digest.
    let mut targets = Map::new();
    let mut all_targets: BTreeSet<String> = planned.iter().map(|p| p.target.clone()).collect();
    all_targets.insert(LOCK_PATH.into());
    for t in &all_targets {
        targets.insert(
            t.clone(),
            live_doc(state, t).map_or(Value::Null, |d| Value::string(revision(&d).to_string())),
        );
    }
    let mut digest_obj = Map::new();
    let mut packv = Map::new();
    packv.insert("id", Value::string(pack.id.clone()));
    packv.insert("version", Value::string(pack.version.to_string()));
    packv.insert("digest", Value::string(pack.digest.to_string()));
    digest_obj.insert("pack", Value::Map(packv));
    // The declared manifest identity alone cannot bind a mutable public Pack.
    // Hash actual desired bytes and every approval-relevant resource input,
    // preserving resource/baseline order. A caller changing docs AND their
    // declared digests must still obtain a new reviewed assessment.
    digest_obj.insert(
        "desired_resources",
        Value::List(
            pack.resources
                .iter()
                .map(|r| {
                    let mut value = Map::new();
                    value.insert("kind", Value::string(r.kind.clone()));
                    value.insert("mode", Value::string(r.mode.as_str()));
                    value.insert("source", Value::string(r.source.clone()));
                    value.insert("target", Value::string(r.target.clone()));
                    value.insert("digest", Value::string(r.digest.to_string()));
                    value.insert(
                        "document_digest",
                        Value::string(revision(&r.document).to_string()),
                    );
                    value.insert(
                        "baselines",
                        Value::List(
                            r.baselines
                                .iter()
                                .map(|b| {
                                    let mut baseline = Map::new();
                                    baseline.insert("digest", Value::string(b.digest.to_string()));
                                    baseline.insert(
                                        "document_digest",
                                        Value::string(revision(&b.document).to_string()),
                                    );
                                    baseline.insert(
                                        "version",
                                        b.version.map_or(Value::Null, Value::Int),
                                    );
                                    Value::Map(baseline)
                                })
                                .collect(),
                        ),
                    );
                    Value::Map(value)
                })
                .collect(),
        ),
    );
    digest_obj.insert(
        "lock_entry",
        receipt.as_ref().map_or(Value::Null, Receipt::to_value),
    );
    digest_obj.insert("targets", Value::Map(targets));
    digest_obj.insert("installed_by", Value::string(opts.installed_by.clone()));
    digest_obj.insert(
        "target_overrides",
        Value::Map(
            opts.target_overrides
                .iter()
                .map(|(k, v)| (k.clone(), Value::string(v.clone())))
                .collect(),
        ),
    );
    digest_obj.insert(
        "adopt",
        Value::Map(
            opts.adopt
                .iter()
                .map(|(k, v)| (k.clone(), Value::string(v.to_string())))
                .collect(),
        ),
    );
    digest_obj.insert(
        "preserve_seed_targets",
        Value::List(
            opts.preserve_seed_targets
                .iter()
                .map(|t| Value::string(t.clone()))
                .collect(),
        ),
    );
    digest_obj.insert("allow_downgrade", Value::Bool(opts.allow_downgrade));
    Ok(Assessment {
        status,
        current: receipt,
        pack: (pack.id.clone(), pack.version.to_string(), pack.digest),
        resources: planned,
        lock_action,
        lock_digest: revision(&lock_document),
        lock_document,
        issues,
        assessment_digest: jcs_digest(&Value::Map(digest_obj)),
    })
}

fn plan_managed(
    r: &PackResource,
    entry: Option<&LockResource>,
    live: Option<&str>,
    adopt: Option<&Hash>,
    p: &mut PlannedResource,
) {
    match live {
        None => {
            p.action = Action::Create;
            p.document = Some(r.document.clone());
        }
        Some(l) if l == r.document => {
            p.action = if entry.is_some() {
                Action::Unchanged
            } else {
                Action::Adopt
            };
        }
        Some(l) => {
            let d = revision(l);
            if entry.is_some_and(|e| e.digest == d) || adopt == Some(&d) {
                p.action = Action::Update;
                p.document = Some(r.document.clone());
            } else {
                p.action = Action::Conflict;
                p.reason = Some(match adopt {
                    Some(_) => format!("{}: the adoption digest is stale", r.target),
                    None if entry.is_some() => {
                        format!("{}: the managed resource was modified", r.target)
                    }
                    None => format!("{}: an unmanaged target has different bytes", r.target),
                });
            }
        }
    }
}

fn plan_seed(
    r: &PackResource,
    entry: Option<&LockResource>,
    live: Option<&str>,
    preserved: bool,
    p: &mut PlannedResource,
) {
    let previous_origin = entry.and_then(|e| e.origin_digest);
    p.origin = previous_origin;
    let Some(live) = live else {
        if entry.is_none() && !preserved {
            p.action = Action::Create;
            p.document = Some(r.document.clone());
            p.origin = Some(r.digest);
        } else {
            p.action = Action::Preserve;
        }
        return;
    };
    p.action = Action::Preserve;
    if live == r.document {
        p.origin = Some(r.digest);
        return;
    }
    if preserved || r.baselines.is_empty() {
        return;
    }
    if let Some(b) = r.baselines.iter().find(|b| b.document == live) {
        p.action = Action::Update;
        p.document = Some(r.document.clone());
        p.origin = Some(r.digest);
        p.upgrade_baseline = Some((b.digest, b.version));
        return;
    }
    if previous_origin == Some(r.digest) {
        return;
    }
    let Some(b) = r
        .baselines
        .iter()
        .find(|b| Some(b.digest) == previous_origin)
    else {
        p.reason = Some(format!(
            "{}: no upgrade baseline applies to this type's origin",
            r.target
        ));
        return;
    };
    match merge_type(&b.document, live, &r.document) {
        Ok(doc) => {
            p.action = Action::Update;
            p.document = Some(doc);
            p.origin = Some(r.digest);
            p.upgrade_baseline = Some((b.digest, b.version));
        }
        Err(why) => {
            p.action = Action::Conflict;
            p.reason = Some(format!("{}: {why}", r.target));
        }
    }
}

/// Three-way merge of type frontmatter (spec 05A seed upgrades): the live
/// body and unchanged entries keep their bytes; changed top-level entries are
/// re-emitted.
fn merge_type(base: &str, live: &str, desired: &str) -> Result<String, String> {
    let fm =
        |s: &str| split_frontmatter(s).ok_or_else(|| "a version has no frontmatter".to_owned());
    let (b, l, d) = (fm(base)?, fm(live)?, fm(desired)?);
    for k in ["kind", "name"] {
        if l.get(k) != d.get(k) {
            return Err(format!("type {k} differs"));
        }
    }
    for k in b.keys() {
        if !d.contains_key(k) && l.contains_key(k) {
            return Err(format!(
                "removing top-level setting {k} requires manual review"
            ));
        }
    }
    let merged = merge_values(
        Some(&Value::Map(b)),
        Some(&Value::Map(l.clone())),
        Some(&Value::Map(d)),
        "",
    )?;
    let Some(Value::Map(merged)) = merged else {
        return Err("the merged frontmatter is not a mapping".into());
    };
    let mut changes = Vec::new();
    for (k, v) in merged.iter() {
        if l.get(k).is_none_or(|x| !same(x, v)) {
            changes.push((k.to_owned(), crate::writer::Change::Set(v.clone())));
        }
    }
    for k in l.keys() {
        if !merged.contains_key(k) {
            changes.push((k.to_owned(), crate::writer::Change::Remove));
        }
    }
    let doc = Document::parse(live, RecordFormat::Markdown);
    crate::writer::write(&doc, &changes, None).map_err(|e| e.to_string())
}

fn same(a: &Value, b: &Value) -> bool {
    a == b && a.to_json() == b.to_json()
}

fn merge_values(
    base: Option<&Value>,
    live: Option<&Value>,
    desired: Option<&Value>,
    path: &str,
) -> Result<Option<Value>, String> {
    let eq = |x: Option<&Value>, y: Option<&Value>| match (x, y) {
        (None, None) => true,
        (Some(x), Some(y)) => same(x, y),
        _ => false,
    };
    if eq(live, base) {
        return Ok(desired.cloned());
    }
    if eq(desired, base) || eq(live, desired) {
        return Ok(live.cloned());
    }
    let as_map = |v: Option<&Value>| match v {
        Some(Value::Map(m)) => Some(m.clone()),
        _ => None,
    };
    let base_map = match base {
        None => Some(Map::new()),
        b => as_map(b),
    };
    if let (Some(bm), Some(lm), Some(dm)) = (base_map, as_map(live), as_map(desired)) {
        let mut out = Map::new();
        let mut keys: Vec<String> = lm.keys().map(str::to_owned).collect();
        keys.extend(dm.keys().filter(|k| !lm.contains_key(k)).map(str::to_owned));
        for k in keys {
            if let Some(v) =
                merge_values(bm.get(&k), lm.get(&k), dm.get(&k), &format!("{path}/{k}"))?
            {
                out.insert(k, v);
            }
        }
        return Ok(Some(Value::Map(out)));
    }
    Err(format!(
        "competing changes at {}",
        if path.is_empty() { "/" } else { path }
    ))
}

/// Apply: re-assess `pack` at `state` (the writer's head) and, when the
/// assessment still has `expected` as its digest and is applicable, return
/// the ops of one mutation that installs it. A current pack with nothing to
/// write returns no ops (no new collection revision).
pub fn apply_type_pack(
    state: &dyn StateView,
    pack: &Pack,
    opts: &AssessOptions,
    expected: &Hash,
) -> Result<(Assessment, Vec<Op>), Issue> {
    let a = assess_type_pack(state, pack, opts)?;
    if a.assessment_digest != *expected {
        return Err(err(
            "concurrent_modification",
            "the desired pack, collection or options changed after assessment",
        ));
    }
    if !a.applicable() {
        let reasons: Vec<String> = a
            .resources
            .iter()
            .filter_map(|r| r.reason.clone())
            .collect();
        let mut e = err(
            "type_pack_conflict",
            format!("the pack cannot be applied: {}", reasons.join("; ")),
        );
        // Ownership conflicts come first; an invalid staged collection only
        // matters for a pack that could otherwise be applied.
        let conflict = a.status == PackStatus::Conflict
            || a.resources.iter().any(|r| r.action == Action::Conflict);
        if !conflict && !a.issues.is_empty() {
            e = err(
                "invalid_type_pack",
                format!("the staged collection is invalid: {}", a.issues[0].message),
            );
        }
        return Err(e);
    }
    let mut ops = Vec::new();
    for r in &a.resources {
        match (&r.document, r.action) {
            // A create must not overwrite a target created concurrently
            // (intent.md §3.6 `must_not_exist`).
            (Some(doc), _) => ops.push(Op::ResourcePut(ResourcePut {
                path: r.target.clone(),
                doc: doc.clone(),
                base_revision: r.live,
                must_not_exist: r.live.is_none(),
            })),
            (None, Action::Delete) => ops.push(Op::ResourceDelete(ResourceDelete {
                path: r.target.clone(),
                base_revision: r.live,
            })),
            _ => {}
        }
    }
    if a.lock_action != Action::Unchanged {
        let base_revision = state.resource(LOCK_PATH).map(|s| revision(&s));
        ops.push(Op::ResourcePut(ResourcePut {
            path: LOCK_PATH.into(),
            doc: a.lock_document.clone(),
            must_not_exist: base_revision.is_none(),
            base_revision,
        }));
    }
    Ok((a, ops))
}
