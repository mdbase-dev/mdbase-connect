use super::*;

impl CollectionRegistry {
    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        ensure_private_state_dir(state_dir.as_ref())?;
        let db_path = state_dir.as_ref().join("connector.sqlite");
        migrations::migrate_registry(&db_path)?;
        let authority = Arc::new(AuthorityStore::open(state_dir.as_ref(), &db_path)?);
        migrations::finalize_authority_split(&db_path)?;
        let registry = Self {
            db_path,
            authority,
            process_epoch: Uuid::new_v4(),
            providers: Arc::new(Mutex::new(HashMap::new())),
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
