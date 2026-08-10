use super::*;
use crate::registry::receipts::ReceiptStore;
use rusqlite::OpenFlags;
use std::collections::VecDeque;
use std::sync::{mpsc, Condvar};
use std::thread;
use std::time::{Duration, Instant};

const AUTHORITY_SCHEMA_VERSION: u32 = 1;
const AUTHORITY_SCHEMA_NAME: &str = "isolated_authority_store";
const AUTHORITY_SCHEMA_CHECKSUM: &str =
    "9130129006fd8b244b969bbbd6588d508e416fc10089df4fd1fe17cf1aca45b2";
const AUTHORITY_SCHEMA_SQL: &str = include_str!("migrations/authority/0001_initial.sql");
const DATA_QUEUE_CAPACITY: usize = 128;
const CONTROL_QUEUE_CAPACITY: usize = 16;
const MAX_CONTROL_BURST: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AuthorityWritePriority {
    Control,
    Recovery,
    Admission,
    Maintenance,
}

impl AuthorityWritePriority {
    fn as_str(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Recovery => "recovery",
            Self::Admission => "admission",
            Self::Maintenance => "maintenance",
        }
    }
}

type WriterJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

struct QueuedJob {
    enqueued_at: Instant,
    priority: AuthorityWritePriority,
    execute: WriterJob,
}

#[derive(Default)]
struct WriterQueues {
    control: VecDeque<QueuedJob>,
    recovery: VecDeque<QueuedJob>,
    admission: VecDeque<QueuedJob>,
    maintenance: VecDeque<QueuedJob>,
    stopping: bool,
}

impl WriterQueues {
    fn data_len(&self) -> usize {
        self.recovery.len() + self.admission.len() + self.maintenance.len()
    }

    fn push(&mut self, job: QueuedJob) -> Result<(), ConnectError> {
        match job.priority {
            AuthorityWritePriority::Control if self.control.len() < CONTROL_QUEUE_CAPACITY => {
                self.control.push_back(job)
            }
            AuthorityWritePriority::Control => return Err(ConnectError::AuthorityOverloaded),
            _ if self.data_len() >= DATA_QUEUE_CAPACITY => {
                return Err(ConnectError::AuthorityOverloaded)
            }
            AuthorityWritePriority::Recovery => self.recovery.push_back(job),
            AuthorityWritePriority::Admission => self.admission.push_back(job),
            AuthorityWritePriority::Maintenance => self.maintenance.push_back(job),
        }
        Ok(())
    }

    fn pop(&mut self, control_burst: &mut usize) -> Option<QueuedJob> {
        if !self.control.is_empty() && (*control_burst < MAX_CONTROL_BURST || self.data_len() == 0)
        {
            *control_burst += 1;
            return self.control.pop_front();
        }
        let job = self
            .recovery
            .pop_front()
            .or_else(|| self.admission.pop_front())
            .or_else(|| self.maintenance.pop_front())
            .or_else(|| self.control.pop_front());
        if job.is_some() {
            *control_burst = 0;
        }
        job
    }

    fn is_empty(&self) -> bool {
        self.control.is_empty()
            && self.recovery.is_empty()
            && self.admission.is_empty()
            && self.maintenance.is_empty()
    }
}

struct AuthorityWriter {
    queues: Arc<(Mutex<WriterQueues>, Condvar)>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

impl AuthorityWriter {
    fn open(path: &Path) -> Result<Self, ConnectError> {
        let connection = open_authority_connection(path, false)?;
        let queues = Arc::new((Mutex::new(WriterQueues::default()), Condvar::new()));
        let worker_queues = queues.clone();
        let thread = thread::Builder::new()
            .name("mdbase-authority-writer".to_string())
            .spawn(move || run_writer(connection, worker_queues))?;
        Ok(Self {
            queues,
            thread: Mutex::new(Some(thread)),
        })
    }

    fn submit<T, F>(
        &self,
        priority: AuthorityWritePriority,
        operation: F,
    ) -> Result<T, ConnectError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, ConnectError> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        let job = QueuedJob {
            enqueued_at: Instant::now(),
            priority,
            execute: Box::new(move |connection| {
                let _ = sender.send(operation(connection));
            }),
        };
        let (queues, available) = &*self.queues;
        let mut queues = queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queues.stopping {
            return Err(ConnectError::AuthorityOverloaded);
        }
        queues.push(job)?;
        available.notify_one();
        drop(queues);
        receiver
            .recv()
            .map_err(|_| ConnectError::AuthorityOverloaded)?
    }
}

impl Drop for AuthorityWriter {
    fn drop(&mut self) {
        let (queues, available) = &*self.queues;
        let mut queues = queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queues.stopping = true;
        available.notify_all();
        drop(queues);
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = thread.join();
        }
    }
}

fn run_writer(mut connection: Connection, queues: Arc<(Mutex<WriterQueues>, Condvar)>) {
    let mut control_burst = 0;
    loop {
        let job = {
            let (state, available) = &*queues;
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while state.is_empty() && !state.stopping {
                state = available
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            if state.stopping && state.is_empty() {
                return;
            }
            state.pop(&mut control_burst)
        };
        let Some(job) = job else {
            continue;
        };
        let queue_us = job
            .enqueued_at
            .elapsed()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64;
        let started = Instant::now();
        (job.execute)(&mut connection);
        let transaction_us = started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
        tracing::debug!(
            target: "mdbase_connect::authority_store",
            priority = job.priority.as_str(),
            queue_us,
            transaction_us,
            "authority write completed"
        );
    }
}

pub(super) struct AuthorityStore {
    db_path: PathBuf,
    writer: AuthorityWriter,
    receipts: ReceiptStore,
}

impl std::fmt::Debug for AuthorityStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorityStore")
            .field("db_path", &self.db_path)
            .field("receipt_root", &self.receipts.root())
            .finish_non_exhaustive()
    }
}

impl AuthorityStore {
    pub(super) fn open(state_dir: &Path, legacy_path: &Path) -> Result<Self, ConnectError> {
        let db_path = state_dir.join("authority.sqlite");
        let receipt_path = state_dir.join("authority-receipts");
        migrate_authority_store(state_dir, legacy_path, &db_path, &receipt_path)?;
        let receipts = ReceiptStore::open(receipt_path)?;
        let writer = AuthorityWriter::open(&db_path)?;
        Ok(Self {
            db_path,
            writer,
            receipts,
        })
    }

    pub(super) fn connection(&self) -> Result<Connection, ConnectError> {
        open_authority_connection(&self.db_path, false)
    }

    pub(super) fn write<T, F>(
        &self,
        priority: AuthorityWritePriority,
        operation: F,
    ) -> Result<T, ConnectError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, ConnectError> + Send + 'static,
    {
        self.writer.submit(priority, operation)
    }

    pub(super) fn store_receipt(&self, receipt: &str) -> Result<String, ConnectError> {
        self.receipts.store(receipt)
    }

    pub(super) fn load_receipt(&self, reference: &str) -> Result<String, ConnectError> {
        self.receipts.load(reference)
    }

    pub(super) fn externalize_metadata(&self, value: &Value) -> Result<Value, ConnectError> {
        self.receipts.externalize_metadata(value)
    }

    pub(super) fn response_from_metadata(
        &self,
        value: &Value,
    ) -> Result<Option<String>, ConnectError> {
        self.receipts.response_from_metadata(value)
    }
}

fn open_authority_connection(path: &Path, read_only: bool) -> Result<Connection, ConnectError> {
    let connection = if read_only {
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    } else {
        Connection::open(path)
    }?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_millis(500))?;
    Ok(connection)
}

fn migrate_authority_store(
    state_dir: &Path,
    legacy_path: &Path,
    authority_path: &Path,
    receipt_path: &Path,
) -> Result<(), ConnectError> {
    migrate_authority_store_with_hook(
        state_dir,
        legacy_path,
        authority_path,
        receipt_path,
        &mut |_| Ok(()),
    )
}

fn migrate_authority_store_with_hook(
    state_dir: &Path,
    legacy_path: &Path,
    authority_path: &Path,
    receipt_path: &Path,
    hook: &mut dyn FnMut(&'static str) -> Result<(), ConnectError>,
) -> Result<(), ConnectError> {
    debug_assert_eq!(
        sha256_hex(AUTHORITY_SCHEMA_SQL.as_bytes()),
        AUTHORITY_SCHEMA_CHECKSUM
    );
    if authority_path.exists() {
        verify_authority_store(authority_path)?;
        if !receipt_path.is_dir() {
            return Err(ConnectError::AuthorityReceipt {
                detail: format!("receipt directory {} is missing", receipt_path.display()),
            });
        }
        sync_directory(state_dir)?;
        return Ok(());
    }

    let temporary = state_dir.join("authority.sqlite.migrating");
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let receipts = ReceiptStore::open(receipt_path.to_path_buf())?;
    let mut connection = open_authority_connection(&temporary, false)?;
    connection.execute_batch(AUTHORITY_SCHEMA_SQL)?;
    hook("after_authority_schema")?;
    connection.execute(
        "ATTACH DATABASE ?1 AS legacy",
        [legacy_path.to_string_lossy().as_ref()],
    )?;
    let policy_revision = legacy_policy_revision(&connection)?;
    let now = current_time_ms();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "INSERT INTO grants SELECT * FROM legacy.grants;
         INSERT INTO grant_crypto_state SELECT * FROM legacy.grant_crypto_state;
         INSERT INTO grant_crypto_requests (
             grant_id, key_id, request_id, request_counter, request_fingerprint,
             replay_class, process_epoch, received_at_ms
         )
         SELECT request.grant_id, request.key_id, request.request_id,
                request.request_counter, request.request_fingerprint,
                CASE WHEN EXISTS (
                    SELECT 1 FROM legacy.mutation_journal mutation
                    WHERE mutation.grant_id = request.grant_id
                      AND mutation.request_id = request.request_id
                ) THEN 'mutation' ELSE 'read' END,
                '',
                COALESCE(CAST(unixepoch(request.received_at) * 1000 AS INTEGER), 0)
         FROM legacy.grant_crypto_requests request;
         INSERT INTO mutation_journal SELECT * FROM legacy.mutation_journal;
         INSERT INTO mutation_journal_tombstones SELECT * FROM legacy.mutation_journal_tombstones;
         INSERT INTO revoked_grant_replay_material SELECT * FROM legacy.revoked_grant_replay_material;
         INSERT INTO authority_settings (key, value, updated_at_ms)
         SELECT key, value, CAST(unixepoch(updated_at) * 1000 AS INTEGER)
         FROM legacy.settings WHERE key = 'access_paused';
         INSERT INTO collection_access_overlays (collection_id, enabled, updated_at_ms)
         SELECT id, enabled, CAST(unixepoch('subsec') * 1000 AS INTEGER)
         FROM legacy.collections;",
    )?;
    transaction.execute(
        "INSERT INTO policy_state (singleton, revision, epoch, applied_at_ms)
         VALUES (1, ?1, 1, ?2)",
        params![policy_revision, now],
    )?;
    transaction.execute(
        "INSERT INTO authority_schema_migrations
         (version, name, checksum, applied_at_ms) VALUES (1, ?1, ?2, ?3)",
        params![AUTHORITY_SCHEMA_NAME, AUTHORITY_SCHEMA_CHECKSUM, now],
    )?;
    transaction.pragma_update(None, "user_version", AUTHORITY_SCHEMA_VERSION)?;
    transaction.commit()?;
    connection.execute_batch("DETACH DATABASE legacy")?;
    hook("after_authority_copy")?;

    externalize_migrated_receipts(&mut connection, &receipts)?;
    hook("after_authority_receipts")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    hook("after_authority_wal")?;
    let quick_check: String =
        connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(ConnectError::RegistryCorrupt {
            path: temporary,
            detail: format!("authority migration quick_check returned {quick_check}"),
        });
    }
    hook("after_authority_verification")?;
    drop(connection);
    fs::rename(&temporary, authority_path)?;
    hook("after_authority_publish")?;
    sync_directory(state_dir)?;
    hook("after_authority_directory_sync")?;
    verify_authority_store(authority_path)
}

fn externalize_migrated_receipts(
    connection: &mut Connection,
    receipts: &ReceiptStore,
) -> Result<(), ConnectError> {
    let rows = {
        let mut statement = connection.prepare(
            "SELECT application_installation_id, grant_id, request_id,
                    result_metadata, final_receipt
             FROM mutation_journal
             WHERE result_metadata IS NOT NULL OR final_receipt IS NOT NULL",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (installation_id, grant_id, request_id, metadata, final_receipt) in rows {
        let metadata = metadata
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()?
            .map(|value| receipts.externalize_metadata(&value))
            .transpose()?
            .map(|value| serde_json::to_string(&value))
            .transpose()?;
        let final_receipt = final_receipt
            .as_deref()
            .map(|receipt| receipts.store(receipt))
            .transpose()?;
        transaction.execute(
            "UPDATE mutation_journal SET result_metadata = ?4, final_receipt = ?5
             WHERE application_installation_id = ?1 AND grant_id = ?2 AND request_id = ?3",
            params![
                installation_id,
                grant_id,
                request_id,
                metadata,
                final_receipt
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn legacy_policy_revision(connection: &Connection) -> Result<String, ConnectError> {
    let mut statement = connection
        .prepare("SELECT id, application_authorization FROM legacy.grants ORDER BY id")?;
    let mut rows = statement.query([])?;
    let mut digest = Sha256::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let authorization: String = row.get(1)?;
        digest.update((id.len() as u64).to_be_bytes());
        digest.update(id.as_bytes());
        digest.update((authorization.len() as u64).to_be_bytes());
        digest.update(authorization.as_bytes());
    }
    Ok(format!(
        "legacy:{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn verify_authority_store(path: &Path) -> Result<(), ConnectError> {
    let connection = open_authority_connection(path, false)?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != AUTHORITY_SCHEMA_VERSION {
        return Err(ConnectError::RegistrySchemaIncompatible {
            path: path.to_path_buf(),
            found: version,
            supported: AUTHORITY_SCHEMA_VERSION,
            detail: "unsupported local authority schema".to_string(),
        });
    }
    let checksum: String = connection.query_row(
        "SELECT checksum FROM authority_schema_migrations WHERE version = 1 AND name = ?1",
        [AUTHORITY_SCHEMA_NAME],
        |row| row.get(0),
    )?;
    if checksum != AUTHORITY_SCHEMA_CHECKSUM {
        return Err(ConnectError::RegistryCorrupt {
            path: path.to_path_buf(),
            detail: "authority migration checksum does not match this build".to_string(),
        });
    }
    connection.pragma_update(None, "journal_mode", "WAL")?;
    let quick_check: String =
        connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(ConnectError::RegistryCorrupt {
            path: path.to_path_buf(),
            detail: format!("authority quick_check returned {quick_check}"),
        });
    }
    Ok(())
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sync_directory(path: &Path) -> Result<(), ConnectError> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn job(priority: AuthorityWritePriority) -> QueuedJob {
        QueuedJob {
            enqueued_at: Instant::now(),
            priority,
            execute: Box::new(|_| {}),
        }
    }

    #[test]
    fn writer_queues_reserve_control_capacity_and_bound_control_bursts() {
        let mut queues = WriterQueues::default();
        for _ in 0..DATA_QUEUE_CAPACITY {
            queues.push(job(AuthorityWritePriority::Admission)).unwrap();
        }
        assert!(matches!(
            queues.push(job(AuthorityWritePriority::Recovery)),
            Err(ConnectError::AuthorityOverloaded)
        ));
        for _ in 0..CONTROL_QUEUE_CAPACITY {
            queues.push(job(AuthorityWritePriority::Control)).unwrap();
        }
        assert!(matches!(
            queues.push(job(AuthorityWritePriority::Control)),
            Err(ConnectError::AuthorityOverloaded)
        ));

        let mut control_burst = 0;
        for _ in 0..MAX_CONTROL_BURST {
            assert_eq!(
                queues.pop(&mut control_burst).unwrap().priority,
                AuthorityWritePriority::Control
            );
        }
        assert_eq!(
            queues.pop(&mut control_burst).unwrap().priority,
            AuthorityWritePriority::Admission
        );
        assert_eq!(
            queues.pop(&mut control_burst).unwrap().priority,
            AuthorityWritePriority::Control
        );
    }

    #[test]
    fn every_authority_publication_phase_is_idempotent_after_interruption() {
        for fault in [
            "after_authority_schema",
            "after_authority_copy",
            "after_authority_receipts",
            "after_authority_wal",
            "after_authority_verification",
            "after_authority_publish",
            "after_authority_directory_sync",
        ] {
            let state = TempDir::new().unwrap();
            let legacy = state.path().join("connector.sqlite");
            super::super::migrations::migrate_registry(&legacy).unwrap();
            let authority = state.path().join("authority.sqlite");
            let receipts = state.path().join("authority-receipts");
            let result = migrate_authority_store_with_hook(
                state.path(),
                &legacy,
                &authority,
                &receipts,
                &mut |point| {
                    if point == fault {
                        Err(ConnectError::AuthorityReceipt {
                            detail: format!("injected process death at {point}"),
                        })
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(result.is_err(), "fault {fault} must stop the first open");
            migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
            migrate_authority_store(state.path(), &legacy, &authority, &receipts).unwrap();
            verify_authority_store(&authority).unwrap();
            assert!(receipts.is_dir(), "fault {fault}");
            assert!(!state.path().join("authority.sqlite.migrating").exists());
        }
    }
}
