use mdbase_connect_protocol::mutation_operation_identifier;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout_at, Instant as TokioInstant};
use uuid::Uuid;

const DEFAULT_QUEUE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_OPERATION_EXECUTION: Duration = Duration::from_secs(30);

/// Convert the client's optional absolute deadline into a local, monotonic
/// window. The hint can only shorten the connector's own maximum.
pub(crate) fn execution_timeout(deadline_unix_ms: Option<u64>) -> Duration {
    let Some(deadline_unix_ms) = deadline_unix_ms else {
        return MAX_OPERATION_EXECUTION;
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let remaining_ms = u128::from(deadline_unix_ms).saturating_sub(now_ms);
    Duration::from_millis(remaining_ms.min(MAX_OPERATION_EXECUTION.as_millis()) as u64)
}

pub(crate) fn queue_deadline(deadline_unix_ms: Option<u64>) -> TokioInstant {
    TokioInstant::now() + execution_timeout(deadline_unix_ms).min(DEFAULT_QUEUE_WAIT)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkClass {
    Mutation,
    Foreground,
    Background,
    File,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AdmissionRequest {
    pub grant_id: Uuid,
    pub collection_id: Uuid,
    pub class: WorkClass,
    pub weight_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionError {
    QueueFull,
    DeadlineExceeded,
    Closed,
}

#[derive(Clone, Copy, Debug)]
struct AdmissionLimits {
    operations: usize,
    reads: usize,
    background: usize,
    files: usize,
    operations_per_grant: usize,
    files_per_grant: usize,
    queued: usize,
    queued_per_grant: usize,
    queued_bytes: usize,
    queued_bytes_per_grant: usize,
}

impl Default for AdmissionLimits {
    fn default() -> Self {
        // Collection reads can hold an operation-scoped body snapshot. Keep
        // the desktop memory bound independent of a high core count.
        let operations = 4;
        let reserved_mutations = (operations / 4).max(1);
        Self {
            operations,
            reads: operations - reserved_mutations,
            background: 2.min(operations - reserved_mutations),
            files: 4,
            operations_per_grant: 2,
            files_per_grant: 2,
            queued: 64,
            queued_per_grant: 8,
            queued_bytes: 64 * 1024 * 1024,
            queued_bytes_per_grant: 16 * 1024 * 1024,
        }
    }
}

#[derive(Default)]
struct QueueCounts {
    total: usize,
    by_grant: HashMap<Uuid, usize>,
    bytes: usize,
    bytes_by_grant: HashMap<Uuid, usize>,
}

struct QueueTicket {
    counts: Arc<Mutex<QueueCounts>>,
    grant_id: Uuid,
    weight_bytes: usize,
}

impl QueueTicket {
    fn new(
        counts: Arc<Mutex<QueueCounts>>,
        limits: AdmissionLimits,
        grant_id: Uuid,
        weight_bytes: usize,
    ) -> Result<Self, AdmissionError> {
        let mut state = counts.lock().expect("admission queue lock poisoned");
        let grant_count = state.by_grant.get(&grant_id).copied().unwrap_or(0);
        let grant_bytes = state.bytes_by_grant.get(&grant_id).copied().unwrap_or(0);
        if state.total >= limits.queued
            || grant_count >= limits.queued_per_grant
            || state.bytes.saturating_add(weight_bytes) > limits.queued_bytes
            || grant_bytes.saturating_add(weight_bytes) > limits.queued_bytes_per_grant
        {
            return Err(AdmissionError::QueueFull);
        }
        state.total += 1;
        state.bytes = state.bytes.saturating_add(weight_bytes);
        state.by_grant.insert(grant_id, grant_count + 1);
        state
            .bytes_by_grant
            .insert(grant_id, grant_bytes.saturating_add(weight_bytes));
        drop(state);
        Ok(Self {
            counts,
            grant_id,
            weight_bytes,
        })
    }
}

impl Drop for QueueTicket {
    fn drop(&mut self) {
        let mut state = self.counts.lock().expect("admission queue lock poisoned");
        state.total = state.total.saturating_sub(1);
        state.bytes = state.bytes.saturating_sub(self.weight_bytes);
        if let Some(count) = state.by_grant.get_mut(&self.grant_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.by_grant.remove(&self.grant_id);
            }
        }
        if let Some(bytes) = state.bytes_by_grant.get_mut(&self.grant_id) {
            *bytes = bytes.saturating_sub(self.weight_bytes);
            if *bytes == 0 {
                state.bytes_by_grant.remove(&self.grant_id);
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct AdmissionPermit {
    _permits: Vec<OwnedSemaphorePermit>,
    pub queue_wait_us: u64,
}

pub(crate) struct AdmissionScheduler {
    limits: AdmissionLimits,
    operations: Arc<Semaphore>,
    reads: Arc<Semaphore>,
    background: Arc<Semaphore>,
    files: Arc<Semaphore>,
    operation_grants: Mutex<HashMap<Uuid, Arc<Semaphore>>>,
    file_grants: Mutex<HashMap<Uuid, Arc<Semaphore>>>,
    mutation_collections: Mutex<HashMap<Uuid, Arc<Semaphore>>>,
    queue_counts: Arc<Mutex<QueueCounts>>,
}

impl Default for AdmissionScheduler {
    fn default() -> Self {
        Self::with_limits(AdmissionLimits::default())
    }
}

impl AdmissionScheduler {
    fn with_limits(limits: AdmissionLimits) -> Self {
        debug_assert!(limits.reads < limits.operations);
        Self {
            limits,
            operations: Arc::new(Semaphore::new(limits.operations)),
            reads: Arc::new(Semaphore::new(limits.reads)),
            background: Arc::new(Semaphore::new(limits.background)),
            files: Arc::new(Semaphore::new(limits.files)),
            operation_grants: Mutex::new(HashMap::new()),
            file_grants: Mutex::new(HashMap::new()),
            mutation_collections: Mutex::new(HashMap::new()),
            queue_counts: Arc::new(Mutex::new(QueueCounts::default())),
        }
    }

    pub async fn admit(
        &self,
        request: AdmissionRequest,
    ) -> Result<AdmissionPermit, AdmissionError> {
        self.admit_before(request, TokioInstant::now() + DEFAULT_QUEUE_WAIT)
            .await
    }

    pub async fn admit_before(
        &self,
        request: AdmissionRequest,
        deadline: TokioInstant,
    ) -> Result<AdmissionPermit, AdmissionError> {
        let started = Instant::now();
        let ticket = QueueTicket::new(
            self.queue_counts.clone(),
            self.limits,
            request.grant_id,
            request.weight_bytes,
        )?;
        let mut permits = Vec::with_capacity(4);

        match request.class {
            WorkClass::File => {
                permits.push(
                    acquire_before(self.grant_semaphore(request.grant_id, true), deadline).await?,
                );
                permits.push(acquire_before(self.files.clone(), deadline).await?);
            }
            WorkClass::Mutation => {
                permits.push(
                    acquire_before(self.grant_semaphore(request.grant_id, false), deadline).await?,
                );
                permits.push(
                    acquire_before(
                        self.collection_mutation_semaphore(request.collection_id),
                        deadline,
                    )
                    .await?,
                );
                permits.push(acquire_before(self.operations.clone(), deadline).await?);
            }
            WorkClass::Foreground => {
                permits.push(
                    acquire_before(self.grant_semaphore(request.grant_id, false), deadline).await?,
                );
                permits.push(acquire_before(self.reads.clone(), deadline).await?);
                permits.push(acquire_before(self.operations.clone(), deadline).await?);
            }
            WorkClass::Background => {
                permits.push(
                    acquire_before(self.grant_semaphore(request.grant_id, false), deadline).await?,
                );
                permits.push(acquire_before(self.background.clone(), deadline).await?);
                permits.push(acquire_before(self.reads.clone(), deadline).await?);
                permits.push(acquire_before(self.operations.clone(), deadline).await?);
            }
        }
        drop(ticket);
        Ok(AdmissionPermit {
            _permits: permits,
            queue_wait_us: started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
        })
    }

    fn grant_semaphore(&self, grant_id: Uuid, file: bool) -> Arc<Semaphore> {
        let (map, permits) = if file {
            (&self.file_grants, self.limits.files_per_grant)
        } else {
            (&self.operation_grants, self.limits.operations_per_grant)
        };
        let mut map = map.lock().expect("admission grant lock poisoned");
        map.entry(grant_id)
            .or_insert_with(|| Arc::new(Semaphore::new(permits)))
            .clone()
    }

    fn collection_mutation_semaphore(&self, collection_id: Uuid) -> Arc<Semaphore> {
        let mut map = self
            .mutation_collections
            .lock()
            .expect("admission collection lock poisoned");
        map.entry(collection_id)
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }
}

async fn acquire_before(
    semaphore: Arc<Semaphore>,
    deadline: TokioInstant,
) -> Result<OwnedSemaphorePermit, AdmissionError> {
    timeout_at(deadline, semaphore.acquire_owned())
        .await
        .map_err(|_| AdmissionError::DeadlineExceeded)?
        .map_err(|_| AdmissionError::Closed)
}

pub(crate) fn classify_operation(operation: &str, input: Option<&Value>) -> WorkClass {
    let mutation = input.map_or_else(
        || conservative_mutation_operation(operation),
        |input| mutation_operation_identifier(operation, input).is_some(),
    );
    if mutation {
        WorkClass::Mutation
    } else if matches!(operation, "changes" | "list_timers") {
        WorkClass::Background
    } else {
        WorkClass::Foreground
    }
}

fn conservative_mutation_operation(operation: &str) -> bool {
    matches!(
        operation,
        "batch"
            | "file_control"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
            | "create"
            | "update"
            | "delete"
            | "rename"
            | "create_type"
            | "update_type"
            | "apply_type_pack"
            | "apply_collection_setup"
            | "put_timer"
            | "cancel_timer"
            | "reconcile_timers"
            | "sync"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_deadlines_only_shorten_the_connector_window() {
        assert_eq!(execution_timeout(None), MAX_OPERATION_EXECUTION);
        assert_eq!(execution_timeout(Some(1)), Duration::ZERO);
        let far_future = u64::MAX;
        assert_eq!(execution_timeout(Some(far_future)), MAX_OPERATION_EXECUTION);
    }
    use std::time::Duration;

    fn limits() -> AdmissionLimits {
        AdmissionLimits {
            operations: 4,
            reads: 3,
            background: 1,
            files: 2,
            operations_per_grant: 2,
            files_per_grant: 1,
            queued: 8,
            queued_per_grant: 4,
            queued_bytes: 1024,
            queued_bytes_per_grant: 512,
        }
    }

    fn request(grant: u128, collection: u128, class: WorkClass) -> AdmissionRequest {
        AdmissionRequest {
            grant_id: Uuid::from_u128(grant),
            collection_id: Uuid::from_u128(collection),
            class,
            weight_bytes: 1,
        }
    }

    #[tokio::test]
    async fn one_grant_cannot_consume_another_grants_capacity() {
        let scheduler = AdmissionScheduler::with_limits(limits());
        let _first = scheduler
            .admit(request(1, 1, WorkClass::Foreground))
            .await
            .unwrap();
        let _second = scheduler
            .admit(request(1, 1, WorkClass::Foreground))
            .await
            .unwrap();
        let blocked = scheduler.admit_before(
            request(1, 1, WorkClass::Foreground),
            TokioInstant::now() + Duration::from_millis(10),
        );
        let other = scheduler.admit_before(
            request(2, 1, WorkClass::Foreground),
            TokioInstant::now() + Duration::from_millis(10),
        );
        assert_eq!(blocked.await.unwrap_err(), AdmissionError::DeadlineExceeded);
        assert!(other.await.is_ok());
    }

    #[tokio::test]
    async fn queued_envelopes_are_bounded_by_bytes_per_grant() {
        let mut limits = limits();
        limits.operations = 2;
        limits.reads = 1;
        limits.operations_per_grant = 1;
        limits.queued_bytes = 16;
        limits.queued_bytes_per_grant = 8;
        let scheduler = Arc::new(AdmissionScheduler::with_limits(limits));
        let mut running = request(1, 1, WorkClass::Foreground);
        running.weight_bytes = 8;
        let _permit = scheduler.admit(running).await.unwrap();

        let mut too_large = request(1, 1, WorkClass::Foreground);
        too_large.weight_bytes = 9;
        assert_eq!(
            scheduler
                .admit_before(too_large, TokioInstant::now() + Duration::from_millis(20))
                .await
                .unwrap_err(),
            AdmissionError::QueueFull
        );
    }

    #[tokio::test]
    async fn reads_leave_reserved_capacity_for_mutations() {
        let scheduler = AdmissionScheduler::with_limits(limits());
        let _reads = futures_util::future::join_all(
            (1..=3).map(|grant| scheduler.admit(request(grant, grant, WorkClass::Foreground))),
        )
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
        let mutation = scheduler.admit_before(
            request(4, 4, WorkClass::Mutation),
            TokioInstant::now() + Duration::from_millis(10),
        );
        assert!(mutation.await.is_ok());
    }

    #[tokio::test]
    async fn mutations_are_serialized_per_collection() {
        let scheduler = AdmissionScheduler::with_limits(limits());
        let _first = scheduler
            .admit(request(1, 9, WorkClass::Mutation))
            .await
            .unwrap();
        let second = scheduler.admit_before(
            request(2, 9, WorkClass::Mutation),
            TokioInstant::now() + Duration::from_millis(10),
        );
        assert_eq!(second.await.unwrap_err(), AdmissionError::DeadlineExceeded);
        assert!(scheduler
            .admit_before(
                request(2, 10, WorkClass::Mutation),
                TokioInstant::now() + Duration::from_millis(10),
            )
            .await
            .is_ok());
    }

    #[test]
    fn operation_classification_is_conservative_before_decryption() {
        assert_eq!(classify_operation("query", None), WorkClass::Foreground);
        assert_eq!(classify_operation("changes", None), WorkClass::Background);
        assert_eq!(classify_operation("sync", None), WorkClass::Mutation);
        assert_eq!(
            classify_operation("create", Some(&serde_json::json!({"dry_run": true}))),
            WorkClass::Foreground
        );
    }
}
