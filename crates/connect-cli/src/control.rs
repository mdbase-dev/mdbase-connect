use super::*;
use mdbase_connect_protocol::SelectiveSyncPolicy;
pub(super) fn control_command(
    command: ConnectCommand,
) -> Result<(ControlCommand, OutputKind), CliError> {
    let pair = match command {
        ConnectCommand::Status => (ControlCommand::Status, OutputKind::Status),
        ConnectCommand::Whoami => (ControlCommand::AccessSnapshot, OutputKind::Account),
        ConnectCommand::Ping => (ControlCommand::Ping, OutputKind::Generic),
        ConnectCommand::Collection(CollectionCommand::List) => {
            (ControlCommand::CollectionList, OutputKind::Collections)
        }
        ConnectCommand::Collection(CollectionCommand::Add { path }) => (
            ControlCommand::CollectionAdd(CollectionPathParams {
                path: path_string(path)?,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::AddCopy { path }) => (
            ControlCommand::CollectionAddCopy(CollectionPathParams {
                path: path_string(path)?,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::Create {
            path,
            name,
            timezone,
        }) => (
            ControlCommand::CollectionCreate(CollectionCreateParams {
                path: path_string(path)?,
                name,
                timezone: effective_timezone(timezone)?,
            }),
            OutputKind::Collection,
        ),
        ConnectCommand::Collection(CollectionCommand::Remove { collection_id }) => (
            ControlCommand::CollectionRemove(CollectionIdParams { collection_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Collection(CollectionCommand::Validate { collection_id }) => (
            ControlCommand::CollectionValidate(CollectionIdParams { collection_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Collection(CollectionCommand::TransferAuthority {
            collection_id,
            target,
        }) => (
            ControlCommand::CollectionTransferAuthority(CollectionAuthorityTransferParams {
                collection_id,
                target: match target {
                    CliAuthorityTarget::Remote => AuthorityTarget::Remote,
                },
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Mirror(MirrorCommand::List) => {
            (ControlCommand::MirrorList, OutputKind::Mirrors)
        }
        ConnectCommand::Mirror(MirrorCommand::Add {
            collection_id,
            path,
            name,
            read_only,
            two_way: _,
            files,
            excluded_folders,
        }) => (
            ControlCommand::MirrorAdd(MirrorAddParams {
                collection_id,
                path: path_string(path)?,
                mode: if read_only {
                    SyncReplicaMode::ReadOnly
                } else {
                    SyncReplicaMode::ReadWrite
                },
                name,
                selective_sync: selective_sync_policy(files, excluded_folders),
            }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Sync { replica_id }) => (
            ControlCommand::MirrorSync(MirrorIdParams { replica_id }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Configure {
            replica_id,
            files,
            excluded_folders,
        }) => (
            ControlCommand::MirrorConfigureSelectiveSync(MirrorConfigureSelectiveSyncParams {
                replica_id,
                selective_sync: selective_sync_policy(files, excluded_folders),
            }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Resolve {
            replica_id,
            record_id,
            r#use,
        }) => (
            ControlCommand::MirrorResolve(MirrorResolveParams {
                replica_id,
                record_id,
                resolution: match r#use {
                    CliMirrorResolution::Local => MirrorResolution::Local,
                    CliMirrorResolution::Hosted => MirrorResolution::Remote,
                },
            }),
            OutputKind::Mirror,
        ),
        ConnectCommand::Mirror(MirrorCommand::Remove { replica_id, yes }) => {
            if !yes {
                return Err(CliError::usage(
                    "Mirror removal revokes its remote replica. Re-run with --yes to confirm.",
                ));
            }
            (
                ControlCommand::MirrorRemove(MirrorIdParams { replica_id }),
                OutputKind::Generic,
            )
        }
        ConnectCommand::Mirror(MirrorCommand::Promote { .. }) => {
            unreachable!("authority promotion is an interactive CLI flow")
        }
        ConnectCommand::Hosted(HostedCommand::List) => {
            (ControlCommand::HostedSnapshot, OutputKind::Generic)
        }
        ConnectCommand::Hosted(HostedCommand::Create { name, timezone }) => (
            ControlCommand::HostedCollectionCreate(HostedCollectionCreateParams {
                name,
                timezone: effective_timezone(timezone)?,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Hosted(HostedCommand::Rename {
            collection_id,
            name,
        }) => (
            ControlCommand::HostedCollectionRename(HostedCollectionRenameParams {
                collection_id,
                name,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Hosted(HostedCommand::Delete { collection_id, yes }) => {
            if !yes {
                return Err(CliError::usage(
                    "Hosted collection deletion is permanent. Re-run with --yes to confirm.",
                ));
            }
            (
                ControlCommand::HostedCollectionDelete(CollectionIdParams { collection_id }),
                OutputKind::Generic,
            )
        }
        ConnectCommand::Operation {
            collection_id,
            operation,
            input,
        } => (
            ControlCommand::CollectionOperation(CollectionOperationParams {
                collection_id,
                operation,
                input: serde_json::from_str::<Value>(&input).map_err(|error| {
                    CliError::usage(format!("--input is not valid JSON: {error}"))
                })?,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::List) => {
            (ControlCommand::AccessSnapshot, OutputKind::Access)
        }
        ConnectCommand::Access(AccessCommand::Pause) => (
            ControlCommand::AccessPause(AccessPauseParams { paused: true }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Resume) => (
            ControlCommand::AccessPause(AccessPauseParams { paused: false }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Approve {
            request_id,
            collection_id,
            operations,
        }) => (
            ControlCommand::AuthorizationApprove(AuthorizationApproveParams {
                request_id,
                collection_id,
                operations,
                contract_setups: Vec::new(),
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Deny { request_id }) => (
            ControlCommand::AuthorizationDeny(AuthorizationIdParams { request_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Update {
            grant_id,
            operations,
        }) => (
            ControlCommand::GrantUpdate(GrantUpdateParams {
                grant_id,
                operations,
            }),
            OutputKind::Generic,
        ),
        ConnectCommand::Access(AccessCommand::Revoke { grant_id }) => (
            ControlCommand::GrantRevoke(GrantIdParams { grant_id }),
            OutputKind::Generic,
        ),
        ConnectCommand::Activity { limit } => (
            ControlCommand::ActivityList(ActivityListParams {
                limit: limit.clamp(1, 500),
            }),
            OutputKind::Activity,
        ),
        ConnectCommand::Daemon(_)
        | ConnectCommand::Doctor
        | ConnectCommand::Login { .. }
        | ConnectCommand::Logout
        | ConnectCommand::Paths => {
            unreachable!("handled before control dispatch")
        }
    };
    Ok(pair)
}

fn selective_sync_policy(
    classes: Vec<CliFileClass>,
    excluded_folders: Vec<String>,
) -> SelectiveSyncPolicy {
    let mut file_classes = Vec::new();
    for class in classes {
        let class = match class {
            CliFileClass::Images => FileMediaClass::Image,
            CliFileClass::Audio => FileMediaClass::Audio,
            CliFileClass::Videos => FileMediaClass::Video,
            CliFileClass::Pdfs => FileMediaClass::Pdf,
            CliFileClass::Other => FileMediaClass::Other,
        };
        if !file_classes.contains(&class) {
            file_classes.push(class);
        }
    }
    SelectiveSyncPolicy {
        file_classes,
        excluded_folders,
    }
}

pub(super) fn path_string(path: PathBuf) -> Result<String, CliError> {
    path.into_os_string()
        .into_string()
        .map_err(|_| CliError::usage("Collection paths must be valid UTF-8."))
}

fn effective_timezone(timezone: Option<String>) -> Result<String, CliError> {
    let timezone = match timezone {
        Some(timezone) => timezone,
        None => iana_time_zone::get_timezone().map_err(|error| {
            CliError::usage(format!(
                "Could not detect this device's IANA timezone ({error}); supply --timezone."
            ))
        })?,
    };
    timezone.parse::<chrono_tz::Tz>().map_err(|_| {
        CliError::usage(format!(
            "--timezone must be an IANA identifier; received '{timezone}'."
        ))
    })?;
    Ok(timezone)
}

pub(super) fn successful_result(response: ControlResponse) -> Result<Value, CliError> {
    if response.protocol_version != LOCAL_CONTROL_PROTOCOL_VERSION {
        return Err(CliError::internal(format!(
            "The daemon uses unsupported local protocol {}; expected {}.",
            response.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION
        )));
    }
    if response.ok {
        return Ok(response.result.unwrap_or(Value::Null));
    }
    let error = response
        .error
        .unwrap_or(mdbase_connect_protocol::ControlError {
            code: "request_failed".to_string(),
            message: "The Connect daemon rejected the request.".to_string(),
            details: None,
        });
    Err(CliError {
        code: error.code,
        message: error.message,
        exit_code: 1,
    })
}
