//! Record data commands: `read`, `query`, `validate`, `types`.
//!
//! Each command is built once, as replica client requests
//! (`replica-client-api.md`), and sent over a [`Transport`]. A folder registered
//! with this profile's daemon goes through a host session on the daemon's replica
//! endpoint. Any other folder is opened in process as a library host
//! ([`mdbn_local_host::open_folder`]) and driven through the same frame layer the
//! daemon serves. A registered folder is never opened in process, even when the
//! daemon is stopped: the library would mint record IDs that differ from the
//! daemon's. See `docs/cli-data-commands.md`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Subcommand};
use mdbn_local_host::{FolderError, FolderOptions, HostKind, OpenFolder};
use mdbn_replica::api::{SessionAuth, SessionId};
use mdbn_replica::frames::Frames;
use mdbn_wire::Wire;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientRequest, ClientResponse, HelloParams, Include, Issue, Problem, QueryResult,
    RecordView, Severity,
};
use mdbn_wire::common::{DataMap, Value as WireValue, Version};
use serde_json::{Map, Value, json};

use crate::client::ClientError;
use crate::control::{CollectionState, CollectionStatus, ControlError};
use crate::ipc::BoxStream;
use crate::paths::Profile;
use crate::registry::Registry;
use crate::secrets::{self, hex, uuid_string};
use crate::session::{ClientSession, Prologue};

/// The client name this CLI reports in `hello`.
const CLIENT_NAME: &str = "mdbase-cli";

/// How long one request may take on the daemon route (a full `validate` of a
/// large collection is the slowest).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to wait for a collection the daemon is still opening.
const OPENING_TIMEOUT: Duration = Duration::from_secs(30);

/// Which collection a data command works on.
#[derive(Debug, Args)]
pub(crate) struct Target {
    /// The collection folder (default: the current directory).
    #[arg(short = 'C', long, value_name = "PATH")]
    root: Option<PathBuf>,
    /// A collection registered with the daemon: ID, ID prefix or name.
    #[arg(short = 'c', long, value_name = "COLLECTION", conflicts_with = "root")]
    collection: Option<String>,
}

/// The data commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DataCmd {
    /// Print a record's file (`--json`: the record).
    Read {
        #[command(flatten)]
        target: Target,
        /// Record path, relative to the collection root.
        path: String,
    },
    /// Find records. Prints one path per line (`--json`: the query result).
    Query {
        #[command(flatten)]
        target: Target,
        /// Only records of these types (comma-separated).
        #[arg(long, value_delimiter = ',')]
        types: Vec<String>,
        /// A filter expression, for example `status == "open"`.
        #[arg(long = "where", value_name = "EXPR")]
        filter: Option<String>,
        /// Sort fields, comma-separated; prefix `-` for descending.
        #[arg(long, value_delimiter = ',', allow_hyphen_values = true)]
        order_by: Vec<String>,
        /// At most this many records.
        #[arg(long)]
        limit: Option<u64>,
        /// Skip this many records.
        #[arg(long)]
        offset: Option<u64>,
        /// Include record bodies (with `--json`).
        #[arg(long)]
        include_body: bool,
        /// A whole query object as JSON, from a file or `-` for stdin.
        #[arg(
            long,
            value_name = "FILE",
            conflicts_with_all = ["types", "filter", "order_by", "limit", "offset"]
        )]
        request: Option<PathBuf>,
    },
    /// Check records against their types. Exits 1 when any issue is an error.
    Validate {
        #[command(flatten)]
        target: Target,
        /// Only these records (default: all).
        paths: Vec<String>,
    },
    /// The collection's types.
    #[command(subcommand)]
    Types(TypesCmd),
}

/// `types` subcommands.
#[derive(Debug, Subcommand)]
pub(crate) enum TypesCmd {
    /// List the types.
    List {
        #[command(flatten)]
        target: Target,
    },
    /// Show one type's definition and resolved schema.
    Show {
        #[command(flatten)]
        target: Target,
        /// Type name.
        name: String,
    },
}

/// Run a data command. Errors are rendered by the caller.
pub(crate) async fn run(
    cmd: DataCmd,
    profile: &Profile,
    json: bool,
) -> Result<ExitCode, ClientError> {
    match cmd {
        DataCmd::Read { target, path } => {
            let mut t = open(&target, profile).await?;
            let view: RecordView = decode(
                &t.call(
                    Method::Get,
                    params(vec![Cbor::Text(path), include(true, true, true).to_cbor()]),
                )
                .await?,
            )?;
            if json {
                print_json(&record_json(&view));
            } else {
                print!("{}", view.document.as_deref().unwrap_or_default());
            }
            Ok(ExitCode::SUCCESS)
        }
        DataCmd::Query {
            target,
            types,
            filter,
            order_by,
            limit,
            offset,
            include_body,
            request,
        } => {
            let query = match request {
                Some(file) => read_json(&file)?,
                None => query_json(types, filter, &order_by, limit, offset),
            };
            let mut t = open(&target, profile).await?;
            let result: QueryResult = decode(
                &t.call(
                    Method::Query,
                    params(vec![
                        to_wire(&query).to_cbor(),
                        include(include_body, false, false).to_cbor(),
                    ]),
                )
                .await?,
            )?;
            if json {
                print_json(&query_result_json(&result));
            } else {
                for r in &result.records {
                    println!("{}", r.path);
                }
                if result.has_more == Some(true) || result.cursor.is_some() {
                    let next = query["offset"].as_u64().unwrap_or(0) + result.records.len() as u64;
                    eprintln!("more records match; continue with --offset {next}");
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        DataCmd::Validate { target, paths } => {
            let mut t = open(&target, profile).await?;
            let targets = if paths.is_empty() {
                Cbor::Null
            } else {
                Cbor::Array(paths.into_iter().map(Cbor::Text).collect())
            };
            let result = t.call(Method::Validate, params(vec![targets])).await?;
            let records = validation(&result)?;
            let errors = records
                .iter()
                .flat_map(|r| &r.issues)
                .any(|i| i.severity == Severity::Error);
            if json {
                print_json(&Value::Array(
                    records.iter().map(ValidatedRecord::to_json).collect(),
                ));
            } else {
                print_validation(&records);
            }
            Ok(if errors {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            })
        }
        DataCmd::Types(TypesCmd::List { target }) => {
            let mut t = open(&target, profile).await?;
            let result = t
                .call(Method::Describe, params(vec![Cbor::Bool(false)]))
                .await?;
            let types = types(&result)?;
            if json {
                print_json(&Value::Array(
                    types.iter().map(TypeSummary::to_json).collect(),
                ));
            } else {
                for ty in &types {
                    println!("{}\t{}", ty.name, ty.path);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        DataCmd::Types(TypesCmd::Show { target, name }) => {
            let mut t = open(&target, profile).await?;
            let result = t
                .call(Method::Describe, params(vec![Cbor::Bool(true)]))
                .await?;
            let ty = types(&result)?
                .into_iter()
                .find(|ty| ty.name == name)
                .ok_or_else(|| ControlError::not_found(format!("no type named {name}")))?;
            print_json(&ty.to_json());
            Ok(ExitCode::SUCCESS)
        }
    }
}

// ---- transport ---------------------------------------------------------------

/// The replica methods data commands send. A host session has owner power, so the
/// transport takes only these: device approval and the other host-only methods
/// cannot be reached from a data command.
#[derive(Debug, Clone, Copy)]
enum Method {
    Get,
    Query,
    Validate,
    Describe,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Method::Get => "get",
            Method::Query => "query",
            Method::Validate => "validate",
            Method::Describe => "describe",
        }
    }
}

/// Where requests go.
enum Transport {
    /// A host session on the daemon's replica endpoint.
    Daemon {
        session: ClientSession<BoxStream>,
        next_id: u64,
    },
    /// The folder, opened by this process.
    InProcess {
        folder: Box<OpenFolder>,
        frames: Frames,
        session: SessionId,
        next_id: u64,
    },
}

impl Transport {
    /// One request, answered.
    async fn call(&mut self, method: Method, params: Cbor) -> Result<Cbor, ClientError> {
        let request = ClientRequest {
            id: 0,
            method: method.name().into(),
            params,
        };
        let response = match self {
            Transport::Daemon { session, next_id } => {
                *next_id += 1;
                let id = *next_id;
                let request = ClientFrame::Request(ClientRequest { id, ..request });
                session.send(&request).await.map_err(session_error)?;
                tokio::time::timeout(REQUEST_TIMEOUT, async {
                    loop {
                        match session.recv().await.map_err(session_error)? {
                            Some(ClientFrame::Response(r)) if r.id == id => return Ok(r),
                            Some(_) => continue,
                            None => {
                                return Err(ClientError::Protocol(
                                    "the daemon closed the session".into(),
                                ));
                            }
                        }
                    }
                })
                .await
                .map_err(|_| ClientError::Timeout)??
            }
            Transport::InProcess {
                folder,
                frames,
                session,
                next_id,
            } => {
                *next_id += 1;
                let id = *next_id;
                let bytes = encode(ClientFrame::Request(ClientRequest { id, ..request }))?;
                let api = folder.replica.replica();
                frames.on_frame(api, *session, &bytes);
                frames.pump(api);
                frames
                    .take_outgoing()
                    .into_iter()
                    .find_map(|(_, out)| match decode_frame(&out) {
                        Ok(ClientFrame::Response(r)) if r.id == id => Some(Ok(r)),
                        Ok(_) => None,
                        Err(e) => Some(Err(e)),
                    })
                    .ok_or_else(|| {
                        ControlError::internal(format!("{} was not answered", method.name()))
                    })??
            }
        };
        match response {
            ClientResponse {
                problem: Some(p), ..
            } => Err(problem(&p).into()),
            ClientResponse { result, .. } => Ok(result.unwrap_or(Cbor::Null)),
        }
    }
}

fn hello() -> ClientRequest {
    ClientRequest {
        id: 0,
        method: "hello".into(),
        params: HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: CLIENT_NAME.into(),
            client_version: crate::BINARY_VERSION.into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    }
}

/// Resolve the target and open a session on it.
async fn open(target: &Target, profile: &Profile) -> Result<Transport, ClientError> {
    if let Some(arg) = &target.collection {
        let list = crate::cli::collections(profile).await?;
        let status = crate::cli::pick(&list, arg)?.clone();
        return daemon(profile, status).await;
    }
    let root = match &target.root {
        Some(r) => r.clone(),
        None => std::env::current_dir()
            .map_err(|e| ControlError::internal(format!("current directory: {e}")))?,
    };
    let root = std::fs::canonicalize(&root)
        .map_err(|e| ControlError::not_found(format!("{}: {e}", root.display())))?;
    let registry = Registry::load(&profile.registry_file())
        .map_err(|e| ControlError::internal(format!("collection registry: {e}")))?;
    if let Some(entry) = registry
        .collections
        .iter()
        .find(|e| root.starts_with(&e.root))
    {
        let list = crate::cli::collections(profile).await?;
        let status = list
            .into_iter()
            .find(|c| c.id == entry.id)
            .ok_or_else(|| ControlError::not_found("the daemon does not list this collection"))?;
        return daemon(profile, status).await;
    }
    if let Some(entry) = registry
        .collections
        .iter()
        .find(|e| e.root.starts_with(&root))
    {
        return Err(ControlError::invalid(
            "contains_collection",
            format!(
                "{} contains the registered collection \"{}\"; use -C {}",
                root.display(),
                entry.name,
                entry.root.display()
            ),
        )
        .into());
    }
    in_process(&root)
}

/// A host session on the daemon's replica endpoint, once the collection is ready.
async fn daemon(profile: &Profile, mut status: CollectionStatus) -> Result<Transport, ClientError> {
    let deadline = tokio::time::Instant::now() + OPENING_TIMEOUT;
    while status.state == CollectionState::Opening && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let list = crate::cli::collections(profile).await?;
        status = crate::cli::pick(&list, &status.id)?.clone();
    }
    if status.state != CollectionState::Ready {
        return Err(not_ready(&status).into());
    }
    let collection = crate::attest::uuid_bytes(&status.id)
        .ok_or_else(|| ControlError::internal("the daemon listed an invalid collection ID"))?;
    let store = secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
    let control_key = secrets::read_control_key(store.as_ref())
        .map_err(|e| ControlError::internal(format!("keychain: {e}")))?
        .ok_or_else(|| ControlError::internal("no host key in the keychain"))?;
    let identity = secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file())
        .map_err(|e| ControlError::internal(e.to_string()))?;
    let daemon_pk: [u8; 32] = secrets::hex_decode(&identity.noise_pk)
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| ControlError::internal("the daemon identity has an invalid key"))?;
    let device = crate::attest::uuid_bytes(&identity.device)
        .ok_or_else(|| ControlError::internal("the daemon identity has an invalid device ID"))?;
    let stream = crate::ipc::connect(&profile.replica)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
                ClientError::NotRunning
            }
            _ => ClientError::Io(e),
        })?;
    let (session, response) = ClientSession::connect(
        stream,
        &secrets::host_noise_secret(&control_key),
        &daemon_pk,
        Prologue {
            collection,
            grant: [0; 16],
            target: device,
        },
        hello(),
    )
    .await
    .map_err(session_error)?;
    if let Some(p) = response.problem {
        return Err(problem(&p).into());
    }
    Ok(Transport::Daemon {
        session,
        next_id: 0,
    })
}

/// Why the daemon is not serving a collection, with what to do about it.
fn not_ready(status: &CollectionStatus) -> ControlError {
    let name = &status.name;
    let message = match (status.state, status.reason.as_deref()) {
        (_, Some("account_identity_missing")) => format!(
            "\"{name}\" is not available until this computer is signed in to the account \
             that registered it; sign in with `mdbase account sign-in`"
        ),
        (CollectionState::Paused, _) => {
            format!("\"{name}\" is paused; resume it with `mdbase collection resume {name}`")
        }
        (CollectionState::Opening, _) => format!("\"{name}\" is still opening; try again shortly"),
        (state, reason) => format!(
            "the daemon is not serving \"{name}\" ({})",
            reason.map_or_else(|| format!("{state:?}").to_lowercase(), str::to_string)
        ),
    };
    ControlError::unavailable(
        status.reason.as_deref().unwrap_or("collection_unavailable"),
        message,
    )
}

/// Open `root` in process and start a host session on it.
fn in_process(root: &Path) -> Result<Transport, ClientError> {
    let mut folder = mdbn_local_host::open_folder(
        root,
        &FolderOptions {
            state_dir: None,
            desktop: true,
            timezone: None,
            take_over: false,
            client: (CLIENT_NAME.into(), crate::BINARY_VERSION.into()),
        },
    )
    .map_err(folder_error)?;
    let mut frames = Frames::new();
    let outcome = frames.hello(
        folder.replica.replica(),
        SessionAuth::Host,
        &encode(ClientFrame::Request(hello()))?,
    );
    let Some(session) = outcome.session else {
        return Err(hello_refused(&outcome.response).into());
    };
    Ok(Transport::InProcess {
        folder: Box::new(folder),
        frames,
        session,
        next_id: 0,
    })
}

fn folder_error(e: FolderError) -> ControlError {
    match e {
        FolderError::NotACollection { root } => ControlError::new(
            "collection_invalid",
            "not_a_collection",
            format!("{} has no mdbase.yaml", root.display()),
        ),
        FolderError::AlreadyHosted { root, host, .. } => ControlError::unavailable(
            "already_hosted",
            format!(
                "{} is open in {}; close it there and try again",
                root.display(),
                match host {
                    Some(HostKind::Daemon) => "the mdbase daemon",
                    Some(HostKind::Obsidian) => "Obsidian",
                    Some(HostKind::Library) => "another mdbase process",
                    _ => "another program",
                }
            ),
        ),
        FolderError::Unsafe(p) => ControlError::invalid(
            "unsafe_path",
            format!("{} is a symlink or escapes the collection", p.display()),
        ),
        FolderError::Host(e) => ControlError::internal(e.to_string()),
    }
}

fn session_error(e: crate::session::SessionError) -> ClientError {
    ClientError::Protocol(e.to_string())
}

fn encode(frame: ClientFrame) -> Result<Vec<u8>, ControlError> {
    frame
        .to_bytes()
        .map_err(|e| ControlError::internal(format!("encode a request: {e:?}")))
}

fn decode_frame(bytes: &[u8]) -> Result<ClientFrame, ControlError> {
    cbor::decode(bytes)
        .ok()
        .and_then(|c| ClientFrame::from_cbor(&c).ok())
        .ok_or_else(|| ControlError::internal("the replica sent an unreadable frame"))
}

/// Why `hello` was refused.
fn hello_refused(bytes: &[u8]) -> ControlError {
    match decode_frame(bytes) {
        Ok(ClientFrame::Response(ClientResponse {
            problem: Some(p), ..
        })) => problem(&p),
        Ok(_) => ControlError::internal("hello was refused without a problem"),
        Err(e) => e,
    }
}

fn problem(p: &Problem) -> ControlError {
    ControlError {
        code: p.code.clone(),
        message: p.message.clone(),
        reason: p.reason.clone(),
    }
}

fn decode<T: Wire>(c: &Cbor) -> Result<T, ControlError> {
    T::from_cbor(c).map_err(|e| ControlError::internal(format!("unreadable result: {e:?}")))
}

/// Request params: a map keyed 0, 1, … in order, skipping nulls.
fn params(values: Vec<Cbor>) -> Cbor {
    Cbor::Map(
        values
            .into_iter()
            .enumerate()
            .filter(|(_, v)| *v != Cbor::Null)
            .map(|(k, v)| (Cbor::Uint(k as u64), v))
            .collect(),
    )
}

fn include(body: bool, document: bool, diagnostics: bool) -> Include {
    Include {
        effective: None,
        body: Some(body),
        document: Some(document),
        diagnostics: Some(diagnostics),
    }
}

fn field(c: &Cbor, key: u64) -> Option<&Cbor> {
    match c {
        Cbor::Map(m) => m
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(key))
            .map(|(_, v)| v),
        _ => None,
    }
}

fn text(c: &Cbor, key: u64) -> Option<String> {
    match field(c, key) {
        Some(Cbor::Text(s)) => Some(s.clone()),
        _ => None,
    }
}

// ---- queries -------------------------------------------------------------------

fn query_json(
    types: Vec<String>,
    filter: Option<String>,
    order_by: &[String],
    limit: Option<u64>,
    offset: Option<u64>,
) -> Value {
    let mut q = Map::new();
    if !types.is_empty() {
        q.insert("types".into(), json!(types));
    }
    if let Some(w) = filter {
        q.insert("where".into(), json!(w));
    }
    if !order_by.is_empty() {
        let order: Vec<Value> = order_by
            .iter()
            .map(|f| match f.strip_prefix('-') {
                Some(f) => json!({"field": f, "direction": "desc"}),
                None => json!({"field": f, "direction": "asc"}),
            })
            .collect();
        q.insert("order_by".into(), Value::Array(order));
    }
    if let Some(n) = limit {
        q.insert("limit".into(), json!(n));
    }
    if let Some(n) = offset {
        q.insert("offset".into(), json!(n));
    }
    Value::Object(q)
}

fn read_json(file: &Path) -> Result<Value, ControlError> {
    let text = if file == Path::new("-") {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| ControlError::invalid("unreadable_request", format!("stdin: {e}")))?;
        s
    } else {
        std::fs::read_to_string(file).map_err(|e| {
            ControlError::invalid("unreadable_request", format!("{}: {e}", file.display()))
        })?
    };
    serde_json::from_str(&text)
        .map_err(|e| ControlError::invalid("invalid_json", format!("request: {e}")))
}

// ---- validation ----------------------------------------------------------------

struct ValidatedRecord {
    path: String,
    issues: Vec<LocatedIssue>,
}

struct LocatedIssue {
    severity: Severity,
    issue: Issue,
    location: Option<String>,
}

impl ValidatedRecord {
    fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "issues": self.issues.iter().map(|i| {
                let mut v = issue_json(&i.issue);
                if let Some(l) = &i.location {
                    v["location"] = json!(l);
                }
                v
            }).collect::<Vec<_>>(),
        })
    }
}

/// The `validate` result: records with at least one issue, by path.
fn validation(result: &Cbor) -> Result<Vec<ValidatedRecord>, ControlError> {
    let Cbor::Array(entries) = result else {
        return Err(ControlError::internal("unreadable validate result"));
    };
    let mut out = Vec::new();
    for entry in entries {
        let path = text(entry, 2).unwrap_or_default();
        let issues = match field(entry, 1) {
            Some(Cbor::Array(issues)) => issues
                .iter()
                .map(|c| {
                    let issue: Issue = decode(c)?;
                    Ok(LocatedIssue {
                        severity: issue.severity,
                        location: text(c, 4),
                        issue,
                    })
                })
                .collect::<Result<Vec<_>, ControlError>>()?,
            _ => Vec::new(),
        };
        if !issues.is_empty() {
            out.push(ValidatedRecord { path, issues });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn print_validation(records: &[ValidatedRecord]) {
    if records.is_empty() {
        println!("no issues");
        return;
    }
    let mut errors = 0;
    let mut warnings = 0;
    for r in records {
        for i in &r.issues {
            let label = match i.severity {
                Severity::Error => {
                    errors += 1;
                    "error"
                }
                Severity::Warning => {
                    warnings += 1;
                    "warning"
                }
            };
            let at = i
                .location
                .as_deref()
                .map(|l| format!(" {l}"))
                .unwrap_or_default();
            println!(
                "{}{at}: {label} {}: {}",
                r.path, i.issue.code, i.issue.message
            );
        }
    }
    println!(
        "{errors} error(s), {warnings} warning(s) in {} record(s)",
        records.len()
    );
}

// ---- types -----------------------------------------------------------------------

struct TypeSummary {
    name: String,
    path: String,
    version: Option<i64>,
    definition: Option<Value>,
    schema: Option<Value>,
}

impl TypeSummary {
    fn to_json(&self) -> Value {
        let mut v = json!({"name": self.name, "path": self.path});
        if let Some(n) = self.version {
            v["version"] = json!(n);
        }
        if let Some(d) = &self.definition {
            v["definition"] = d.clone();
        }
        if let Some(s) = &self.schema {
            v["schema"] = s.clone();
        }
        v
    }
}

/// `describe`'s types (`replica/src/frames.rs`, `describe_cbor`).
fn types(result: &Cbor) -> Result<Vec<TypeSummary>, ControlError> {
    let Some(Cbor::Array(types)) = field(result, 1) else {
        return Err(ControlError::internal("unreadable describe result"));
    };
    types
        .iter()
        .map(|ty| {
            let value = |key| {
                field(ty, key)
                    .map(|c| decode::<WireValue>(c).map(|v| to_json(&v)))
                    .transpose()
            };
            Ok(TypeSummary {
                name: text(ty, 0).unwrap_or_default(),
                path: text(ty, 1).unwrap_or_default(),
                version: field(ty, 3).map(decode::<i64>).transpose()?,
                definition: value(5)?,
                schema: value(6)?,
            })
        })
        .collect()
}

// ---- JSON output ---------------------------------------------------------------

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn record_json(r: &RecordView) -> Value {
    let mut v = json!({
        "id": uuid_string(&r.id.0),
        "path": r.path,
        "revision": hex(&r.revision.0),
        "types": r.types,
        "frontmatter": map_json(&r.frontmatter),
    });
    if let Some(b) = &r.body {
        v["body"] = json!(b);
    }
    if let Some(d) = &r.document {
        v["document"] = json!(d);
    }
    if let Some(issues) = &r.diagnostics {
        v["diagnostics"] = issues.iter().map(issue_json).collect();
    }
    if let Some(values) = &r.values {
        v["values"] = map_json(values);
    }
    v
}

fn query_result_json(r: &QueryResult) -> Value {
    let mut v = json!({
        "records": r.records.iter().map(record_json).collect::<Vec<_>>(),
        "complete": r.complete,
    });
    if let Some(c) = &r.columns {
        v["columns"] = json!(c);
    }
    if let Some(n) = r.total_count {
        v["total_count"] = json!(n);
    }
    if let Some(m) = r.has_more {
        v["has_more"] = json!(m);
    }
    if let Some(issues) = &r.diagnostics {
        v["diagnostics"] = issues.iter().map(issue_json).collect();
    }
    v
}

fn issue_json(i: &Issue) -> Value {
    let mut v = json!({
        "code": i.code,
        "severity": match i.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        },
        "message": i.message,
    });
    if let Some(d) = &i.details {
        v["details"] = to_json(d);
    }
    v
}

fn map_json(m: &DataMap<WireValue>) -> Value {
    Value::Object(m.0.iter().map(|(k, v)| (k.clone(), to_json(v))).collect())
}

fn to_json(v: &WireValue) -> Value {
    match v {
        WireValue::Null => Value::Null,
        WireValue::Bool(b) => Value::Bool(*b),
        WireValue::Int(i) => Value::from(*i),
        WireValue::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        WireValue::Text(s) => Value::String(s.clone()),
        WireValue::List(l) => Value::Array(l.iter().map(to_json).collect()),
        WireValue::Map(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), to_json(v))).collect())
        }
    }
}

fn to_wire(v: &Value) -> WireValue {
    match v {
        Value::Null => WireValue::Null,
        Value::Bool(b) => WireValue::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => WireValue::Int(i),
            None => WireValue::Float(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => WireValue::Text(s.clone()),
        Value::Array(a) => WireValue::List(a.iter().map(to_wire).collect()),
        Value::Object(o) => {
            WireValue::Map(o.iter().map(|(k, v)| (k.clone(), to_wire(v))).collect())
        }
    }
}
