use super::*;
impl CollectionRegistry {
    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        ensure_private_state_dir(state_dir.as_ref())?;
        let registry = Self {
            db_path: state_dir.as_ref().join("connector.sqlite"),
            providers: Arc::new(Mutex::new(HashMap::new())),
            file_reconciles: Arc::new(Mutex::new(HashMap::new())),
            encrypted_request_writes: Arc::new(Mutex::new(())),
        };
        registry.migrate()?;
        registry.recover_file_transfers()?;
        Ok(registry)
    }

    pub(super) fn connection(&self) -> Result<Connection, ConnectError> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }

    fn migrate(&self) -> Result<(), ConnectError> {
        self.connection()?.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                description TEXT,
                spec_version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS grants (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                operations TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}',
                application_name TEXT NOT NULL DEFAULT 'Application',
                application_distribution TEXT NOT NULL DEFAULT 'web',
                application_homepage TEXT NOT NULL DEFAULT '',
                application_project_url TEXT,
                application_origin TEXT NOT NULL DEFAULT '',
                application_icon TEXT,
                collection_name TEXT NOT NULL DEFAULT 'Collection',
                notification_criteria TEXT NOT NULL DEFAULT '[]',
                encryption TEXT,
                file_capability TEXT,
                first_contact TEXT NOT NULL,
                application_authorization TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS activity (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                application_name TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                collection_name TEXT NOT NULL,
                operation TEXT NOT NULL,
                outcome TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS collection_changes (
                collection_id TEXT NOT NULL,
                cursor INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (collection_id, cursor),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_collections (
                collection_id TEXT PRIMARY KEY,
                head INTEGER NOT NULL DEFAULT 0,
                retained_after INTEGER NOT NULL DEFAULT 0,
                resource_revision TEXT NOT NULL,
                authority_epoch INTEGER NOT NULL DEFAULT 1,
                authority_state TEXT NOT NULL DEFAULT 'active',
                transfer_id TEXT,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_records (
                collection_id TEXT NOT NULL,
                record_id TEXT NOT NULL,
                path TEXT NOT NULL,
                revision TEXT NOT NULL,
                record TEXT NOT NULL,
                PRIMARY KEY (collection_id, record_id),
                UNIQUE (collection_id, path),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_changes (
                collection_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                record_id TEXT NOT NULL,
                before_record TEXT,
                after_record TEXT,
                revision TEXT NOT NULL,
                PRIMARY KEY (collection_id, sequence),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_files (
                collection_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                path TEXT NOT NULL,
                path_key TEXT NOT NULL,
                revision TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                size INTEGER NOT NULL,
                media_type TEXT,
                media_class TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                physical_device TEXT,
                physical_file TEXT,
                PRIMARY KEY (collection_id, file_id),
                UNIQUE (collection_id, path_key),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_file_changes (
                collection_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                file_id TEXT NOT NULL,
                before_file TEXT,
                after_file TEXT,
                revision TEXT NOT NULL,
                PRIMARY KEY (collection_id, sequence),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_file_inventory_state (
                collection_id TEXT PRIMARY KEY,
                observed_generation INTEGER NOT NULL DEFAULT 1,
                reconciled_generation INTEGER NOT NULL DEFAULT 0,
                index_revision INTEGER NOT NULL DEFAULT 0,
                reconciled_at_ms INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_file_transfers (
                transfer_id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
                state TEXT NOT NULL CHECK (state IN ('open', 'committing', 'committed', 'aborted', 'expired')),
                file_id TEXT NOT NULL,
                path TEXT NOT NULL,
                path_key TEXT NOT NULL,
                expected_size INTEGER NOT NULL,
                expected_digest TEXT NOT NULL,
                media_type TEXT,
                base_revision TEXT,
                chunk_size INTEGER NOT NULL,
                staging_path TEXT,
                receipt TEXT,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_file_transfer_chunks (
                transfer_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                chunk_digest TEXT NOT NULL,
                byte_length INTEGER NOT NULL,
                PRIMARY KEY (transfer_id, chunk_index),
                FOREIGN KEY (transfer_id) REFERENCES collection_file_transfers(transfer_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS collection_file_mutations (
                mutation_id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('move', 'delete')),
                request TEXT NOT NULL,
                planned_receipt TEXT NOT NULL,
                receipt TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_replicas (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                name TEXT NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('read_only', 'read_write')),
                allowed_types TEXT NOT NULL DEFAULT '[]',
                scope_epoch INTEGER NOT NULL DEFAULT 1,
                revoked INTEGER NOT NULL DEFAULT 0,
                acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_snapshots (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                replica_id TEXT NOT NULL,
                scope_epoch INTEGER NOT NULL,
                cursor INTEGER NOT NULL,
                records TEXT NOT NULL,
                files TEXT NOT NULL DEFAULT '[]',
                expires_at TEXT NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (replica_id) REFERENCES local_sync_replicas(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_receipts (
                replica_id TEXT NOT NULL,
                mutation_id TEXT NOT NULL,
                receipt TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (replica_id, mutation_id),
                FOREIGN KEY (replica_id) REFERENCES local_sync_replicas(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS local_sync_changes_collection_idx
                ON local_sync_changes(collection_id, sequence);
            CREATE INDEX IF NOT EXISTS collection_file_changes_collection_idx
                ON collection_file_changes(collection_id, sequence);
            CREATE INDEX IF NOT EXISTS collection_files_digest_idx
                ON collection_files(collection_id, content_digest);
            CREATE INDEX IF NOT EXISTS collection_files_path_idx
                ON collection_files(collection_id, path);
            CREATE INDEX IF NOT EXISTS collection_file_transfers_collection_idx
                ON collection_file_transfers(collection_id, state, expires_at);
            CREATE INDEX IF NOT EXISTS local_sync_snapshots_expiry_idx
                ON local_sync_snapshots(expires_at);
            CREATE TABLE IF NOT EXISTS grant_crypto_state (
                grant_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                last_request_counter TEXT NOT NULL,
                reorder_floor TEXT NOT NULL DEFAULT '0',
                PRIMARY KEY (grant_id, key_id)
            );
            CREATE TABLE IF NOT EXISTS grant_crypto_requests (
                grant_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                request_counter TEXT NOT NULL DEFAULT '',
                request_fingerprint TEXT NOT NULL DEFAULT '',
                response_envelope TEXT,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (grant_id, key_id, request_id)
            );
            CREATE TABLE IF NOT EXISTS application_trusts (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                application_installation_id TEXT NOT NULL,
                connector_id TEXT NOT NULL,
                binding TEXT NOT NULL,
                presentation TEXT NOT NULL,
                trusted_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                UNIQUE (application_id, application_installation_id, connector_id)
            );
            CREATE TABLE IF NOT EXISTS pending_application_trusts (
                request_id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                application_installation_id TEXT NOT NULL,
                connector_id TEXT NOT NULL,
                request TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS pending_application_trusts_expiry_idx
                ON pending_application_trusts(expires_at);
            CREATE INDEX IF NOT EXISTS pending_application_trusts_identity_idx
                ON pending_application_trusts(
                    application_id,
                    application_installation_id,
                    connector_id
                );
            ",
        )?;
        // These upgrades preserve registries created by the first development MVP.
        let connection = self.connection()?;
        for migration in [
            "ALTER TABLE grants ADD COLUMN application_name TEXT NOT NULL DEFAULT 'Application'",
            "ALTER TABLE grants ADD COLUMN application_distribution TEXT NOT NULL DEFAULT 'web'",
            "ALTER TABLE grants ADD COLUMN application_homepage TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_project_url TEXT",
            "ALTER TABLE grants ADD COLUMN application_origin TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_icon TEXT",
            "ALTER TABLE grants ADD COLUMN collection_name TEXT NOT NULL DEFAULT 'Collection'",
            "ALTER TABLE grants ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN scope TEXT NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}'",
            "ALTER TABLE grants ADD COLUMN encryption TEXT",
            "ALTER TABLE grants ADD COLUMN file_capability TEXT",
            "ALTER TABLE grants ADD COLUMN first_contact TEXT",
            "ALTER TABLE grants ADD COLUMN application_authorization TEXT",
            "ALTER TABLE grants ADD COLUMN notification_criteria TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE collection_file_transfers ADD COLUMN owner_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'",
            "ALTER TABLE collections ADD COLUMN description TEXT",
            "ALTER TABLE grant_crypto_state ADD COLUMN reorder_floor TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN counter TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_counter TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN response_envelope TEXT",
            "ALTER TABLE local_sync_collections ADD COLUMN authority_state TEXT NOT NULL DEFAULT 'active'",
            "ALTER TABLE local_sync_collections ADD COLUMN transfer_id TEXT",
            "ALTER TABLE local_sync_snapshots ADD COLUMN files TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE collection_file_mutations ADD COLUMN planned_receipt TEXT NOT NULL DEFAULT ''",
        ] {
            if let Err(error) = connection.execute(migration, []) {
                if !error.to_string().contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
        connection.execute(
            "DELETE FROM grants WHERE json_extract(scope, '$.access') IS NULL",
            [],
        )?;
        // First-contact trust is a deliberate pre-release protocol break. Old local grants have
        // no app-signed installation binding and cannot be upgraded safely; they must be
        // authorized again through the normal portal flow.
        connection.execute(
            "DELETE FROM grants
             WHERE first_contact IS NULL OR application_authorization IS NULL",
            [],
        )?;
        // Registries created before the bounded replay window cannot safely distinguish a fresh
        // out-of-order counter from one accepted before counters were recorded. Start their
        // reorder window above the previous high-water mark; new keys start at zero.
        connection.execute(
            "UPDATE grant_crypto_state
             SET reorder_floor = last_request_counter
             WHERE reorder_floor IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE grant_crypto_requests SET request_counter = counter
             WHERE request_counter = '' AND counter IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS grant_crypto_requests_request_counter
             ON grant_crypto_requests (grant_id, key_id, request_counter)
             WHERE request_counter <> ''",
            [],
        )?;
        Ok(())
    }
}
