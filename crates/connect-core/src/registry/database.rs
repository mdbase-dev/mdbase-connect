use super::*;

/// Open only persisted authority, without initializing collection runtimes or
/// recovering file transfers. Account configuration uses this same migration
/// boundary while a live daemon has already fenced remote admission.
pub(super) fn open_authority_store(state_dir: &Path) -> Result<AuthorityStore, ConnectError> {
    ensure_private_state_dir(state_dir)?;
    let db_path = state_dir.join("connector.sqlite");
    migrations::migrate_registry(&db_path)?;
    let authority = AuthorityStore::open(state_dir, &db_path)?;
    migrations::finalize_authority_split(&db_path)?;
    Ok(authority)
}

impl CollectionRegistry {
    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        let db_path = state_dir.as_ref().join("connector.sqlite");
        let authority = Arc::new(open_authority_store(state_dir.as_ref())?);
        let registry = Self {
            db_path,
            authority,
            process_epoch: Uuid::new_v4(),
            executors: Arc::new(Mutex::new(HashMap::new())),
            runtime_lifecycle: Arc::new(Mutex::new(())),
            runtime_wakeup: mdbase::watch::WatchWakeup::default(),
            file_reconciles: Arc::new(Mutex::new(HashMap::new())),
            file_warmups: Arc::new(Mutex::new(HashMap::new())),
            ephemeral_responses: Arc::new(Mutex::new(
                encrypted_requests::EphemeralResponseCache::default(),
            )),
        };
        registry.recover_file_transfers()?;
        Ok(registry)
    }

    pub(super) fn connection(&self) -> Result<Connection, ConnectError> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }
}
