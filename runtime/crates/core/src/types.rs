//! The catalog: collection configuration and type files (spec 04, 05, 07).
//!
//! A [`Catalog`] is compiled from the collection's **resources** (`mdbase.yaml`
//! and the files in the types and contracts folders) as they stand at one log
//! position. It is a pure function of those sources (their order does not
//! matter), so every replica that has applied the same resource writes holds an
//! identical catalog.
//!
//! The catalog answers:
//! - **membership**: which types a record matches ([`Catalog::membership`],
//!   spec 07 "Matching Decision Process");
//! - **collection behaviour** per type: lifecycle actions, link fields,
//!   uniqueness rules, read defaults, path policy, merge declarations;
//! - **resource classification**: whether a path is a resource
//!   ([`Catalog::is_resource_path`]) or a record ([`Catalog::is_record_path`]).
//!
//! A catalog whose configuration does not load (invalid `mdbase.yaml`, an
//! unsupported `spec_version`) is still a value: [`Catalog::is_valid`] is false
//! and writes are rejected with `collection_invalid`. Invalid type files are
//! reported in [`Catalog::issues`] and left out.
//!
//! **Ownership.** core-B. Merge strategies are core-A's (`merge::strategy`):
//! `TypeDef::merge` keeps the declarations as written, and the catalog feeds
//! them to the merge through `merge::MergeTypes`.

use std::collections::{BTreeMap, BTreeSet};

use crate::doc::{Document, RecordFormat};
use crate::intent::{Level, OpClock};
use crate::paths::{Glob, path_key};
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};

/// The config resource path.
pub const CONFIG_PATH: &str = "mdbase.yaml";

/// The type-pack lock (spec 05A "Pack Identity And Portable Provenance"): a
/// resource, so pack installs commit it in the same mutation.
pub const LOCK_PATH: &str = "mdbase.lock.yaml";
/// Shared configuration contribution receipts, not pack-owned configuration.
pub const PROVISION_LOCK_PATH: &str = "mdbase.provisions.yaml";

/// The `spec_version` values this catalog accepts.
pub const SUPPORTED_SPEC_VERSIONS: &[&str] = &["0.3.0"];

/// `settings` from `mdbase.yaml` (spec 04), with defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// `settings.timezone`: durable IANA zone, if configured.
    pub timezone: Option<String>,
    /// `settings.types_folder` (default `_types`).
    pub types_folder: String,
    /// `settings.contracts_folder` (default `_contracts`).
    pub contracts_folder: String,
    /// `settings.record_extensions` without dots (default `[md]`).
    pub record_extensions: Vec<String>,
    /// `settings.validation` (default `error`).
    pub validation: Level,
    /// `settings.explicit_type_keys` (default `[type, types]`).
    pub explicit_type_keys: Vec<String>,
    /// `settings.id_field`: no default.
    pub id_field: Option<String>,
    /// `settings.exclude`: extra excluded globs.
    pub exclude: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            timezone: None,
            types_folder: "_types".into(),
            contracts_folder: "_contracts".into(),
            record_extensions: vec!["md".into()],
            validation: Level::Error,
            explicit_type_keys: vec!["type".into(), "types".into()],
            id_field: None,
            exclude: Vec::new(),
        }
    }
}

/// A uniqueness rule's enforcement mode (spec 07).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Enforce {
    /// Reported as a cross-record issue; never rejects.
    Report,
    /// Rejects writes (S-class: authoritative at head).
    Write,
}

/// A uniqueness rule's comparison set (spec 07).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UniqueScope {
    /// Every record matching the declaring type.
    Type,
    /// Every record in the collection.
    Collection,
    /// Every record whose path matches the glob; it also limits the governed
    /// records.
    PathGlob(Glob),
}

/// One `collection.unique` rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniqueRule {
    /// The field reference as written.
    pub field: String,
    /// Enforcement mode.
    pub enforce: Enforce,
    /// Comparison set.
    pub scope: UniqueScope,
}

/// A lifecycle event (spec 09).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LifecycleEvent {
    /// `on_create`.
    Create,
    /// `on_update`.
    Update,
}

/// A lifecycle value provider (spec 09).
#[derive(Debug, Clone, PartialEq)]
pub enum Provider {
    /// `{ now: true }`: the captured instant (RFC 3339, ms, `Z`).
    Now,
    /// `{ today: true }`: the captured local date.
    Today,
    /// `{ uuid: true }`: from the generated-value stream.
    Uuid,
    /// `{ ulid: true }`: captured instant plus the generated-value stream.
    Ulid,
    /// `{ slugify: fieldRef }`.
    Slugify(String),
    /// `{ copy: fieldRef }`.
    Copy(String),
    /// `{ literal: value }`.
    Literal(Value),
}

/// One lifecycle action: an optional CEL guard and a `set` mapping.
#[derive(Debug, Clone, PartialEq)]
pub struct LifecycleAction {
    /// The CEL guard `if`.
    pub guard: Option<String>,
    /// `set`: field reference → provider, in mapping order.
    pub set: Vec<(String, Provider)>,
}

/// The `match` section of a type (spec 07).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MatchSpec {
    /// `match.path_glob` (any of).
    pub path_globs: Vec<Glob>,
    /// `match.fields_present` (all of), as field references.
    pub fields_present: Vec<String>,
    /// `match.where`: field selector → predicate (a direct value or an
    /// operator mapping).
    pub where_: Vec<(String, Value)>,
    /// `match.expr`: a CEL predicate (CEL Match profile).
    pub expr: Option<String>,
    /// `match.expr`, compiled at load.
    pub program: Option<CelProgram>,
}

/// A compiled CEL program held by the catalog. Equality is by the source the
/// owner keeps next to it, so this compares equal.
#[derive(Debug, Clone)]
pub struct CelProgram(pub std::sync::Arc<crate::cel::Program>);

impl PartialEq for CelProgram {
    fn eq(&self, _: &CelProgram) -> bool {
        true
    }
}

/// A declared link field (`collection.links`, spec 07/08).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkField {
    /// `target_type`, when declared.
    pub target_type: Option<String>,
    /// `validate_exists`.
    pub validate_exists: bool,
}

/// A compiled schema, shared. Equality is by the source it was compiled
/// from (`TypeDef::schema_document` and `schema_entry`), so it compares equal.
#[derive(Debug, Clone)]
pub struct SchemaHandle(pub std::sync::Arc<crate::jsonschema::CompiledSchema>);

impl PartialEq for SchemaHandle {
    fn eq(&self, _: &SchemaHandle) -> bool {
        true
    }
}

/// One compiled type definition.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeDef {
    /// The name as written.
    pub name: String,
    /// The type file's resource path.
    pub source_path: String,
    /// `version`, when present.
    pub version: Option<i64>,
    /// `match`, when present; types without it match only explicitly.
    pub match_spec: Option<MatchSpec>,
    /// The schema document: `schema.value`, or the referenced JSON file.
    pub schema_document: Value,
    /// JSON Pointer into `schema_document` of the type's schema (`""` = root).
    pub schema_entry: String,
    /// The compiled schema.
    pub schema: SchemaHandle,
    /// `collection.merge`, as written (top-level field → strategy name).
    pub merge: BTreeMap<String, String>,
    /// `collection.unique`.
    pub unique: Vec<UniqueRule>,
    /// `collection.links`, by selector as written (`parent`, `blocks[]`, `/rel`).
    pub link_fields: BTreeMap<String, LinkField>,
    /// `collection.read_defaults`.
    pub read_defaults: Map,
    /// `collection.path.pattern`.
    pub path_pattern: Option<String>,
    /// `lifecycle.on_create` / `on_update`.
    pub lifecycle: BTreeMap<LifecycleEvent, Vec<LifecycleAction>>,
    /// The whole type-file frontmatter.
    pub raw: Map,
}

impl TypeDef {
    /// Top-level fields this type's lifecycle assigns with `now` or `today`
    /// (merge default `max`, spec 07).
    pub fn time_fields(&self) -> BTreeSet<String> {
        self.lifecycle
            .values()
            .flatten()
            .flat_map(|a| &a.set)
            .filter(|(_, p)| matches!(p, Provider::Now | Provider::Today))
            .filter_map(|(f, _)| top_level_field(f))
            .collect()
    }

    /// Whether this type has a `match` section that matches the record.
    fn matches_inferred(
        &self,
        path: &str,
        frontmatter: &Map,
        clock: Option<&OpClock>,
        issues: &mut Vec<Issue>,
    ) -> bool {
        let Some(m) = &self.match_spec else {
            return false;
        };
        if !m.path_globs.is_empty() && !m.path_globs.iter().any(|g| g.matches(path)) {
            return false;
        }
        if !m
            .fields_present
            .iter()
            .all(|f| select_one(frontmatter, f).is_some_and(|v| !v.is_null()))
        {
            return false;
        }
        if !m
            .where_
            .iter()
            .all(|(sel, pred)| where_matches(select_one(frontmatter, sel), pred))
        {
            return false;
        }
        if let Some(CelProgram(program)) = &m.program {
            let file = crate::cel::CelValue::from_value(&map([("path", Value::string(path))]));
            let mut act = crate::cel::record_activation(frontmatter, frontmatter, file);
            if let Some(c) = clock {
                act.with_clock(crate::lifecycle::cel_clock(
                    c.instant_ms,
                    &c.local_date,
                    &c.tz,
                ));
            }
            match program.evaluate(&act) {
                Ok(crate::cel::CelValue::Bool(true)) => {}
                Ok(_) => return false,
                Err(e) => {
                    issues.push(
                        Issue::new(
                            "expression_evaluation_error",
                            Severity::Warning,
                            Tier::SingleRecord,
                            format!("`match.expr` of type `{}`: {e}", self.name),
                        )
                        .with_type(&self.name),
                    );
                    return false;
                }
            }
        }
        true
    }
}

/// The types a record matches, in spec order (explicit declaration order, else
/// canonical lower-case name), with membership diagnostics.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Membership {
    /// Matched type names, as written in the type files.
    pub types: Vec<String>,
    /// Whether membership came from an explicit type key.
    pub explicit: bool,
    /// Diagnostics: invalid declarations, unknown types, expression errors.
    pub issues: Vec<Issue>,
}

/// The compiled catalog. Cheap to share behind an `Arc`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Catalog {
    settings: Settings,
    spec_version: Option<String>,
    types: Vec<TypeDef>,
    issues: Vec<Issue>,
    config_valid: bool,
    exclude: Vec<Glob>,
    contracts: Vec<crate::contracts::Contract>,
    implementations: Vec<crate::contracts::Implementation>,
    schema_resources: BTreeSet<String>,
}

impl Catalog {
    /// The catalog of a collection with no resources: default settings, no
    /// types. Valid.
    pub fn empty() -> Catalog {
        Catalog {
            config_valid: true,
            ..Catalog::default()
        }
    }

    /// Compile a catalog from resources `(path, source)`. The result depends
    /// only on the set, not on the order.
    pub fn load<'a>(resources: impl IntoIterator<Item = (&'a str, &'a str)>) -> Catalog {
        let resources: BTreeMap<&str, &str> = resources.into_iter().collect();
        let mut cat = Catalog::empty();
        if let Some(src) = resources.get(CONFIG_PATH) {
            cat.load_config(src);
        }
        let folder = format!("{}/", cat.settings.types_folder);
        let mut loaded: Vec<TypeDef> = Vec::new();
        for (path, src) in &resources {
            if path.starts_with(&folder)
                && path.ends_with(".md")
                && let Some(t) = load_type(path, src, &resources, &mut cat.issues)
            {
                loaded.push(t);
            }
        }
        // Name conflicts: names that differ only by case conflict.
        let mut by_name: BTreeMap<String, Vec<TypeDef>> = BTreeMap::new();
        for t in loaded {
            by_name.entry(t.name.to_lowercase()).or_default().push(t);
        }
        for (lower, mut defs) in by_name {
            if defs.len() == 1 {
                cat.types.extend(defs.pop());
            } else {
                let paths: Vec<Value> = defs
                    .iter()
                    .map(|d| Value::string(d.source_path.clone()))
                    .collect();
                cat.issues.push(
                    Issue::new(
                        "type_conflict",
                        Severity::Error,
                        Tier::Request,
                        format!("several type files define `{lower}`"),
                    )
                    .with_type(&lower)
                    .with_details(map([("paths", Value::List(paths))])),
                );
            }
        }
        cat.load_contracts(&resources);
        if let Some(lock) = resources
            .get(LOCK_PATH)
            .and_then(|source| crate::packs::Lock::parse(source).ok())
        {
            for receipt in lock.packs {
                for resource in receipt.resources {
                    if resource.kind == "schema" && resource.mode == crate::packs::Mode::Managed {
                        cat.schema_resources.insert(resource.target);
                    }
                }
            }
        }
        // Only successfully resolved local references of registered contracts
        // classify a schema; arbitrary neighbouring JSON remains ordinary data.
        for contract in &cat.contracts {
            if let Some(source) = resources.get(contract.source_path.as_str()) {
                let document =
                    crate::doc::Document::parse(*source, crate::doc::RecordFormat::Markdown);
                for member in contract.schemas.keys() {
                    if let Some(reference) = document
                        .frontmatter()
                        .get(member)
                        .and_then(Value::as_map)
                        .and_then(|wrapper| wrapper.get("ref"))
                        .and_then(Value::as_str)
                        && let Ok((target, _)) = schema_ref_target(&contract.source_path, reference)
                    {
                        cat.schema_resources.insert(target);
                    }
                }
            }
        }
        cat
    }

    /// Spec 05A "Contract Registry": register every contract by exact
    /// `(id, version)`, report conflicting duplicates, then resolve and
    /// validate every type's `implements`.
    fn load_contracts(&mut self, resources: &BTreeMap<&str, &str>) {
        use crate::contracts::{Contract, implementations_of_type, load_contract};
        let folder = format!("{}/", self.settings.contracts_folder);
        let mut loaded: Vec<Contract> = Vec::new();
        let mut conflicted: Vec<(String, crate::contracts::Version)> = Vec::new();
        for (path, src) in resources {
            if !path.starts_with(&folder) || !path.ends_with(".md") {
                continue;
            }
            match load_contract(path, src, resources) {
                Ok(c) => {
                    match loaded
                        .iter()
                        .find(|x| x.id == c.id && x.version == c.version)
                    {
                        Some(x) if x.digest != c.digest => {
                            self.issues.push(
                                Issue::new(
                                    "data_contract_conflict",
                                    Severity::Error,
                                    Tier::Request,
                                    format!(
                                        "data contract conflict: `{}` {} has different content in `{}` and `{}`",
                                        c.id, c.version, x.source_path, c.source_path
                                    ),
                                )
                                .at(*path),
                            );
                            conflicted.push((c.id.clone(), c.version.clone()));
                        }
                        Some(_) => {}
                        None => loaded.push(c),
                    }
                }
                Err(i) => self.issues.push(i),
            }
        }
        loaded.retain(|c| {
            !conflicted
                .iter()
                .any(|(id, v)| *id == c.id && *v == c.version)
        });
        loaded.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| a.version.cmp(&b.version)));
        let mut imps = Vec::new();
        for t in &self.types {
            imps.extend(implementations_of_type(t, &loaded, &mut self.issues));
        }
        self.contracts = loaded;
        self.implementations = imps;
    }

    /// Registered contracts, ordered by ID then version.
    pub fn contracts(&self) -> &[crate::contracts::Contract] {
        &self.contracts
    }

    /// The contract `id` at exactly `version`.
    pub fn contract(
        &self,
        id: &str,
        version: &crate::contracts::Version,
    ) -> Option<&crate::contracts::Contract> {
        self.contracts
            .iter()
            .find(|c| c.id == id && c.version == *version)
    }

    /// Every valid implementation, ordered by type name then contract ID.
    pub fn implementations(&self) -> &[crate::contracts::Implementation] {
        &self.implementations
    }

    /// The implementations of contract `id` (spec 05A "Multiple
    /// Implementations": the full set, in canonical type order). With
    /// `requirement`, only those whose resolved version satisfies it; a
    /// requirement no registered version satisfies is
    /// `data_contract_version_mismatch`, an unknown ID
    /// `data_contract_not_found`, and malformed syntax `invalid_request`.
    #[allow(clippy::result_large_err)]
    pub fn implementations_of(
        &self,
        id: &str,
        requirement: Option<&str>,
    ) -> Result<Vec<&crate::contracts::Implementation>, Issue> {
        let err = |code: &str, m: String| Issue::new(code, Severity::Error, Tier::Request, m);
        if !self.contracts.iter().any(|c| c.id == id) {
            return Err(err(
                "data_contract_not_found",
                format!("no contract `{id}` is registered"),
            ));
        }
        let req = match requirement {
            Some(r) => Some(crate::contracts::Requirement::parse(r).ok_or_else(|| {
                err(
                    "invalid_request",
                    format!("`{r}` is not a version requirement"),
                )
            })?),
            None => None,
        };
        if let Some(r) = &req
            && crate::contracts::resolve(&self.contracts, id, r).is_none()
        {
            return Err(err(
                "data_contract_version_mismatch",
                format!("no version of `{id}` satisfies `{r}`"),
            ));
        }
        Ok(self
            .implementations
            .iter()
            .filter(|i| i.contract == id && req.as_ref().is_none_or(|r| r.matches(&i.version)))
            .collect())
    }

    fn fail_config(&mut self, msg: String) {
        self.config_valid = false;
        self.issues.push(
            Issue::new("invalid_config", Severity::Error, Tier::Request, msg).at(CONFIG_PATH),
        );
    }

    fn load_config(&mut self, src: &str) {
        let root = match crate::yaml::parse_value(src) {
            Ok(Some(Value::Map(m))) => m,
            Ok(_) => return self.fail_config("mdbase.yaml is not a mapping".into()),
            Err(e) => return self.fail_config(format!("mdbase.yaml does not parse: {e}")),
        };
        match root.get("spec_version") {
            Some(Value::Text(v)) if SUPPORTED_SPEC_VERSIONS.contains(&v.as_str()) => {
                self.spec_version = Some(v.clone());
            }
            Some(Value::Text(v)) => {
                self.spec_version = Some(v.clone());
                return self.fail_config(format!(
                    "unsupported spec_version `{v}`; this tool supports 0.3.0"
                ));
            }
            _ => return self.fail_config("`spec_version` is required".into()),
        }
        for (k, _) in root.iter() {
            if !matches!(k, "spec_version" | "settings") && !k.starts_with("x-") {
                self.issues.push(
                    Issue::new(
                        "unknown_config_key",
                        Severity::Warning,
                        Tier::Request,
                        format!("unknown config key `{k}`"),
                    )
                    .at(CONFIG_PATH),
                );
            }
        }
        let Some(settings) = root.get("settings") else {
            return;
        };
        let Value::Map(s) = settings else {
            return self.fail_config("`settings` is not a mapping".into());
        };
        for (k, v) in s.iter() {
            let ok = match k {
                "timezone" => {
                    if let Some(tz) = v.as_str().filter(|tz| is_plausible_iana_zone(tz)) {
                        self.settings.timezone = Some(tz.to_owned());
                    } else {
                        self.config_valid = false;
                        self.issues.push(
                            Issue::new(
                                "invalid_timezone",
                                Severity::Error,
                                Tier::Request,
                                "settings.timezone is not an IANA zone",
                            )
                            .at(CONFIG_PATH),
                        );
                    }
                    true
                }
                "types_folder" => set_folder(v, &mut self.settings.types_folder),
                "contracts_folder" => set_folder(v, &mut self.settings.contracts_folder),
                "record_extensions" => match string_list(v) {
                    Some(l) if !l.is_empty() => {
                        self.settings.record_extensions = l
                            .into_iter()
                            .map(|e| e.trim_start_matches('.').to_owned())
                            .collect();
                        true
                    }
                    _ => false,
                },
                "validation" | "default_validation" => match v.as_str().and_then(Level::parse) {
                    Some(l) => {
                        self.settings.validation = l;
                        true
                    }
                    None => false,
                },
                "explicit_type_keys" => match string_list(v) {
                    Some(l) => {
                        self.settings.explicit_type_keys = l;
                        true
                    }
                    None => false,
                },
                "id_field" => match v.as_str() {
                    Some(f) if !f.is_empty() => {
                        self.settings.id_field = Some(f.to_owned());
                        true
                    }
                    _ => false,
                },
                "exclude" => match string_list(v) {
                    Some(l) => {
                        let mut ok = true;
                        for g in &l {
                            match Glob::new(g) {
                                Ok(glob) => self.exclude.push(glob),
                                Err(_) => ok = false,
                            }
                        }
                        self.settings.exclude = l;
                        ok
                    }
                    None => false,
                },
                k if k.starts_with("x-") => true,
                _ => {
                    self.issues.push(
                        Issue::new(
                            "unknown_config_key",
                            Severity::Warning,
                            Tier::Request,
                            format!("unknown setting `{k}`"),
                        )
                        .at(CONFIG_PATH),
                    );
                    true
                }
            };
            if !ok {
                self.fail_config(format!("invalid value for settings.{k}"));
            }
        }
        if path_key(&self.settings.types_folder) == path_key(&self.settings.contracts_folder) {
            self.fail_config("types_folder and contracts_folder must differ".into());
        }
    }

    /// Whether the configuration loaded. False means writes are rejected with
    /// `collection_invalid`; reads still work.
    pub fn is_valid(&self) -> bool {
        self.config_valid
    }

    /// Settings with defaults applied.
    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// `spec_version` from `mdbase.yaml`, when present.
    pub fn spec_version(&self) -> Option<&str> {
        self.spec_version.as_deref()
    }

    /// Load diagnostics for the config and the type files.
    pub fn issues(&self) -> &[Issue] {
        &self.issues
    }

    /// The valid types, ordered by canonical lower-case name.
    pub fn types(&self) -> &[TypeDef] {
        &self.types
    }

    /// The type named `name` (case-insensitive).
    pub fn type_named(&self, name: &str) -> Option<&TypeDef> {
        let lower = name.to_lowercase();
        self.types
            .binary_search_by(|t| t.name.to_lowercase().cmp(&lower))
            .ok()
            .map(|i| &self.types[i])
    }

    /// Whether `path` is a resource: `mdbase.yaml`, both receipt locks, or any
    /// file in the types or contracts folder, a managed pack schema, or a
    /// schema resolved by a registered contract.
    pub fn is_resource_path(&self, path: &str) -> bool {
        path == CONFIG_PATH
            || path == LOCK_PATH
            || path == PROVISION_LOCK_PATH
            || self.schema_resources.contains(path)
            || [&self.settings.types_folder, &self.settings.contracts_folder]
                .iter()
                .any(|folder| {
                    path.strip_prefix(folder.as_str())
                        .and_then(|rest| rest.strip_prefix('/'))
                        .is_some_and(|rest| !rest.is_empty())
                })
    }

    /// Whether `path` is excluded from discovery (spec 02 built-in exclusions
    /// plus `settings.exclude`).
    pub fn is_excluded(&self, path: &str) -> bool {
        path.split('/')
            .any(|seg| seg.starts_with('.') || seg == "node_modules")
            || self.exclude.iter().any(|g| g.matches(path))
    }

    /// Whether `path` is a record path: a record extension, not a resource,
    /// not excluded.
    pub fn is_record_path(&self, path: &str) -> bool {
        !self.is_resource_path(path)
            && !self.is_excluded(path)
            && path.rsplit_once('.').is_some_and(|(stem, ext)| {
                !stem.is_empty()
                    && !stem.ends_with('/')
                    && self
                        .settings
                        .record_extensions
                        .iter()
                        .any(|e| e.eq_ignore_ascii_case(ext))
            })
    }

    /// Effective frontmatter (spec 07 "Read Defaults"): persisted values,
    /// then each matched type's `read_defaults` for missing keys (an explicit
    /// null stays null). The first type in matched order wins a disagreement;
    /// [`Membership`] reports it as `type_conflict`.
    pub fn effective_frontmatter(&self, types: &[String], frontmatter: &Map) -> Map {
        let mut out = frontmatter.clone();
        for t in types.iter().filter_map(|n| self.type_named(n)) {
            for (k, v) in t.read_defaults.iter() {
                if !out.contains_key(k) {
                    out.insert(k, v.clone());
                }
            }
        }
        out
    }

    /// Whether every one of `types` (at least one) declares `format:
    /// date-time` for the frontmatter location `location` (object keys, `"[]"`
    /// for an array item). CEL binds such strings as timestamps (spec 10
    /// "Temporal Values"; `cel::CelValue::from_value_typed`).
    pub fn is_date_time(&self, types: &[String], location: &[&str]) -> bool {
        let defs: Vec<&TypeDef> = types.iter().filter_map(|n| self.type_named(n)).collect();
        !defs.is_empty()
            && defs.iter().all(|t| {
                schema_at(&t.schema_document, &t.schema_entry, location)
                    .and_then(|s| s.get("format"))
                    .and_then(Value::as_str)
                    == Some("date-time")
            })
    }

    /// The types a record at `path` with persisted `frontmatter` matches
    /// (spec 07 "Matching Decision Process"), with no captured time: a
    /// `match.expr` calling `now()` or `today()` is an evaluation error and
    /// does not match. See [`Catalog::membership_at`].
    pub fn membership(&self, path: &str, frontmatter: &Map) -> Membership {
        self.membership_at(path, frontmatter, None)
    }

    /// [`Catalog::membership`] where `now()` and `today()` in `match.expr`
    /// read `clock` (spec 07: "evaluated ... with `now()` and `today()`
    /// reading the operation's captured instant").
    ///
    /// - The planner passes the mutation's clock, so a write and every
    ///   re-plan of it see the same membership.
    /// - Reads and queries pass the query's captured clock.
    /// - Index maintenance (`record_meta`) passes none: membership that
    ///   depends on time is reported (`nondeterministic_match`) and cannot be
    ///   indexed stably.
    pub fn membership_at(
        &self,
        path: &str,
        frontmatter: &Map,
        clock: Option<&OpClock>,
    ) -> Membership {
        let mut out = Membership::default();
        let keys: Vec<&String> = self
            .settings
            .explicit_type_keys
            .iter()
            .filter(|k| frontmatter.contains_key(k))
            .collect();
        if !keys.is_empty() {
            out.explicit = true;
            for key in keys {
                let names: Vec<&str> = match frontmatter.get(key) {
                    Some(Value::Text(s)) => vec![s.as_str()],
                    Some(Value::List(l))
                        if !l.is_empty() && l.iter().all(|v| v.as_str().is_some()) =>
                    {
                        l.iter().filter_map(Value::as_str).collect()
                    }
                    _ => {
                        out.issues.push(
                            Issue::new(
                                "invalid_type_declaration",
                                Severity::Error,
                                Tier::SingleRecord,
                                format!("`{key}` must be a type name or a non-empty list of names"),
                            )
                            .at(format!("/{key}")),
                        );
                        continue;
                    }
                };
                for n in names {
                    match self.type_named(n) {
                        Some(t) => {
                            if !out.types.iter().any(|x| x.eq_ignore_ascii_case(&t.name)) {
                                out.types.push(t.name.clone());
                            }
                        }
                        None => out.issues.push(
                            Issue::new(
                                "unknown_type",
                                Severity::Error,
                                Tier::SingleRecord,
                                format!("unknown type `{n}`"),
                            )
                            .at(format!("/{key}"))
                            .with_type(n),
                        ),
                    }
                }
            }
            return out;
        }
        // `types` is sorted by lower-case name, which is the inferred order.
        for t in &self.types {
            if t.matches_inferred(path, frontmatter, clock, &mut out.issues) {
                out.types.push(t.name.clone());
            }
        }
        out
    }
}

/// The merge reads strategies through this (spec 07 "Merge Strategies").
///
/// Membership is evaluated with no clock ([`Catalog::membership`]), so a type
/// whose `match.expr` calls `now()`/`today()` never contributes strategies
/// to a merge. That keeps merges replayable; such types already report
/// `nondeterministic_match` at load.
impl crate::merge::MergeTypes for Catalog {
    fn merge_facts(&self, path: &str, frontmatter: &Map) -> crate::merge::MergeFacts {
        let mut facts = crate::merge::MergeFacts::default();
        for name in self.membership(path, frontmatter).types {
            if let Some(t) = self.type_named(&name) {
                let declared: BTreeMap<String, crate::merge::MergeStrategy> = t
                    .merge
                    .iter()
                    .filter_map(|(f, s)| Some((f.clone(), crate::merge::MergeStrategy::parse(s)?)))
                    .collect();
                let unique: BTreeSet<String> =
                    t.schema.0.top_level_unique_items().into_iter().collect();
                facts.add_type(&declared, &t.time_fields(), &unique);
            }
        }
        facts
    }
}

/// The subschema for a frontmatter location, following `properties`,
/// `items` and local `$ref`s (bounded).
pub(crate) fn schema_at<'a>(doc: &'a Value, entry: &str, location: &[&str]) -> Option<&'a Value> {
    let deref = |mut s: &'a Value| {
        for _ in 0..16 {
            match s
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|r| r.strip_prefix('#'))
            {
                Some(ptr) => s = pointer(doc, ptr)?,
                None => return Some(s),
            }
        }
        None
    };
    let mut cur = deref(pointer(doc, entry)?)?;
    for seg in location {
        let next = if *seg == "[]" {
            cur.get("items")?
        } else {
            cur.get("properties")?.get(seg)?
        };
        cur = deref(next)?;
    }
    Some(cur)
}

/// Resolve a JSON Pointer (`""` = the whole value).
pub(crate) fn pointer_value<'a>(root: &'a Value, ptr: &str) -> Option<&'a Value> {
    pointer(root, ptr)
}

/// Resolve a JSON Pointer (`""` = the whole value).
fn pointer<'a>(root: &'a Value, ptr: &str) -> Option<&'a Value> {
    let mut cur = root;
    for tok in ptr.split('/').skip(1) {
        let tok = tok.replace("~1", "/").replace("~0", "~");
        cur = match cur {
            Value::Map(m) => m.get(&tok)?,
            Value::List(l) => l.get(tok.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn map<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn string_list(v: &Value) -> Option<Vec<String>> {
    v.as_list()?
        .iter()
        .map(|x| x.as_str().map(str::to_owned))
        .collect()
}

fn set_folder(v: &Value, slot: &mut String) -> bool {
    match v.as_str() {
        Some(f) => {
            let f = f.trim_matches('/');
            if f.is_empty() || f.split('/').any(|s| s == ".." || s == "." || s.is_empty()) {
                return false;
            }
            f.clone_into(slot);
            true
        }
        None => false,
    }
}

/// A conservative syntactic check of an IANA zone name: `UTC`, or
/// `Area/Location` segments of ASCII letters, digits, `_`, `-`, `+`. Numeric
/// offsets and `local` are rejected (spec 04). The tzdb itself is not consulted.
pub fn is_plausible_iana_zone(tz: &str) -> bool {
    if tz == "UTC" {
        return true;
    }
    let segs: Vec<&str> = tz.split('/').collect();
    segs.len() >= 2
        && segs.iter().all(|s| {
            s.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        })
}

/// The top-level field a field reference names, if it names exactly one
/// top-level field: `title`, or the one-token pointer `/a~1b` (`a/b`).
pub fn top_level_field(reference: &str) -> Option<String> {
    if let Some(pointer) = reference.strip_prefix('/') {
        if pointer.contains('/') {
            return None;
        }
        return Some(pointer.replace("~1", "/").replace("~0", "~"));
    }
    is_field_path_segment(reference).then(|| reference.to_owned())
}

fn is_field_path_segment(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '-'))
}

/// One step of a parsed field reference (spec 07).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldStep {
    /// An object key.
    Key(String),
    /// An array index (pointer form only).
    Index(u64),
    /// Every item of an array (`[]`, field-path form only).
    Each,
}

/// Parse a field reference. `None` when it is malformed.
pub fn parse_field_ref(reference: &str) -> Option<Vec<FieldStep>> {
    if let Some(pointer) = reference.strip_prefix('/') {
        return Some(
            pointer
                .split('/')
                .map(|tok| match tok.parse::<u64>() {
                    Ok(i) if tok == i.to_string() => FieldStep::Index(i),
                    _ => FieldStep::Key(tok.replace("~1", "/").replace("~0", "~")),
                })
                .collect(),
        );
    }
    let mut steps = Vec::new();
    for seg in reference.split('.') {
        let (name, each) = match seg.strip_suffix("[]") {
            Some(n) => (n, true),
            None => (seg, false),
        };
        if !is_field_path_segment(name) {
            return None;
        }
        steps.push(FieldStep::Key(name.to_owned()));
        if each {
            steps.push(FieldStep::Each);
        }
    }
    Some(steps)
}

/// Every value a field reference selects in `root`.
pub fn select<'a>(root: &'a Map, reference: &str) -> Vec<&'a Value> {
    let Some(steps) = parse_field_ref(reference) else {
        return Vec::new();
    };
    let mut cur: Vec<&Value> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        if i == 0 {
            // The first step always names a top-level key.
            let key = match step {
                FieldStep::Key(k) => k.clone(),
                FieldStep::Index(n) => n.to_string(),
                FieldStep::Each => return Vec::new(),
            };
            cur.extend(root.get(&key));
            continue;
        }
        let mut next = Vec::new();
        for v in cur {
            match (step, v) {
                (FieldStep::Key(k), Value::Map(m)) => next.extend(m.get(k)),
                (FieldStep::Index(n), Value::Map(m)) => next.extend(m.get(&n.to_string())),
                (FieldStep::Index(n), Value::List(l)) => {
                    next.extend(usize::try_from(*n).ok().and_then(|n| l.get(n)));
                }
                (FieldStep::Each, Value::List(l)) => next.extend(l.iter()),
                _ => {}
            }
        }
        cur = next;
    }
    cur
}

/// The single value a field reference selects, if exactly one.
pub fn select_one<'a>(root: &'a Map, reference: &str) -> Option<&'a Value> {
    let v = select(root, reference);
    (v.len() == 1).then(|| v[0])
}

fn where_matches(value: Option<&Value>, pred: &Value) -> bool {
    match pred {
        Value::Map(m) if !m.is_empty() && m.keys().all(is_where_operator) => {
            m.iter().all(|(op, operand)| where_op(value, op, operand))
        }
        direct => value.is_some_and(|v| v == direct),
    }
}

fn is_where_operator(k: &str) -> bool {
    matches!(
        k,
        "eq" | "neq"
            | "gt"
            | "gte"
            | "lt"
            | "lte"
            | "contains"
            | "containsAll"
            | "containsAny"
            | "startsWith"
            | "endsWith"
            | "matches"
            | "exists"
    )
}

fn where_op(value: Option<&Value>, op: &str, operand: &Value) -> bool {
    if op == "exists" {
        return operand.as_bool() == Some(value.is_some());
    }
    let Some(v) = value.filter(|v| !v.is_null()) else {
        return false;
    };
    match op {
        "eq" => v == operand,
        "neq" => v != operand,
        "gt" | "gte" | "lt" | "lte" => {
            let ord = match (v, operand) {
                (Value::Text(a), Value::Text(b)) => Some(a.cmp(b)),
                _ => match (v.as_number(), operand.as_number()) {
                    (Some(a), Some(b)) => Some(a.cmp_numeric(b)),
                    _ => None,
                },
            };
            ord.is_some_and(|o| match op {
                "gt" => o.is_gt(),
                "gte" => o.is_ge(),
                "lt" => o.is_lt(),
                _ => o.is_le(),
            })
        }
        "contains" => match (v, operand) {
            (Value::Text(s), Value::Text(sub)) => s.contains(sub.as_str()),
            (Value::List(l), x) => l.iter().any(|i| i == x),
            _ => false,
        },
        "containsAll" | "containsAny" => match (v, operand) {
            (Value::List(l), Value::List(want)) if op == "containsAll" => {
                want.iter().all(|w| l.contains(w))
            }
            (Value::List(l), Value::List(want)) => want.iter().any(|w| l.contains(w)),
            _ => false,
        },
        "startsWith" => {
            matches!((v, operand), (Value::Text(s), Value::Text(p)) if s.starts_with(p.as_str()))
        }
        "endsWith" => {
            matches!((v, operand), (Value::Text(s), Value::Text(p)) if s.ends_with(p.as_str()))
        }
        "matches" => match (v, operand) {
            // Patterns are checked when the type loads, so an error here
            // cannot happen; it would count as a non-match.
            (Value::Text(s), Value::Text(p)) => crate::regex::is_match(p, s).unwrap_or(false),
            _ => false,
        },
        _ => false,
    }
}

const TYPE_KEYS: &[&str] = &[
    "kind",
    "name",
    "version",
    "description",
    "match",
    "schema",
    "collection",
    "lifecycle",
    "implements",
];

fn invalid_type(issues: &mut Vec<Issue>, path: &str, name: Option<&str>, msg: String) {
    let mut i = Issue::new("invalid_type", Severity::Error, Tier::Request, msg).at(path);
    if let Some(n) = name {
        i = i.with_type(n);
    }
    issues.push(i);
}

fn load_type(
    path: &str,
    src: &str,
    resources: &BTreeMap<&str, &str>,
    issues: &mut Vec<Issue>,
) -> Option<TypeDef> {
    let doc = Document::parse(src, RecordFormat::Markdown);
    if doc.problem().is_some() || !doc.has_frontmatter() {
        invalid_type(
            issues,
            path,
            None,
            "type file frontmatter is missing or invalid".into(),
        );
        return None;
    }
    let fm = doc.frontmatter();
    if fm.get("kind").and_then(Value::as_str) != Some("mdbase.type") {
        invalid_type(
            issues,
            path,
            None,
            "not a type definition (`kind: mdbase.type`)".into(),
        );
        return None;
    }
    let Some(name) = fm
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
    else {
        invalid_type(issues, path, None, "`name` is required".into());
        return None;
    };
    if let Some(src) = fm.get("match").and_then(|m| m.get("expr")).and_then(|e| {
        e.as_str()
            .or_else(|| e.get("$expr").and_then(Value::as_str))
    }) && let Ok(program) = crate::cel::compile(src)
    {
        for binding in program.references().nondeterministic() {
            issues.push(
                Issue::new(
                    "nondeterministic_match",
                    Severity::Warning,
                    Tier::Request,
                    format!(
                        "`match.expr` of type `{name}` uses `{binding}`; membership can differ between replays"
                    ),
                )
                .at(path)
                .with_type(name)
                .with_details(map([("binding", Value::string(binding))])),
            );
        }
    }
    match parse_type_body(path, name, fm, resources) {
        Ok(t) => Some(t),
        Err((code, msg)) => {
            issues.push(
                Issue::new(code, Severity::Error, Tier::Request, msg)
                    .at(path)
                    .with_type(name),
            );
            None
        }
    }
}

type LoadErr = (&'static str, String);

fn bad(msg: impl Into<String>) -> LoadErr {
    ("invalid_type", msg.into())
}

fn parse_type_body(
    path: &str,
    name: &str,
    fm: &Map,
    resources: &BTreeMap<&str, &str>,
) -> Result<TypeDef, LoadErr> {
    if let Some(k) = fm
        .keys()
        .find(|k| !TYPE_KEYS.contains(k) && !k.starts_with("x-"))
    {
        return Err(bad(format!("unknown type-file section `{k}`")));
    }
    let version = match fm.get("version") {
        None => None,
        Some(v) => Some(
            v.as_number()
                .and_then(crate::value::Number::as_i64)
                .ok_or_else(|| bad("`version` must be an integer"))?,
        ),
    };
    let Some(Value::Map(schema)) = fm.get("schema") else {
        return Err(bad("`schema` is required"));
    };
    if schema.get("dialect").and_then(Value::as_str) != Some("json-schema-2020-12") {
        return Err(bad("`schema.dialect` must be json-schema-2020-12"));
    }
    let (schema_document, schema_entry) = match (schema.get("value"), schema.get("ref")) {
        (Some(v), None) => (v.clone(), String::new()),
        (None, Some(Value::Text(r))) => resolve_schema_ref(path, r, resources)?,
        _ => {
            return Err(bad(
                "exactly one of `schema.value` and `schema.ref` is required",
            ));
        }
    };
    // A `schema.ref` fragment names a schema whose own fragment refs may be
    // relative to it; try the document root first, then the fragment as a
    // document of its own.
    let compiled =
        match crate::jsonschema::compile(&schema_document, &schema_entry).or_else(
            |e| match pointer(&schema_document, &schema_entry) {
                Some(sub) if !schema_entry.is_empty() => crate::jsonschema::compile(sub, ""),
                _ => Err(e),
            },
        ) {
            Ok(c) => SchemaHandle(std::sync::Arc::new(c)),
            Err(errs) => {
                let first = &errs[0];
                return Err((
                    first.code,
                    format!("{} (at {})", first.message, first.location),
                ));
            }
        };
    let match_spec = match fm.get("match") {
        None => None,
        Some(Value::Map(m)) => Some(parse_match(m).map_err(|e| {
            if let Some(rest) = e.strip_prefix("invalid_pattern: ") {
                ("invalid_pattern", rest.to_owned())
            } else if let Some(rest) = e.strip_prefix("expression_compile_error: ") {
                ("expression_compile_error", rest.to_owned())
            } else {
                bad(e)
            }
        })?),
        Some(_) => return Err(bad("`match` must be a mapping")),
    };
    let empty = Map::new();
    let coll = match fm.get("collection") {
        None => &empty,
        Some(Value::Map(m)) => m,
        Some(_) => return Err(bad("`collection` must be a mapping")),
    };
    let mut merge = BTreeMap::new();
    if let Some(Value::Map(m)) = coll.get("merge") {
        for (k, v) in m.iter() {
            match (top_level_field(k), v.as_str()) {
                (Some(f), Some(s @ ("conflict" | "max" | "min" | "union"))) => {
                    merge.insert(f, s.to_owned());
                }
                _ => return Err(bad(format!("invalid `collection.merge` entry `{k}`"))),
            }
        }
    }
    let mut unique = Vec::new();
    if let Some(v) = coll.get("unique") {
        let rules = v
            .as_list()
            .ok_or_else(|| bad("`collection.unique` must be a list"))?;
        for r in rules {
            unique.push(parse_unique(r).ok_or_else(|| bad("invalid `collection.unique` rule"))?);
        }
    }
    let mut link_fields = BTreeMap::new();
    if let Some(Value::Map(m)) = coll.get("links") {
        for (k, v) in m.iter() {
            link_fields.insert(
                k.to_owned(),
                LinkField {
                    target_type: v
                        .get("target_type")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    validate_exists: v
                        .get("validate_exists")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                },
            );
        }
    }
    let read_defaults = match coll.get("read_defaults") {
        Some(Value::Map(m)) => m.clone(),
        _ => Map::new(),
    };
    let path_pattern = coll
        .get("path")
        .and_then(|p| p.get("pattern"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut lifecycle = BTreeMap::new();
    if let Some(l) = fm.get("lifecycle") {
        let Value::Map(l) = l else {
            return Err(bad("`lifecycle` must be a mapping"));
        };
        for (key, event) in [
            ("on_create", LifecycleEvent::Create),
            ("on_update", LifecycleEvent::Update),
        ] {
            if let Some(v) = l.get(key) {
                let actions =
                    parse_actions(v).ok_or_else(|| bad(format!("invalid `lifecycle.{key}`")))?;
                lifecycle.insert(event, actions);
            }
        }
    }
    Ok(TypeDef {
        name: name.to_owned(),
        source_path: path.to_owned(),
        version,
        match_spec,
        schema_document,
        schema_entry,
        schema: compiled,
        merge,
        unique,
        link_fields,
        read_defaults,
        path_pattern,
        lifecycle,
        raw: fm.clone(),
    })
}

/// Resolve `schema.ref` relative to the type file's folder. The target must be
/// a resource inside the collection; JSON (or YAML).
fn schema_ref_target(type_path: &str, reference: &str) -> Result<(String, String), LoadErr> {
    let (file, fragment) = match reference.split_once('#') {
        Some((f, frag)) => (f, frag.to_owned()),
        None => (reference, String::new()),
    };
    if file.contains("://") {
        return Err((
            "schema_ref_forbidden",
            format!("network schema reference `{reference}`"),
        ));
    }
    let dir = type_path.rsplit_once('/').map_or("", |(d, _)| d);
    let joined = if let Some(rooted) = file.strip_prefix('/') {
        rooted.to_owned()
    } else if dir.is_empty() {
        file.to_owned()
    } else {
        format!("{dir}/{file}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err((
                        "schema_ref_forbidden",
                        format!("`{reference}` escapes the collection"),
                    ));
                }
            }
            s => parts.push(s),
        }
    }
    Ok((parts.join("/"), fragment))
}

pub(crate) fn resolve_schema_ref(
    type_path: &str,
    reference: &str,
    resources: &BTreeMap<&str, &str>,
) -> Result<(Value, String), LoadErr> {
    let (target, fragment) = schema_ref_target(type_path, reference)?;
    let Some(src) = resources.get(target.as_str()) else {
        return Err(("schema_ref_unresolved", format!("`{reference}` not found")));
    };
    match crate::yaml::parse_value(src) {
        Ok(Some(v)) => Ok((v, fragment)),
        _ => Err((
            "schema_ref_unresolved",
            format!("`{target}` is not a JSON or YAML document"),
        )),
    }
}

fn parse_match(m: &Map) -> Result<MatchSpec, String> {
    let mut out = MatchSpec::default();
    for (k, v) in m.iter() {
        match k {
            "path_glob" => {
                let globs: Vec<String> = match v {
                    Value::Text(s) => vec![s.clone()],
                    other => {
                        string_list(other).ok_or("`match.path_glob` must be a glob or a list")?
                    }
                };
                for g in globs {
                    out.path_globs
                        .push(Glob::new(&g).map_err(|e| format!("invalid glob `{g}`: {}", e.0))?);
                }
            }
            "fields_present" => {
                out.fields_present =
                    string_list(v).ok_or("`match.fields_present` must be a list")?;
                if out
                    .fields_present
                    .iter()
                    .any(|f| parse_field_ref(f).is_none())
                {
                    return Err("invalid field reference in `match.fields_present`".into());
                }
            }
            "where" => {
                let Value::Map(w) = v else {
                    return Err("`match.where` must be a mapping".into());
                };
                out.where_ = w.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect();
                for (_, pred) in &out.where_ {
                    if let Some(Value::Text(p)) = pred.get("matches")
                        && let Err(e) = crate::regex::Pattern::new(p)
                    {
                        return Err(format!("invalid_pattern: `{p}`: {e:?}"));
                    }
                }
            }
            "expr" => {
                let src = match v {
                    Value::Text(s) => s.clone(),
                    Value::Map(e) => e
                        .get("$expr")
                        .and_then(Value::as_str)
                        .ok_or("`match.expr` must be a CEL string or {$expr}")?
                        .to_owned(),
                    _ => return Err("`match.expr` must be a CEL string".into()),
                };
                let program = crate::cel::compile(&src)
                    .map_err(|e| format!("expression_compile_error: `match.expr`: {e}"))?;
                out.program = Some(CelProgram(std::sync::Arc::new(program)));
                out.expr = Some(src);
            }
            k if k.starts_with("x-") => {}
            other => return Err(format!("unknown `match` member `{other}`")),
        }
    }
    Ok(out)
}

fn parse_unique(r: &Value) -> Option<UniqueRule> {
    let field = r.get("field")?.as_str()?.to_owned();
    parse_field_ref(&field)?;
    let enforce = match r.get("enforce").map(Value::as_str) {
        None | Some(Some("report")) => Enforce::Report,
        Some(Some("write")) => Enforce::Write,
        _ => return None,
    };
    let scope = match r.get("scope").map(Value::as_str) {
        None | Some(Some("type")) => UniqueScope::Type,
        Some(Some("collection")) => UniqueScope::Collection,
        Some(Some("path_glob")) => {
            UniqueScope::PathGlob(Glob::new(r.get("path_glob")?.as_str()?).ok()?)
        }
        _ => return None,
    };
    Some(UniqueRule {
        field,
        enforce,
        scope,
    })
}

fn parse_actions(v: &Value) -> Option<Vec<LifecycleAction>> {
    let items: Vec<&Value> = match v {
        Value::List(l) if !l.is_empty() => l.iter().collect(),
        Value::Map(_) => vec![v],
        _ => return None,
    };
    items
        .into_iter()
        .map(|a| {
            let guard = match a.get("if") {
                None => None,
                Some(Value::Text(s)) => Some(s.clone()),
                Some(Value::Map(e)) => Some(e.get("$expr")?.as_str()?.to_owned()),
                Some(_) => return None,
            };
            if let Some(g) = &guard {
                crate::cel::compile(g).ok()?;
            }
            let Value::Map(set) = a.get("set")? else {
                return None;
            };
            let set = set
                .iter()
                .map(|(k, p)| {
                    parse_field_ref(k)?;
                    Some((k.to_owned(), parse_provider(p)?))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(LifecycleAction { guard, set })
        })
        .collect()
}

fn parse_provider(p: &Value) -> Option<Provider> {
    let Value::Map(m) = p else {
        return None;
    };
    if m.len() != 1 {
        return None;
    }
    let (k, v) = m.iter().next()?;
    Some(match (k, v) {
        ("now", Value::Bool(true)) => Provider::Now,
        ("today", Value::Bool(true)) => Provider::Today,
        ("uuid", Value::Bool(true)) => Provider::Uuid,
        ("ulid", Value::Bool(true)) => Provider::Ulid,
        ("slugify", Value::Text(f)) => Provider::Slugify(f.clone()),
        ("copy", Value::Text(f)) => Provider::Copy(f.clone()),
        ("literal", v) => Provider::Literal(v.clone()),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(files: &[(&str, &str)]) -> Catalog {
        Catalog::load(files.iter().copied())
    }

    const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: \"tasks/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\nlifecycle:\n  on_update:\n    set:\n      dateModified: {now: true}\n---\n";
    const NOTE: &str = "---\nkind: mdbase.type\nname: Note\nmatch:\n  where:\n    tags: {contains: note}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";

    fn fm(src: &str) -> Map {
        match crate::yaml::parse_value(src).unwrap() {
            Some(Value::Map(m)) => m,
            _ => Map::new(),
        }
    }

    #[test]
    fn loads_settings_and_types() {
        let c = cat(&[
            (
                "mdbase.yaml",
                "spec_version: \"0.3.0\"\nsettings:\n  id_field: id\n  explicit_type_keys: []\n",
            ),
            ("_types/task.md", TASK),
            ("_types/note.md", NOTE),
        ]);
        assert!(c.is_valid(), "{:?}", c.issues());
        assert_eq!(c.settings().id_field.as_deref(), Some("id"));
        let names: Vec<&str> = c.types().iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Note", "task"]);
        assert_eq!(
            c.type_named("task")
                .unwrap()
                .time_fields()
                .into_iter()
                .collect::<Vec<_>>(),
            ["dateModified"]
        );
        let m = c.membership("tasks/a.md", &fm("tags: [note]\ntype: task\n"));
        assert_eq!(m.types, ["Note", "task"]);
        assert!(!m.explicit);
    }

    #[test]
    fn explicit_membership_wins() {
        let c = cat(&[("_types/task.md", TASK), ("_types/note.md", NOTE)]);
        let m = c.membership("tasks/a.md", &fm("type: note\n"));
        assert_eq!(m.types, ["Note"]);
        assert!(m.explicit);
        let m = c.membership("x.md", &fm("types: [ghost]\n"));
        assert!(m.types.is_empty());
        assert_eq!(m.issues[0].code, "unknown_type");
    }

    #[test]
    fn invalid_config_and_types() {
        let c = cat(&[("mdbase.yaml", "spec_version: \"0.2.0\"\n")]);
        assert!(!c.is_valid());
        let upper = TASK.replace("name: task", "name: TASK");
        let c = cat(&[
            ("_types/bad.md", "---\nkind: mdbase.type\nname: bad\n---\n"),
            ("_types/t.md", TASK),
            ("_types/t2.md", &upper),
        ]);
        assert!(c.types().is_empty());
        let codes: Vec<&str> = c.issues().iter().map(|i| i.code.as_str()).collect();
        assert_eq!(codes, ["invalid_type", "type_conflict"]);
    }

    #[test]
    fn schema_ref_resolves_relative_to_type_file() {
        let t = "---\nkind: mdbase.type\nname: r\nschema:\n  dialect: json-schema-2020-12\n  ref: ./r.schema.json#/$defs/r\n---\n";
        let c = cat(&[
            ("_types/r.md", t),
            (
                "_types/r.schema.json",
                "{\"$defs\": {\"r\": {\"type\": \"object\"}}}",
            ),
        ]);
        let r = c.type_named("r").unwrap();
        assert_eq!(r.schema_entry, "/$defs/r");
        assert!(r.schema_document.get("$defs").is_some());
    }

    #[test]
    fn match_expr_reads_the_captured_clock() {
        let t = "---\nkind: mdbase.type\nname: overdue\nmatch:\n  expr: 'has(raw.due) && raw.due < today()'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
        let c = cat(&[("_types/overdue.md", t)]);
        let rec = fm("due: \"2026-01-01\"\n");
        let at = |date: &str| OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: date.into(),
        };
        // No clock: an evaluation error, reported, and no match.
        let m = c.membership("a.md", &rec);
        assert!(m.types.is_empty());
        assert_eq!(m.issues[0].code, "expression_evaluation_error");
        assert_eq!(
            c.membership_at("a.md", &rec, Some(&at("2026-01-02"))).types,
            ["overdue"]
        );
        assert!(
            c.membership_at("a.md", &rec, Some(&at("2025-12-31")))
                .types
                .is_empty()
        );
        assert_eq!(c.issues()[0].code, "nondeterministic_match");
    }

    #[test]
    fn field_refs() {
        let m = fm("a: {b: [1, 2]}\n\"@type\": X\n");
        assert_eq!(select(&m, "a.b[]").len(), 2);
        assert_eq!(select_one(&m, "/a/b/1"), Some(&Value::Int(2)));
        assert_eq!(select_one(&m, "/@type"), Some(&Value::string("X")));
        assert!(parse_field_ref("1abc").is_none());
    }

    #[test]
    fn exclusions() {
        let c = cat(&[(
            "mdbase.yaml",
            "spec_version: \"0.3.0\"\nsettings:\n  exclude: [\"drafts/**\", \"archive/*.md\"]\n",
        )]);
        assert!(c.is_record_path("notes/a.md"));
        assert!(!c.is_record_path(".obsidian/a.md"));
        assert!(!c.is_record_path("notes/.hidden.md"));
        assert!(!c.is_record_path("node_modules/p/readme.md"));
        assert!(!c.is_record_path("drafts/x.md"));
        assert!(!c.is_record_path("archive/old.md"));
        assert!(c.is_record_path("archive/2025/older.md"));
        assert!(!c.is_record_path("_types/task.md"));
    }
}
