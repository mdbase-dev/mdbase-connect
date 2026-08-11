use mdbase_connect_protocol::mutation_operation_identifier;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout_at, Instant as TokioInstant};
use uuid::Uuid;

const DEFAULT_QUEUE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_OPERATION_EXECUTION: Duration = Duration::from_secs(30);
const MAX_RETAINED_KEYED_SEMAPHORES: usize = 128;
pub(crate) const MAX_CONCURRENT_READS: usize = 2;
const MAX_CONCURRENT_BACKGROUND_READS: usize = 1;

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
    mutations_per_grant: usize,
    reads_per_grant: usize,
    background_per_grant: usize,
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
        Self {
            operations,
            // Match the fixed read executor exactly. An extra admitted read
            // would hold a deadline and capacity while queued invisibly on
            // the executor, turning ordinary contention into a late timeout.
            reads: MAX_CONCURRENT_READS,
            // Retain one foreground lane when background polling is active.
            background: MAX_CONCURRENT_BACKGROUND_READS,
            files: 4,
            // A grant can run two reads while retaining one independent
            // mutation lane. Background work gets only one of the read lanes
            // so it cannot occupy all foreground capacity for that grant.
            operations_per_grant: 3,
            mutations_per_grant: 1,
            reads_per_grant: 2,
            background_per_grant: 1,
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
    operation_grants: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    mutation_grants: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    read_grants: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    background_grants: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    file_grants: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    mutation_collections: Mutex<HashMap<Uuid, Weak<Semaphore>>>,
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
        debug_assert!(limits.mutations_per_grant < limits.operations_per_grant);
        debug_assert!(limits.reads_per_grant < limits.operations_per_grant);
        debug_assert!(limits.background_per_grant < limits.reads_per_grant);
        Self {
            limits,
            operations: Arc::new(Semaphore::new(limits.operations)),
            reads: Arc::new(Semaphore::new(limits.reads)),
            background: Arc::new(Semaphore::new(limits.background)),
            files: Arc::new(Semaphore::new(limits.files)),
            operation_grants: Mutex::new(HashMap::new()),
            mutation_grants: Mutex::new(HashMap::new()),
            read_grants: Mutex::new(HashMap::new()),
            background_grants: Mutex::new(HashMap::new()),
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
        let mut permits = Vec::with_capacity(6);

        match request.class {
            WorkClass::File => {
                permits.push(
                    acquire_before(self.file_grant_semaphore(request.grant_id), deadline).await?,
                );
                permits.push(acquire_before(self.files.clone(), deadline).await?);
            }
            WorkClass::Mutation => {
                permits.push(
                    acquire_before(self.mutation_grant_semaphore(request.grant_id), deadline)
                        .await?,
                );
                permits.push(
                    acquire_before(self.operation_grant_semaphore(request.grant_id), deadline)
                        .await?,
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
                    acquire_before(self.read_grant_semaphore(request.grant_id), deadline).await?,
                );
                permits.push(
                    acquire_before(self.operation_grant_semaphore(request.grant_id), deadline)
                        .await?,
                );
                permits.push(acquire_before(self.reads.clone(), deadline).await?);
                permits.push(acquire_before(self.operations.clone(), deadline).await?);
            }
            WorkClass::Background => {
                permits.push(
                    acquire_before(self.background_grant_semaphore(request.grant_id), deadline)
                        .await?,
                );
                permits.push(acquire_before(self.background.clone(), deadline).await?);
                permits.push(
                    acquire_before(self.read_grant_semaphore(request.grant_id), deadline).await?,
                );
                permits.push(
                    acquire_before(self.operation_grant_semaphore(request.grant_id), deadline)
                        .await?,
                );
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

    fn operation_grant_semaphore(&self, grant_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.operation_grants,
            grant_id,
            self.limits.operations_per_grant,
            "admission operation grant lock poisoned",
        )
    }

    fn read_grant_semaphore(&self, grant_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.read_grants,
            grant_id,
            self.limits.reads_per_grant,
            "admission read grant lock poisoned",
        )
    }

    fn mutation_grant_semaphore(&self, grant_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.mutation_grants,
            grant_id,
            self.limits.mutations_per_grant,
            "admission mutation grant lock poisoned",
        )
    }

    fn background_grant_semaphore(&self, grant_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.background_grants,
            grant_id,
            self.limits.background_per_grant,
            "admission background grant lock poisoned",
        )
    }

    fn file_grant_semaphore(&self, grant_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.file_grants,
            grant_id,
            self.limits.files_per_grant,
            "admission file grant lock poisoned",
        )
    }

    fn collection_mutation_semaphore(&self, collection_id: Uuid) -> Arc<Semaphore> {
        keyed_semaphore(
            &self.mutation_collections,
            collection_id,
            1,
            "admission collection lock poisoned",
        )
    }
}

fn keyed_semaphore(
    map: &Mutex<HashMap<Uuid, Weak<Semaphore>>>,
    id: Uuid,
    permits: usize,
    poisoned: &str,
) -> Arc<Semaphore> {
    let mut map = map.lock().expect(poisoned);
    if let Some(semaphore) = map.get(&id).and_then(Weak::upgrade) {
        return semaphore;
    }
    if map.len() >= MAX_RETAINED_KEYED_SEMAPHORES {
        map.retain(|_, semaphore| semaphore.strong_count() > 0);
    }
    let semaphore = Arc::new(Semaphore::new(permits));
    map.insert(id, Arc::downgrade(&semaphore));
    semaphore
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
    let mutation = operation == "batch"
        || input.map_or_else(
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
    fn default_read_limits_match_executor_and_preserve_foreground_capacity() {
        let limits = AdmissionLimits::default();
        assert_eq!(limits.reads, MAX_CONCURRENT_READS);
        assert!(limits.background < limits.reads);
    }

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
            operations_per_grant: 3,
            mutations_per_grant: 1,
            reads_per_grant: 2,
            background_per_grant: 1,
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
    async fn queued_reads_cannot_head_of_line_block_the_same_grants_mutation() {
        let scheduler = Arc::new(AdmissionScheduler::with_limits(limits()));
        let first = scheduler
            .admit(request(1, 1, WorkClass::Foreground))
            .await
            .unwrap();
        let second = scheduler
            .admit(request(1, 1, WorkClass::Foreground))
            .await
            .unwrap();
        let queued_scheduler = scheduler.clone();
        let queued_read = tokio::spawn(async move {
            queued_scheduler
                .admit_before(
                    request(1, 1, WorkClass::Foreground),
                    TokioInstant::now() + Duration::from_secs(1),
                )
                .await
        });
        tokio::task::yield_now().await;

        let mutation = scheduler
            .admit_before(
                request(1, 2, WorkClass::Mutation),
                TokioInstant::now() + Duration::from_millis(20),
            )
            .await
            .unwrap();
        drop(mutation);
        assert!(!queued_read.is_finished());

        drop(first);
        drop(second);
        assert!(queued_read.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn background_work_leaves_same_grant_capacity_for_foreground_reads() {
        let scheduler = Arc::new(AdmissionScheduler::with_limits(limits()));
        let _background = scheduler
            .admit(request(1, 1, WorkClass::Background))
            .await
            .unwrap();
        let queued_scheduler = scheduler.clone();
        let second_background = tokio::spawn(async move {
            queued_scheduler
                .admit_before(
                    request(1, 1, WorkClass::Background),
                    TokioInstant::now() + Duration::from_secs(1),
                )
                .await
        });
        tokio::task::yield_now().await;

        let foreground = scheduler
            .admit_before(
                request(1, 1, WorkClass::Foreground),
                TokioInstant::now() + Duration::from_millis(20),
            )
            .await
            .unwrap();
        assert!(!second_background.is_finished());

        drop(foreground);
        drop(_background);
        assert!(second_background.await.unwrap().is_ok());
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

    #[tokio::test]
    async fn one_grant_has_one_mutation_lane_across_collections() {
        let scheduler = AdmissionScheduler::with_limits(limits());
        let _first = scheduler
            .admit(request(1, 9, WorkClass::Mutation))
            .await
            .unwrap();
        let second = scheduler.admit_before(
            request(1, 10, WorkClass::Mutation),
            TokioInstant::now() + Duration::from_millis(10),
        );
        let other_grant = scheduler.admit_before(
            request(2, 10, WorkClass::Mutation),
            TokioInstant::now() + Duration::from_millis(10),
        );

        assert_eq!(second.await.unwrap_err(), AdmissionError::DeadlineExceeded);
        assert!(other_grant.await.is_ok());
    }

    #[tokio::test]
    async fn keyed_admission_state_is_bounded_across_identity_churn() {
        let scheduler = AdmissionScheduler::with_limits(limits());
        for identity in 1..=(MAX_RETAINED_KEYED_SEMAPHORES as u128 * 4) {
            for class in [
                WorkClass::Mutation,
                WorkClass::Foreground,
                WorkClass::Background,
                WorkClass::File,
            ] {
                drop(
                    scheduler
                        .admit(request(identity, identity, class))
                        .await
                        .unwrap(),
                );
            }
        }

        let operation_grants = scheduler.operation_grants.lock().unwrap();
        let mutation_grants = scheduler.mutation_grants.lock().unwrap();
        let read_grants = scheduler.read_grants.lock().unwrap();
        let background_grants = scheduler.background_grants.lock().unwrap();
        let file_grants = scheduler.file_grants.lock().unwrap();
        let mutation_collections = scheduler.mutation_collections.lock().unwrap();
        assert!(operation_grants.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(mutation_grants.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(read_grants.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(background_grants.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(file_grants.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(mutation_collections.len() <= MAX_RETAINED_KEYED_SEMAPHORES);
        assert!(operation_grants
            .values()
            .all(|entry| entry.strong_count() == 0));
        assert!(mutation_collections
            .values()
            .all(|entry| entry.strong_count() == 0));
        assert!(mutation_grants
            .values()
            .all(|entry| entry.strong_count() == 0));
        assert!(read_grants.values().all(|entry| entry.strong_count() == 0));
        assert!(background_grants
            .values()
            .all(|entry| entry.strong_count() == 0));
        assert!(file_grants.values().all(|entry| entry.strong_count() == 0));
    }

    #[test]
    fn operation_classification_is_conservative_before_decryption() {
        assert_eq!(classify_operation("query", None), WorkClass::Foreground);
        assert_eq!(classify_operation("changes", None), WorkClass::Background);
        assert_eq!(classify_operation("sync", None), WorkClass::Mutation);
        assert_eq!(
            classify_operation("batch", Some(&serde_json::json!({"operations": []}))),
            WorkClass::Mutation
        );
        assert_eq!(
            classify_operation("create", Some(&serde_json::json!({"dry_run": true}))),
            WorkClass::Foreground
        );
    }
}
