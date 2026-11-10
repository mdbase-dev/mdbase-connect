//! Command dispatch: one match arm per command, each a request to the daemon.

use super::*;

pub(super) async fn dispatch(cmd: Command, profile: &Profile, out: &Output) -> ExitCode {
    let result = run_command(cmd, profile, out).await;
    match result {
        Ok(code) => code,
        Err(e) => out.error(&e),
    }
}

pub(super) async fn run_command(
    cmd: Command,
    profile: &Profile,
    out: &Output,
) -> Result<ExitCode, ClientError> {
    match cmd {
        Command::Daemon(DaemonCmd::Run) | Command::Companion => {
            unreachable!("handled before the runtime starts")
        }
        Command::Data(cmd) => crate::data::run(cmd, profile, out.json).await,
        Command::Daemon(DaemonCmd::Start) => daemon_start(profile, out).await,
        Command::Daemon(DaemonCmd::Stop) => daemon_stop(profile, out).await,
        Command::Daemon(DaemonCmd::Status) => {
            let r = client::ping(&profile.control).await?;
            if out.json {
                out.value(&json!({ "readiness": r, "target": profile.target }));
            } else if r.ready {
                println!("ready (version {}, {:?})", r.binary_version, profile.target);
            } else {
                println!(
                    "not ready: {} (version {})",
                    r.safe_reason
                        .and_then(|s| serde_json::to_value(s).ok())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_else(|| "unknown".into()),
                    r.binary_version
                );
            }
            Ok(if r.ready {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(3)
            })
        }
        Command::Status => {
            let v = call(profile, Method::STATUS, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                let s: DaemonStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                print_status(&s);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::List) => {
            let v = call(profile, Method::COLLECTION_LIST, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<CollectionStatus> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No collections. Add one with `mdbase collection add <folder>`.");
                }
                for c in &list {
                    print_collection(c);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Add {
            path,
            name,
            remove_legacy_identity,
        }) => {
            let path = std::path::absolute(&path).map_err(ClientError::Io)?;
            let v = call(
                profile,
                Method::COLLECTION_ADD,
                json!(AddCollection {
                    path,
                    name,
                    remove_legacy_identity,
                }),
            )
            .await
            .map_err(|e| match e {
                ClientError::Remote(mut err)
                    if err.reason.as_deref() == Some("orphaned_legacy_identity") =>
                {
                    err.message
                        .push_str(" (add it with `--remove-legacy-identity` to remove the key)");
                    ClientError::Remote(err)
                }
                e => e,
            })?;
            if out.json {
                out.value(&v);
            } else {
                let c: CollectionStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                println!("Registered {} ({}).", c.name, c.id);
                print_collection(&c);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Join {
            collection,
            path,
            name,
            private,
        }) => {
            let path = std::path::absolute(&path).map_err(ClientError::Io)?;
            let v = call(
                profile,
                Method::COLLECTION_JOIN,
                json!({ "collection": collection, "path": path, "name": name, "private": private }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let c: CollectionStatus =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                println!(
                    "Joined {} ({}). Its files arrive once this computer is keyed.",
                    c.name, c.id
                );
                print_collection(&c);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Remove { collection }) => {
            let id = resolve(profile, &collection).await?;
            let v = call(
                profile,
                Method::COLLECTION_REMOVE,
                json!({ "collection": id }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                println!("Unregistered {id}. Its files were not touched.");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Delete {
            collection,
            confirm,
        }) => {
            let id = match crate::attest::uuid_bytes(&collection.to_ascii_lowercase()) {
                Some(id) => crate::secrets::uuid_string(&id),
                None => resolve(profile, &collection).await?,
            };
            let v = call(
                profile,
                Method::COLLECTION_DELETE,
                json!({ "collection": id, "confirm_name": confirm }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                println!("Deleted synced collection {id}. Local files and registration were kept.");
                println!("To unregister the local folder, run `mdbase collection remove {id}`.");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Collection(CollectionCmd::Update {
            collection,
            name,
            description,
        }) => {
            let mut extra = serde_json::Map::new();
            if let Some(name) = name {
                extra.insert("name".into(), Value::String(name));
            }
            if let Some(description) = description {
                extra.insert("description".into(), Value::String(description));
            }
            simple(
                profile,
                out,
                Method::COLLECTION_UPDATE,
                &collection,
                Value::Object(extra),
            )
            .await
        }
        Command::Collection(CollectionCmd::Pause { collection }) => {
            simple(
                profile,
                out,
                Method::COLLECTION_PAUSE,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Collection(CollectionCmd::Resume { collection }) => {
            simple(
                profile,
                out,
                Method::COLLECTION_RESUME,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Activity { limit } => {
            let v = call(profile, Method::ACTIVITY_LIST, json!({ "limit": limit })).await?;
            if out.json {
                out.value(&v);
            } else {
                for e in v.as_array().into_iter().flatten() {
                    let who = [e.get("app_name"), e.get("collection_name"), e.get("detail")]
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" · ");
                    println!(
                        "{}  {}  {}",
                        e["at_ms"].as_u64().unwrap_or(0),
                        e["kind"].as_str().unwrap_or(""),
                        who
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Holds { collection } => {
            simple(
                profile,
                out,
                Method::COLLECTION_HOLDS,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Resolve {
            collection,
            id,
            how,
        } => {
            simple(
                profile,
                out,
                Method::COLLECTION_RESOLVE_HOLD,
                &collection,
                json!({ "id": id, "how": how }),
            )
            .await
        }
        Command::Conflicts {
            collection,
            command,
        } => {
            let (collection, dismiss) = match command {
                Some(ConflictCmd::Dismiss {
                    id,
                    collection: target,
                }) => (target.or(collection), Some(id)),
                None => (collection, None),
            };
            let collection = match collection {
                Some(c) => c,
                None => {
                    let list: Vec<CollectionStatus> = serde_json::from_value(
                        call(profile, Method::COLLECTION_LIST, json!({})).await?,
                    )
                    .map_err(|e| ClientError::Protocol(e.to_string()))?;
                    match list.as_slice() {
                        [one] => one.id.clone(),
                        _ => {
                            return Err(ClientError::Remote(ControlError::invalid(
                                "collection_required",
                                "specify a collection ID or name after the conflict ID",
                            )));
                        }
                    }
                }
            };
            let id = resolve(profile, &collection).await?;
            if let Some(conflict) = dismiss {
                let v = call(
                    profile,
                    Method::CONFLICTS_DISMISS,
                    json!({ "collection": id, "id": conflict }),
                )
                .await?;
                out.value(&v);
                return Ok(ExitCode::SUCCESS);
            }
            let v = call(
                profile,
                Method::COLLECTION_CONFLICTS,
                json!({ "collection": id }),
            )
            .await?;
            if out.json {
                out.value(&v);
                return Ok(ExitCode::SUCCESS);
            }
            let list: Vec<ConflictSummary> =
                serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
            if list.is_empty() {
                println!("No unresolved conflicts.");
            }
            for c in &list {
                let what = match &c.field {
                    Some(f) => format!("{} {f}", c.kind),
                    None => c.kind.clone(),
                };
                println!("{}  {what}  ({})", c.path.as_deref().unwrap_or(&c.id), c.id);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Sync(SyncCmd::Enable {
            collection,
            mode,
            accept_takeover_holds,
        }) => {
            if accept_takeover_holds {
                // Say exactly what is being accepted without review.
                let id = resolve(profile, &collection).await?;
                let holds = call(
                    profile,
                    Method::COLLECTION_HOLDS,
                    json!({ "collection": id }),
                )
                .await
                .ok()
                .and_then(|v| serde_json::from_value::<Vec<HoldSummary>>(v).ok())
                .unwrap_or_default();
                let taken: Vec<&HoldSummary> = holds
                    .iter()
                    .filter(|h| h.id.starts_with(crate::takeover::held::ID_PREFIX))
                    .collect();
                if !taken.is_empty() {
                    eprintln!(
                        "Accepting this computer's version of {} file(s) held at the takeover; \
                         the old connector's versions stay in mdbase's state directory:",
                        taken.len()
                    );
                    for h in taken {
                        eprintln!("  {}", h.path);
                    }
                }
            }
            let mut params = json!({ "accept_takeover_holds": accept_takeover_holds });
            if let Some(mode) = mode {
                params["mode"] = json!(match mode {
                    SyncKind::Private => SyncMode::SyncedE2e,
                    SyncKind::CloudCopy => SyncMode::Synced,
                });
            }
            simple(profile, out, Method::SYNC_ENABLE, &collection, params).await
        }
        Command::Sync(SyncCmd::Mode {
            collection,
            mode,
            resume,
            cancel,
        }) => {
            let target = match mode {
                SyncKind::Private => "private",
                SyncKind::CloudCopy => "cloud_copy",
            };
            simple(
                profile,
                out,
                Method::COLLECTION_MODE,
                &collection,
                json!({"target_mode":target,"resume":resume,"cancel":cancel}),
            )
            .await
        }
        Command::Sync(SyncCmd::ModeStatus { collection }) => {
            simple(
                profile,
                out,
                Method::COLLECTION_MODE_STATUS,
                &collection,
                json!({}),
            )
            .await
        }
        Command::Sync(SyncCmd::Files {
            collection,
            set: false,
            ..
        }) => simple(profile, out, Method::SYNC_FILES, &collection, json!({})).await,
        Command::Sync(SyncCmd::Files {
            collection,
            set: true,
            types,
            exclude,
            max_size,
        }) => {
            let include: Vec<String> = match types {
                Some(t) => t.into_iter().filter(|t| !t.is_empty()).collect(),
                None => ["image", "audio", "video", "pdf", "other"]
                    .map(String::from)
                    .to_vec(),
            };
            simple(
                profile,
                out,
                Method::SYNC_FILES_SET,
                &collection,
                json!({ "include": include, "exclude": exclude, "max_size": max_size }),
            )
            .await
        }
        Command::Sync(SyncCmd::Disable { collection }) => {
            simple(profile, out, Method::SYNC_DISABLE, &collection, json!({})).await
        }
        Command::Device(DeviceCmd::Pending { collection }) => {
            let collection = match collection {
                Some(c) => Some(resolve(profile, &c).await?),
                None => None,
            };
            let v = call(
                profile,
                Method::DEVICE_PENDING,
                json!({ "collection": collection }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let list: Vec<PendingDevice> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                if list.is_empty() {
                    println!("No other computer is waiting to open a private collection here.");
                }
                for d in &list {
                    println!(
                        "{} wants to open \"{}\"  (device {})",
                        d.name.as_deref().unwrap_or("Another computer"),
                        d.collection_name,
                        d.device
                    );
                    if let Some(code) = &d.sas {
                        println!(
                            "Only allow if this matches the code on {}: {}",
                            d.name.as_deref().unwrap_or("the other computer"),
                            display_code(code)
                        );
                    } else {
                        println!(
                            "Preparing verification code; run mdbase device pending again shortly."
                        );
                    }
                }
                if let Some(d) = list.iter().find(|d| d.sas.is_some()) {
                    println!(
                        "Allow: mdbase device approve {}\nDeny:  mdbase device deny {}",
                        d.device, d.device
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Device(DeviceCmd::Approve {
            device,
            collection,
            checked_code,
        }) => {
            let (device, collection) = pending_device(profile, &device, collection).await?;
            let sas = if let Some(code) = checked_code {
                code
            } else {
                let v = call(
                    profile,
                    Method::DEVICE_PENDING,
                    json!({ "collection": collection }),
                )
                .await?;
                let list: Vec<PendingDevice> =
                    serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
                let mut codes = list
                    .iter()
                    .filter(|d| d.device == device)
                    .filter_map(|d| d.sas.as_deref());
                let code = codes.next().ok_or_else(|| ClientError::Remote(ControlError::unavailable(
                    "approval_not_ready", "the code is not ready; keep mdbase open on both computers and run device pending again shortly"
                )))?;
                if codes.any(|other| other != code) {
                    return Err(ClientError::Remote(ControlError::invalid(
                        "collection_required",
                        "more than one collection has a different code; approve one collection at a time",
                    )));
                }
                if !confirm(
                    out,
                    &format!(
                        "Only allow if this matches the code on the other computer: {}. Allow?",
                        display_code(code)
                    ),
                ) {
                    return Ok(ExitCode::FAILURE);
                }
                code.to_string()
            };
            let v = call(
                profile,
                Method::DEVICE_APPROVE,
                json!({ "device": device, "collection": collection, "sas": sas }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                println!("Allowed. The other computer can open the collection now.");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Device(DeviceCmd::Deny { device, collection }) => {
            let (device, collection) = pending_device(profile, &device, collection).await?;
            let v = call(
                profile,
                Method::DEVICE_REJECT,
                json!({ "device": device, "collection": collection }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                println!("Denied.");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Recovery(RecoveryCmd::Create { collection }) => {
            let id = resolve(profile, &collection).await?;
            let v = call(
                profile,
                Method::RECOVERY_CREATE,
                json!({ "collection": id }),
            )
            .await?;
            if out.json {
                out.value(&v);
            } else {
                let key = v.get("recovery_key").and_then(Value::as_str).unwrap_or("");
                println!(
                    "Recovery key (shown once; store it somewhere safe and offline):\n\n  {key}\n"
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Recovery(RecoveryCmd::Import { collection }) => {
            if std::io::stdin().is_terminal() {
                eprintln!("Type or paste the recovery key, then press Enter:");
            }
            let mut key = String::new();
            std::io::stdin()
                .read_line(&mut key)
                .map_err(ClientError::Io)?;
            let key = key.trim().to_string();
            simple(
                profile,
                out,
                Method::RECOVERY_IMPORT,
                &collection,
                json!({ "recovery_key": key }),
            )
            .await
        }
        Command::Private(cmd) => private(profile, out, cmd).await,
        Command::Doctor => {
            let v = call(profile, Method::DOCTOR, json!({})).await;
            let v = match v {
                Ok(v) => v,
                Err(ClientError::NotRunning) => serde_json::to_value(vec![Check {
                    id: "daemon".into(),
                    status: "fail".into(),
                    detail: format!("nothing is listening on {}", profile.control),
                    action: Some("Start it with `mdbase daemon start`.".into()),
                }])
                .unwrap_or_default(),
                Err(e) => return Err(e),
            };
            let mut checks: Vec<Check> =
                serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
            if !checks.iter().any(|c| c.id == "daemon") {
                checks.push(replica_endpoint_check(profile).await);
            } else {
                // Not running: whether it is registered to start at login is the next question.
                let p = profile.clone();
                if let Ok(c) =
                    tokio::task::spawn_blocking(move || crate::service::doctor_check(&p)).await
                {
                    checks.push(c);
                }
            }
            let v = serde_json::to_value(&checks).unwrap_or_default();
            if out.json {
                out.value(&v);
            } else {
                for c in &checks {
                    println!("[{:>4}] {}: {}", c.status, c.id, c.detail);
                    if let Some(a) = &c.action {
                        println!("       → {a}");
                    }
                }
            }
            Ok(if checks.iter().any(|c| c.status == "fail") {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Logs { lines, follow } => logs(profile, lines, follow).await,
        Command::Access(cmd) => access_command(profile, out, cmd).await,
        Command::Account(AccountCmd::SignIn { server }) => {
            let v = call(
                profile,
                Method::ACCOUNT_SIGN_IN,
                json!({ "server_url": server, "name": hostname() }),
            )
            .await?;
            let uri = v
                .get("verification_uri")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if out.json {
                out.value(&v);
                return Ok(ExitCode::SUCCESS);
            }
            println!("Approve this computer in your browser:\n\n  {uri}\n");
            open_browser(&uri);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let s: DaemonStatus =
                    serde_json::from_value(call(profile, Method::STATUS, json!({})).await?)
                        .map_err(|e| ClientError::Protocol(e.to_string()))?;
                if s.account.signed_in && s.account.pairing.is_none() {
                    println!("Signed in.");
                    return Ok(ExitCode::SUCCESS);
                }
                if let Some(e) = s.account.last_error.filter(|_| s.account.pairing.is_none()) {
                    return Err(ClientError::Remote(ControlError::unavailable(
                        "sign_in_failed",
                        account_problem(&e),
                    )));
                }
                if tokio::time::Instant::now() > deadline {
                    return Err(ClientError::Timeout);
                }
            }
        }
        Command::Account(AccountCmd::SignOut) => {
            let v = call(profile, Method::ACCOUNT_SIGN_OUT, json!({})).await?;
            if out.json {
                out.value(&v);
            } else {
                println!(
                    "Signed out. Apps can no longer reach your local collections through this computer."
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Account(AccountCmd::Rename { name }) => {
            let v = call(profile, Method::ACCOUNT_RENAME, json!({ "name": name })).await?;
            if out.json {
                out.value(&v);
            } else {
                println!(
                    "This computer is now called {}.",
                    v["name"].as_str().unwrap_or("")
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Settings { require_approval } => {
            let v = match require_approval {
                None => call(profile, Method::SETTINGS_GET, json!({})).await?,
                Some(o) => {
                    let on = matches!(o, OnOff::On);
                    if !on
                        && !confirm(
                            out,
                            "Let new apps use local collections without asking first?",
                        )
                    {
                        return Ok(ExitCode::from(1));
                    }
                    call(
                        profile,
                        Method::SETTINGS_SET,
                        json!({ "require_grant_approval": on }),
                    )
                    .await?
                }
            };
            if out.json {
                out.value(&v);
            } else {
                let on = v
                    .get("require_grant_approval")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                println!(
                    "New apps for local collections: {}",
                    if on {
                        "wait for your approval here"
                    } else {
                        "allowed, and you are notified"
                    }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Service(cmd) => Ok(crate::service::run(cmd, profile, out.json).await),
        Command::Migrate(MigrateCmd::Status) => {
            let v = match call(profile, Method::MIGRATE_STATUS, json!({})).await {
                Ok(v) => v,
                Err(ClientError::NotRunning) => {
                    let path =
                        crate::takeover::Paths::new(&profile.state_dir, profile.store_ids_file())
                            .record;
                    let record = crate::takeover::record::Record::load(&path).map_err(|e| {
                        ClientError::Remote(ControlError::internal(format!("takeover record: {e}")))
                    })?;
                    let waiting = record.is_none()
                        && crate::takeover::old_state_dir(profile)
                            .is_some_and(|p| p.join("connector.sqlite").is_file());
                    json!({ "record": record, "daemon": "not_running", "waiting_for_migration_batch": waiting,
                        "held_interrupted_writes": record.as_ref().map(|r| r.held_interrupted_writes()).unwrap_or(0) })
                }
                Err(e) => return Err(e),
            };
            migrate_print(out, &v);
            Ok(ExitCode::SUCCESS)
        }
        Command::Migrate(MigrateCmd::Start { stop_mirrors }) => {
            let v = call(
                profile,
                Method::MIGRATE_START,
                json!({ "stop_mirrors": stop_mirrors }),
            )
            .await?;
            migrate_print(out, &v);
            Ok(ExitCode::SUCCESS)
        }
        Command::Paths => {
            let v = serde_json::to_value(profile).unwrap_or_default();
            if out.json {
                out.value(&v);
            } else {
                println!("target:    {:?}", profile.target);
                println!("state dir: {}", profile.state_dir.display());
                println!("control:   {}", profile.control);
                println!("replica:   {}", profile.replica);
                println!("log:       {}", profile.log_file().display());
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}
