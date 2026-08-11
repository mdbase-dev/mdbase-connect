use super::*;

pub(super) struct MirrorOperationState {
    pub(super) kind: &'static str,
    pub(super) started_at: Instant,
    pub(super) warned_slow: bool,
}

pub(super) struct MirrorOperationGuard<'a> {
    pub(super) replica_id: Uuid,
    pub(super) syncing: &'a StdMutex<HashMap<Uuid, MirrorOperationState>>,
    pub(super) operation_finished: &'a Notify,
}

pub(super) struct BackgroundRetry {
    pub(super) failures: u32,
    pub(super) at: Instant,
}

impl Default for BackgroundRetry {
    fn default() -> Self {
        Self {
            failures: 0,
            at: Instant::now(),
        }
    }
}

impl Drop for MirrorOperationGuard<'_> {
    fn drop(&mut self) {
        let state = self
            .syncing
            .lock()
            .expect("mirror sync lock poisoned")
            .remove(&self.replica_id);
        if let Some(state) = state {
            tracing::debug!(
                replica_id = %self.replica_id,
                operation = state.kind,
                elapsed_ms = u64::try_from(state.started_at.elapsed().as_millis())
                    .unwrap_or(u64::MAX),
                "hosted mirror operation finished"
            );
        }
        self.operation_finished.notify_one();
    }
}

pub(super) async fn with_mirror_operation_timeout<T, F>(
    timeout: Duration,
    operation: F,
) -> Result<T, ConnectError>
where
    F: Future<Output = Result<T, ConnectError>>,
{
    tokio::time::timeout(timeout, operation).await.map_err(|_| {
        mirror_error(
            "mirror_sync_timeout",
            "Hosted mirror synchronization exceeded its bounded operation deadline and will resume from its durable checkpoint.",
        )
    })?
}

pub(super) fn read_registry(path: &Path) -> Result<Vec<MirrorRegistryEntry>, ConnectError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ConnectError::Io(error)),
    };
    let registry = serde_json::from_slice::<MirrorRegistryFile>(&bytes)?;
    if registry.version != 2 {
        return Err(mirror_error(
            "invalid_mirror_registry",
            "Mirror registry version is not supported.",
        ));
    }
    let mut paths = Vec::<PathBuf>::new();
    let mut replica_ids = HashSet::new();
    let mut enrollment_ids = HashSet::new();
    for entry in &registry.mirrors {
        validate_selective_sync_policy(&entry.selective_sync).map_err(from_mirror)?;
        if !entry.path.is_absolute()
            || paths
                .iter()
                .any(|existing| paths_overlap(existing, &entry.path))
            || !replica_ids.insert(entry.replica_id)
            || !enrollment_ids.insert(entry.enrollment_id)
        {
            return Err(mirror_error(
                "invalid_mirror_registry",
                "Mirror registry contains a duplicate identity or invalid path.",
            ));
        }
        HttpSyncTransport::new(&entry.sync_url, "registry-validation").map_err(from_mirror)?;
        validate_control_origin(&entry.control_url)?;
        if entry.name.trim().is_empty()
            || entry.name.chars().count() > 200
            || chrono::DateTime::parse_from_rfc3339(&entry.access_token_expires_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&entry.created_at).is_err()
        {
            return Err(mirror_error(
                "invalid_mirror_registry",
                "Mirror registry contains invalid metadata.",
            ));
        }
        paths.push(entry.path.clone());
    }
    Ok(registry.mirrors)
}

pub(super) fn write_registry(
    path: &Path,
    entries: &[MirrorRegistryEntry],
) -> Result<(), ConnectError> {
    let parent = path.parent().ok_or_else(|| {
        mirror_error(
            "invalid_mirror_registry",
            "Mirror registry path is invalid.",
        )
    })?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(&MirrorRegistryFile {
        version: 2,
        mirrors: entries.to_vec(),
    })?)?;
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn default_lock_root(state_dir: &Path) -> PathBuf {
    directories::ProjectDirs::from("dev", "mdbase", "connect")
        .map(|directories| directories.data_local_dir().join("mirror-locks"))
        .unwrap_or_else(|| state_dir.join("mirror-locks"))
}

pub(super) fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

pub(super) fn background_retry_delay(replica_id: Uuid, failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(6);
    let base_millis = SYNC_INTERVAL
        .as_millis()
        .saturating_mul(1_u128 << exponent)
        .min(MAX_BACKGROUND_BACKOFF.as_millis());
    let seed = replica_id
        .as_bytes()
        .iter()
        .fold(failures as u64, |value, byte| {
            value
                .wrapping_mul(1_099_511_628_211)
                .wrapping_add(*byte as u64)
        });
    let jitter_percent = 80 + seed % 41;
    let millis = base_millis
        .saturating_mul(jitter_percent as u128)
        .saturating_div(100)
        .min(MAX_BACKGROUND_BACKOFF.as_millis());
    Duration::from_millis(millis as u64)
}

pub(super) fn terminal_background_error(error: &ConnectError) -> bool {
    matches!(
        error.code(),
        "mirror_state_upgrade_required" | "credential_store_unavailable"
    )
}

pub(super) fn computer_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "This computer".to_string())
}

pub(super) fn valid_pairing_secret(value: &str) -> bool {
    value.starts_with("mir_") && value.len() >= 24 && !value.chars().any(char::is_whitespace)
}

pub(super) fn validate_transfer(
    transfer: &AuthorityTransfer,
    entry: &MirrorRegistryEntry,
    expected_transfer_id: Option<Uuid>,
) -> Result<(), ConnectError> {
    if transfer.collection_id != entry.collection_id
        || transfer.replica_id != entry.replica_id
        || expected_transfer_id.is_some_and(|expected| transfer.id != expected)
    {
        return Err(mirror_error(
            "invalid_authority_transfer",
            "Authority transfer does not match this mirror.",
        ));
    }
    Ok(())
}

pub(super) fn trusted_control_url(
    control_url: &str,
    candidate: &str,
) -> Result<String, ConnectError> {
    validate_control_origin(control_url)?;
    let control = url::Url::parse(control_url)
        .map_err(|_| mirror_error("invalid_control_url", "Mirror control origin is invalid."))?;
    let candidate = url::Url::parse(candidate).map_err(|_| {
        mirror_error(
            "invalid_verification_url",
            "Authority verification address is invalid.",
        )
    })?;
    if control.origin() != candidate.origin()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
    {
        return Err(mirror_error(
            "untrusted_verification_url",
            "Authority returned a verification address on another origin.",
        ));
    }
    Ok(candidate.to_string())
}

pub(super) fn validate_control_origin(control_url: &str) -> Result<(), ConnectError> {
    let control = url::Url::parse(control_url)
        .map_err(|_| mirror_error("invalid_control_url", "Mirror control origin is invalid."))?;
    let loopback = matches!(control.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let secure = control.scheme() == "https" || (control.scheme() == "http" && loopback);
    if control.host_str().is_none()
        || !secure
        || !control.username().is_empty()
        || control.password().is_some()
        || !matches!(control.path(), "" | "/")
        || control.query().is_some()
        || control.fragment().is_some()
    {
        return Err(mirror_error(
            "invalid_control_url",
            "Mirror control origin must use HTTPS without credentials, a path, or a query.",
        ));
    }
    Ok(())
}

pub(super) fn parse_deadline(value: &str) -> Result<chrono::DateTime<chrono::Utc>, ConnectError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&chrono::Utc))
        .map_err(|_| {
            mirror_error(
                "invalid_authority_transfer",
                "Authority transfer expiry is invalid.",
            )
        })
}

pub(super) async fn checked_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ConnectError> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ConnectError::Cloud(error.to_string()))?;
    if !status.is_success() {
        let value = serde_json::from_slice::<Value>(&bytes).ok();
        let code = value
            .as_ref()
            .and_then(|value| value.pointer("/error/code"))
            .and_then(Value::as_str)
            .unwrap_or("authority_transfer_failed");
        let message = value
            .as_ref()
            .and_then(|value| value.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("Authority transfer request failed.");
        return Err(mirror_error(code, message));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        mirror_error(
            "invalid_authority_transfer",
            &format!("Authority transfer response is invalid: {error}"),
        )
    })
}

pub(super) fn mirror_error(code: &str, message: &str) -> ConnectError {
    ConnectError::Mirror {
        code: code.to_string(),
        message: message.to_string(),
    }
}

pub(super) fn from_mirror(error: MirrorError) -> ConnectError {
    ConnectError::Mirror {
        code: error.code,
        message: error.message,
    }
}
