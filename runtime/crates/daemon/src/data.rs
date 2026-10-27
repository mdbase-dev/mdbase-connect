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
use mdbn_local_host::{FolderError, FolderOptions, HostKind, OpenFolder, OsEntropy};
use mdbn_replica::api::{SessionAuth, SessionId};
use mdbn_replica::frames::Frames;
use mdbn_wire::Wire;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientRequest, ClientResponse, HelloParams, Include, Issue, Problem, PublishState,
    QueryResult, Receipt, ReceiptState, RecordView, Severity, SubmitParams, WaitFor,
};
use mdbn_wire::common::{B16, B32, DataMap, Text, Value as WireValue, Version};
use mdbn_wire::intent::{self, ConflictMode};
use serde::Deserialize;
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
    /// Create a record. Prints its path (`--json`: the write).
    Create {
        #[command(flatten)]
        target: Target,
        /// Record path (default: the type's path template).
        #[arg(long)]
        path: Option<String>,
        /// The record's type.
        #[arg(long = "type", value_name = "TYPE")]
        type_name: Option<String>,
        /// Frontmatter fields as a JSON object.
        #[arg(long, value_name = "JSON")]
        fields: Option<String>,
        #[command(flatten)]
        body: BodyArgs,
        #[command(flatten)]
        write: WriteArgs,
    },
    /// Change a record's fields or body. A field set to `null` is removed.
    Update {
        #[command(flatten)]
        target: Target,
        /// Record path.
        path: String,
        /// Fields to set, as a JSON object.
        #[arg(long, value_name = "JSON")]
        fields: Option<String>,
        #[command(flatten)]
        body: BodyArgs,
        #[command(flatten)]
        write: WriteArgs,
    },
    /// Delete a record.
    Delete {
        #[command(flatten)]
        target: Target,
        /// Record path.
        path: String,
        #[command(flatten)]
        write: WriteArgs,
    },
    /// Rename or move a record, updating links to it unless told not to.
    Rename {
        #[command(flatten)]
        target: Target,
        /// Current path.
        from: String,
        /// New path.
        to: String,
        /// Update links in other records (the default).
        #[arg(long, conflicts_with = "no_update_refs")]
        update_refs: bool,
        /// Leave links in other records as they are.
        #[arg(long)]
        no_update_refs: bool,
        #[command(flatten)]
        write: WriteArgs,
    },
    /// Apply several writes as one: all or nothing. The request is JSON,
    /// `{"ops": [{"op": "create" | "update" | "delete" | "rename", ...}]}`.
    Batch {
        #[command(flatten)]
        target: Target,
        /// The request, from a file or `-` for stdin.
        #[arg(long, value_name = "FILE")]
        request: PathBuf,
        /// Report what would change without writing.
        #[arg(long)]
        dry_run: bool,
    },
}

/// A new body for `create` and `update`.
#[derive(Debug, Args)]
pub(crate) struct BodyArgs {
    /// The body text.
    #[arg(long, conflicts_with = "body_file")]
    body: Option<String>,
    /// Read the body from a file, or `-` for stdin.
    #[arg(long, value_name = "FILE")]
    body_file: Option<PathBuf>,
}

/// Options every single write takes.
#[derive(Debug, Args)]
pub(crate) struct WriteArgs {
    /// Write only if the record is still at this revision (from `read --json`).
    #[arg(long, value_name = "REVISION")]
    if_revision: Option<String>,
    /// Report what would change without writing.
    #[arg(long)]
    dry_run: bool,
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
        DataCmd::Create {
            target,
            path,
            type_name,
            fields,
            body,
            write,
        } => {
            if write.if_revision.is_some() {
                return Err(ControlError::invalid(
                    "invalid_argument",
                    "--if-revision applies to existing records; create has none",
                )
                .into());
            }
            let op = WriteOp::Create {
                path,
                type_name,
                fields: fields_arg(fields.as_deref())?,
                body: body.read()?,
            };
            submit(&target, profile, json, vec![op], write.dry_run).await
        }
        DataCmd::Update {
            target,
            path,
            fields,
            body,
            write,
        } => {
            let op = WriteOp::Update {
                path,
                fields: fields_arg(fields.as_deref())?,
                body: body.read()?,
                if_revision: write.if_revision,
            };
            submit(&target, profile, json, vec![op], write.dry_run).await
        }
        DataCmd::Delete {
            target,
            path,
            write,
        } => {
            let op = WriteOp::Delete {
                path,
                if_revision: write.if_revision,
            };
            submit(&target, profile, json, vec![op], write.dry_run).await
        }
        DataCmd::Rename {
            target,
            from,
            to,
            update_refs: _,
            no_update_refs,
            write,
        } => {
            let op = WriteOp::Rename {
                from,
                to,
                update_refs: !no_update_refs,
                if_revision: write.if_revision,
            };
            submit(&target, profile, json, vec![op], write.dry_run).await
        }
        DataCmd::Batch {
            target,
            request,
            dry_run,
        } => {
            let request: BatchRequest = serde_json::from_value(read_json(&request)?)
                .map_err(|e| ControlError::invalid("invalid_request", format!("request: {e}")))?;
            if request.ops.is_empty() {
                return Err(
                    ControlError::invalid("invalid_request", "the request has no ops").into(),
                );
            }
            submit(
                &target,
                profile,
                json,
                request.ops,
                dry_run || request.dry_run,
            )
            .await
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
    Submit,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Method::Get => "get",
            Method::Query => "query",
            Method::Validate => "validate",
            Method::Describe => "describe",
            Method::Submit => "submit",
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
                frames.on_frame(folder.replica.replica(), *session, &bytes);
                let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
                loop {
                    frames.pump(folder.replica.replica());
                    if let Some(r) = answer(frames.take_outgoing(), id)? {
                        break r;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(ClientError::Timeout);
                    }
                    // A held `submit` answers once the write is published: the
                    // store observes its own file writes, then the replica's
                    // timers settle the wait.
                    std::thread::sleep(Duration::from_millis(2));
                    folder
                        .replica
                        .observe()
                        .map_err(|e| ControlError::internal(e.to_string()))?;
                    let now = mdbn_local_host::host::now_ms() as i64;
                    frames.tick(folder.replica.replica(), now);
                }
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

/// The response to request `id` among the frames the replica sent, if there.
fn answer(
    outgoing: Vec<(SessionId, Vec<u8>)>,
    id: u64,
) -> Result<Option<ClientResponse>, ControlError> {
    for (_, out) in outgoing {
        if let ClientFrame::Response(r) = decode_frame(&out)?
            && r.id == id
        {
            return Ok(Some(r));
        }
    }
    Ok(None)
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

// ---- writes --------------------------------------------------------------------

/// One write, as the commands and `batch` requests give it. Records are named by
/// path; the transport resolves each to its ID on the same route.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum WriteOp {
    Create {
        path: Option<String>,
        #[serde(rename = "type")]
        type_name: Option<String>,
        #[serde(default)]
        fields: Map<String, Value>,
        body: Option<String>,
    },
    Update {
        path: String,
        #[serde(default)]
        fields: Map<String, Value>,
        body: Option<String>,
        if_revision: Option<String>,
    },
    Delete {
        path: String,
        if_revision: Option<String>,
    },
    Rename {
        from: String,
        to: String,
        #[serde(default = "yes")]
        update_refs: bool,
        if_revision: Option<String>,
    },
}

fn yes() -> bool {
    true
}

/// A `batch` request.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    ops: Vec<WriteOp>,
    #[serde(default)]
    dry_run: bool,
}

impl BodyArgs {
    fn read(&self) -> Result<Option<String>, ControlError> {
        match (&self.body, &self.body_file) {
            (Some(b), _) => Ok(Some(b.clone())),
            (None, Some(file)) => read_text(file).map(Some),
            (None, None) => Ok(None),
        }
    }
}

fn fields_arg(fields: Option<&str>) -> Result<Map<String, Value>, ControlError> {
    match fields.map(serde_json::from_str::<Value>) {
        None => Ok(Map::new()),
        Some(Ok(Value::Object(m))) => Ok(m),
        Some(Ok(_)) => Err(ControlError::invalid(
            "invalid_fields",
            "--fields must be a JSON object",
        )),
        Some(Err(e)) => Err(ControlError::invalid(
            "invalid_fields",
            format!("--fields: {e}"),
        )),
    }
}

/// A revision as `read --json` prints it (hex, optionally `sha256:`-prefixed).
fn revision(r: Option<String>) -> Result<Option<B32>, ControlError> {
    let Some(r) = r else { return Ok(None) };
    let bytes = secrets::hex_decode(r.strip_prefix("sha256:").unwrap_or(&r))
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| {
            ControlError::invalid("invalid_revision", format!("{r:?} is not a revision"))
        })?;
    Ok(Some(B32(bytes)))
}

fn wire_map(fields: &Map<String, Value>) -> DataMap<WireValue> {
    DataMap(
        fields
            .iter()
            .map(|(k, v)| (k.clone(), to_wire(v)))
            .collect(),
    )
}

/// The ID this route gives the record at `path`.
async fn record_id(t: &mut Transport, path: &str) -> Result<B16, ClientError> {
    let view: RecordView = decode(
        &t.call(
            Method::Get,
            params(vec![
                Cbor::Text(path.into()),
                include(false, false, false).to_cbor(),
            ]),
        )
        .await?,
    )?;
    Ok(view.id)
}

/// What one op did, for the report.
struct Planned {
    verb: (&'static str, &'static str),
    id: B16,
    path: Option<String>,
    to: Option<String>,
}

/// Apply `ops` as one mutation, waiting until it is in the files.
async fn submit(
    target: &Target,
    profile: &Profile,
    json: bool,
    ops: Vec<WriteOp>,
    dry_run: bool,
) -> Result<ExitCode, ClientError> {
    let mut t = open(target, profile).await?;
    let now = mdbn_local_host::host::now_ms();
    let mut wire_ops = Vec::with_capacity(ops.len());
    let mut planned = Vec::with_capacity(ops.len());
    for op in ops {
        match op {
            WriteOp::Create {
                path,
                type_name,
                fields,
                body,
            } => {
                let id = B16(mdbn_local_host::host::uuid_v7(now, &mut OsEntropy));
                planned.push(Planned {
                    verb: ("created", "create"),
                    id,
                    path: path.clone(),
                    to: None,
                });
                wire_ops.push(intent::Op::Create(intent::Create {
                    id,
                    path,
                    type_name,
                    frontmatter: Some(wire_map(&fields)),
                    body: body.map(Text::Inline),
                    document: None,
                }));
            }
            WriteOp::Update {
                path,
                fields,
                body,
                if_revision,
            } => {
                let id = record_id(&mut t, &path).await?;
                let (unset, set): (Map<String, Value>, Map<String, Value>) =
                    fields.into_iter().partition(|(_, v)| v.is_null());
                planned.push(Planned {
                    verb: ("updated", "update"),
                    id,
                    path: Some(path),
                    to: None,
                });
                wire_ops.push(intent::Op::Update(intent::Update {
                    id,
                    patch: (!set.is_empty()).then(|| wire_map(&set)),
                    unset: (!unset.is_empty()).then(|| unset.into_iter().map(|(k, _)| k).collect()),
                    add: None,
                    remove: None,
                    body: body.map(Text::Inline),
                    body_edits: None,
                    body_base: None,
                    body_base_text: None,
                    base: None,
                    if_revision: revision(if_revision)?,
                }));
            }
            WriteOp::Delete { path, if_revision } => {
                let id = record_id(&mut t, &path).await?;
                planned.push(Planned {
                    verb: ("deleted", "delete"),
                    id,
                    path: Some(path),
                    to: None,
                });
                wire_ops.push(intent::Op::Delete(intent::Delete {
                    id,
                    base_revision: None,
                    if_revision: revision(if_revision)?,
                }));
            }
            WriteOp::Rename {
                from,
                to,
                update_refs,
                if_revision,
            } => {
                let id = record_id(&mut t, &from).await?;
                planned.push(Planned {
                    verb: ("renamed", "rename"),
                    id,
                    path: Some(from.clone()),
                    to: Some(to.clone()),
                });
                wire_ops.push(intent::Op::Rename(intent::Rename {
                    id,
                    from,
                    to,
                    update_refs,
                    if_revision: revision(if_revision)?,
                }));
            }
        }
    }
    let params = SubmitParams {
        ops: wire_ops,
        // A fresh mutation per call: a rerun is a new write, never a replay.
        mutation_id: Some(B16(mdbn_local_host::host::uuid_v7(now, &mut OsEntropy))),
        conflict_mode: Some(ConflictMode::Reject),
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: dry_run.then_some(true),
        include: Some(include(false, false, true)),
        wait: Some(if dry_run {
            WaitFor::Pending
        } else {
            WaitFor::Published
        }),
    };
    let receipts: Vec<Receipt> = decode(&t.call(Method::Submit, params.to_cbor()).await?)?;
    let receipt = receipts
        .into_iter()
        .next()
        .ok_or_else(|| ControlError::internal("submit returned no receipt"))?;
    match (receipt.state, &receipt.problem) {
        (ReceiptState::Rejected, Some(p)) => return Err(problem(p).into()),
        (ReceiptState::Rejected, None) => {
            return Err(ControlError::internal("the write was rejected without a reason").into());
        }
        (ReceiptState::Unknown, _) => {
            return Err(ControlError::unavailable(
                "outcome_unknown",
                "the write's outcome cannot be determined; check the record before retrying",
            )
            .into());
        }
        // Pending or confirmed: the change is recorded. It is done for the CLI
        // once its file is written (or known not to be); a local-only write is
        // confirmed on the replica's next tick, a synced one when the log appends.
        _ if !dry_run && receipt.published == Some(PublishState::Publishing) => {
            return Err(ClientError::Timeout);
        }
        _ => {}
    }
    let records = receipt.records.unwrap_or_default();
    if json {
        print_json(&json!({
            "mutation": uuid_string(&receipt.mutation.0),
            "dry_run": dry_run,
            "published": receipt.published.map(|p| match p {
                PublishState::Publishing => "publishing",
                PublishState::Published => "published",
                PublishState::NotPublished => "not_published",
            }),
            "records": records.iter().map(record_json).collect::<Vec<_>>(),
        }));
    } else {
        for p in &planned {
            let path = records
                .iter()
                .find(|r| r.id == p.id)
                .map(|r| r.path.clone())
                .or_else(|| p.path.clone())
                .unwrap_or_default();
            let verb = if dry_run {
                format!("would {}", p.verb.1)
            } else {
                p.verb.0.to_string()
            };
            match &p.to {
                Some(to) => println!("{verb} {} -> {to}", p.path.as_deref().unwrap_or_default()),
                None => println!("{verb} {path}"),
            }
        }
        for r in &records {
            for i in r.diagnostics.iter().flatten() {
                let label = match i.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                };
                eprintln!("{}: {label} {}: {}", r.path, i.code, i.message);
            }
        }
    }
    if receipt.published == Some(PublishState::NotPublished) {
        eprintln!(
            "the change is recorded but its file was not written: the file changed or is held; \
             see `mdbase holds`"
        );
    }
    Ok(ExitCode::SUCCESS)
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
    serde_json::from_str(&read_text(file)?)
        .map_err(|e| ControlError::invalid("invalid_json", format!("request: {e}")))
}

/// A file's text, or stdin's for `-`.
fn read_text(file: &Path) -> Result<String, ControlError> {
    if file == Path::new("-") {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| ControlError::invalid("unreadable_input", format!("stdin: {e}")))?;
        Ok(s)
    } else {
        std::fs::read_to_string(file).map_err(|e| {
            ControlError::invalid("unreadable_input", format!("{}: {e}", file.display()))
        })
    }
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
