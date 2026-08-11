use super::*;
use mdbase::runtime::{
    ChangeFeed, ChangeFeedOwnerId, ChangeWatermark, CollectionProvider, FilesystemProvider,
    FilesystemRuntime, OperationContext, RuntimeChangeEventPage,
};
use std::num::NonZeroUsize;
use std::sync::Condvar;
use std::time::{Duration, Instant};

const FOREGROUND_READ_CAPACITY: usize = 4;
const BACKGROUND_CAPACITY: usize = 1;
const WAIT_SLICE: Duration = Duration::from_millis(10);
const MAX_EXTERNAL_READ_CURSORS: usize = 4_096;

pub(super) struct CoordinatedReadPage {
    pub result: mdbase::v03::OperationResult,
    pub next: Option<String>,
}

#[derive(Default)]
struct ReadCursorState {
    cursors: HashMap<String, HostedReadCursor>,
}

#[derive(Clone)]
struct HostedReadCursor {
    runtime: mdbase::runtime::ReadCursor,
    lease_id: Uuid,
    scope_binding: String,
    next_external: Option<Option<String>>,
}

/// The collection-local scheduling and lifecycle owner around one mdbase runtime.
pub(super) struct CollectionExecutor {
    runtime: Option<Arc<FilesystemRuntime>>,
    provider: Arc<FilesystemProvider>,
    mutation: PermitPool,
    foreground: PermitPool,
    background: PermitPool,
    feed: Mutex<Option<ChangeFeed>>,
    read_cursors: Mutex<ReadCursorState>,
    last_used: Mutex<Instant>,
}

impl std::fmt::Debug for CollectionExecutor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CollectionExecutor")
            .field("root", &self.provider.root())
            .field("coordinated", &self.runtime.is_some())
            .finish_non_exhaustive()
    }
}

impl CollectionExecutor {
    pub(super) fn open(
        root: &Path,
        owner: &ChangeFeedOwnerId,
        coordinated: bool,
    ) -> Result<Self, ConnectError> {
        let (runtime, provider, feed) = if coordinated {
            let runtime = Arc::new(FilesystemRuntime::open(root, Duration::from_millis(120))?);
            let context = OperationContext::new(
                &mdbase::OperationCancellation::new(),
                mdbase::runtime::OperationDeadline::after(Duration::from_secs(30)),
            );
            let feed = runtime.open_change_feed(owner, &context)?;
            runtime.establish_change_feed_baseline(&feed, &context)?;
            let provider = runtime.provider();
            (Some(runtime), provider, Some(feed))
        } else {
            (None, Arc::new(FilesystemProvider::open(root)?), None)
        };
        Ok(Self {
            runtime,
            provider,
            mutation: PermitPool::new(1),
            foreground: PermitPool::new(FOREGROUND_READ_CAPACITY),
            background: PermitPool::new(BACKGROUND_CAPACITY),
            feed: Mutex::new(feed),
            read_cursors: Mutex::new(ReadCursorState::default()),
            last_used: Mutex::new(Instant::now()),
        })
    }

    pub(super) fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    pub(super) fn last_used(&self) -> Instant {
        self.last_used
            .lock()
            .map(|last_used| *last_used)
            .unwrap_or_else(|poisoned| **poisoned.get_ref())
    }

    pub(super) fn measurements(
        &self,
    ) -> Result<mdbase::runtime::RuntimeMeasurements, ConnectError> {
        match &self.runtime {
            Some(runtime) => runtime.measurements().map_err(Into::into),
            None => Ok(mdbase::runtime::RuntimeMeasurements::default()),
        }
    }

    pub(super) fn is_evictable(&self) -> bool {
        match self.measurements() {
            Ok(measurements) if measurements.active_read_snapshots == 0 => {
                if let Ok(mut cursors) = self.read_cursors.lock() {
                    cursors.cursors.clear();
                }
                true
            }
            _ => false,
        }
    }

    pub(super) fn runtime(&self) -> Result<Arc<FilesystemRuntime>, ConnectError> {
        self.runtime.clone().ok_or_else(|| {
            ConnectError::UnsupportedOperation(
                "the legacy collection has no coordinated runtime".to_string(),
            )
        })
    }

    pub(super) fn provider(&self) -> Arc<FilesystemProvider> {
        self.provider.clone()
    }

    pub(super) fn is_coordinated(&self) -> bool {
        self.runtime.is_some()
    }

    pub(super) fn with_mutation<T>(
        &self,
        context: &OperationContext,
        operation: impl FnOnce(Option<&FilesystemRuntime>) -> Result<T, ConnectError>,
    ) -> Result<T, ConnectError> {
        self.touch();
        let _permit = self.mutation.acquire(context)?;
        operation(self.runtime.as_deref())
    }

    pub(super) fn with_foreground<T>(
        &self,
        context: &OperationContext,
        operation: impl FnOnce(Option<&FilesystemRuntime>) -> Result<T, ConnectError>,
    ) -> Result<T, ConnectError> {
        self.touch();
        let _permit = self.foreground.acquire(context)?;
        operation(self.runtime.as_deref())
    }

    pub(super) fn with_background<T>(
        &self,
        context: &OperationContext,
        operation: impl FnOnce(Option<&FilesystemRuntime>) -> Result<T, ConnectError>,
    ) -> Result<T, ConnectError> {
        let _permit = self.background.acquire(context)?;
        operation(self.runtime.as_deref())
    }

    pub(super) fn open_read(
        &self,
        request: &mdbase::runtime::OperationRequest,
        scope_binding: &str,
        context: &OperationContext,
    ) -> Result<CoordinatedReadPage, ConnectError> {
        self.touch();
        let _permit = self.foreground.acquire(context)?;
        let runtime = self.runtime()?;
        let page = runtime.open_read(request, context)?;
        let next = match page.next {
            Some(cursor) => Some(self.register_read_cursor(
                &runtime,
                cursor,
                Uuid::new_v4(),
                scope_binding,
                context,
            )?),
            None => None,
        };
        Ok(CoordinatedReadPage {
            result: page.outcome.result,
            next,
        })
    }

    pub(super) fn read_page(
        &self,
        external: &str,
        scope_binding: &str,
        context: &OperationContext,
    ) -> Result<CoordinatedReadPage, ConnectError> {
        self.touch();
        let _permit = self.foreground.acquire(context)?;
        let runtime = self.runtime()?;
        let current = {
            let cursors = self
                .read_cursors
                .lock()
                .map_err(|_| ConnectError::CollectionOpen("read cursor lock poisoned".into()))?;
            let current = cursors.cursors.get(external).cloned().ok_or_else(|| {
                ConnectError::Provider(mdbase::runtime::ProviderError::GenerationExpired)
            })?;
            if current.scope_binding != scope_binding {
                return Err(ConnectError::AccessDenied(
                    "The query cursor belongs to a different grant scope.".to_string(),
                ));
            }
            current
        };
        let page = match runtime.read_page(&current.runtime, context) {
            Ok(page) => page,
            Err(error @ mdbase::runtime::ProviderError::GenerationExpired)
            | Err(error @ mdbase::runtime::ProviderError::InvalidReadCursor) => {
                self.remove_read_lease(current.lease_id);
                return Err(error.into());
            }
            Err(error) => return Err(error.into()),
        };
        let next = match page.next {
            Some(cursor) => {
                let existing = self
                    .read_cursors
                    .lock()
                    .map_err(|_| ConnectError::CollectionOpen("read cursor lock poisoned".into()))?
                    .cursors
                    .get(external)
                    .and_then(|cursor| cursor.next_external.clone());
                match existing {
                    Some(next) => next,
                    None => {
                        let next = self.register_read_cursor(
                            &runtime,
                            cursor,
                            current.lease_id,
                            scope_binding,
                            context,
                        )?;
                        let mut cursors = self.read_cursors.lock().map_err(|_| {
                            ConnectError::CollectionOpen("read cursor lock poisoned".into())
                        })?;
                        if let Some(entry) = cursors.cursors.get_mut(external) {
                            entry.next_external = Some(Some(next.clone()));
                        }
                        Some(next)
                    }
                }
            }
            None => {
                let mut cursors = self.read_cursors.lock().map_err(|_| {
                    ConnectError::CollectionOpen("read cursor lock poisoned".into())
                })?;
                if let Some(entry) = cursors.cursors.get_mut(external) {
                    entry.next_external = Some(None);
                }
                None
            }
        };
        Ok(CoordinatedReadPage {
            result: page.outcome.result,
            next,
        })
    }

    pub(super) fn release_read(
        &self,
        external: &str,
        scope_binding: &str,
        context: &OperationContext,
    ) -> Result<(), ConnectError> {
        self.touch();
        let _permit = self.foreground.acquire(context)?;
        let runtime = self.runtime()?;
        let cursor = {
            let cursors = self
                .read_cursors
                .lock()
                .map_err(|_| ConnectError::CollectionOpen("read cursor lock poisoned".into()))?;
            let cursor = cursors.cursors.get(external).cloned().ok_or_else(|| {
                ConnectError::Provider(mdbase::runtime::ProviderError::GenerationExpired)
            })?;
            if cursor.scope_binding != scope_binding {
                return Err(ConnectError::AccessDenied(
                    "The query cursor belongs to a different grant scope.".to_string(),
                ));
            }
            cursor
        };
        runtime.release_read(cursor.runtime, context)?;
        self.remove_read_lease(cursor.lease_id);
        Ok(())
    }

    fn register_read_cursor(
        &self,
        runtime: &FilesystemRuntime,
        cursor: mdbase::runtime::ReadCursor,
        lease_id: Uuid,
        scope_binding: &str,
        context: &OperationContext,
    ) -> Result<String, ConnectError> {
        let mut cursors = self
            .read_cursors
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("read cursor lock poisoned".into()))?;
        if cursors.cursors.len() >= MAX_EXTERNAL_READ_CURSORS {
            drop(cursors);
            runtime.release_read(cursor, context)?;
            self.remove_read_lease(lease_id);
            return Err(ConnectError::Provider(
                mdbase::runtime::ProviderError::CursorCapacityExhausted,
            ));
        }
        let external = Uuid::new_v4().to_string();
        cursors.cursors.insert(
            external.clone(),
            HostedReadCursor {
                runtime: cursor,
                lease_id,
                scope_binding: scope_binding.to_string(),
                next_external: None,
            },
        );
        Ok(external)
    }

    fn remove_read_lease(&self, lease_id: Uuid) {
        if let Ok(mut cursors) = self.read_cursors.lock() {
            cursors
                .cursors
                .retain(|_, cursor| cursor.lease_id != lease_id);
        }
    }

    pub(super) fn ingest_external_timeout(
        &self,
        timeout: Duration,
        context: &OperationContext,
    ) -> Result<bool, ConnectError> {
        match &self.runtime {
            Some(runtime) => runtime
                .ingest_external_timeout(timeout, context)
                .map(|event| event.is_some())
                .map_err(Into::into),
            None => Ok(false),
        }
    }

    pub(super) fn synchronize(&self, context: &OperationContext) -> Result<(), ConnectError> {
        match &self.runtime {
            Some(runtime) => runtime
                .synchronize_with_context(context)
                .map_err(Into::into),
            None => self
                .provider
                .refresh_with_context(context)
                .map_err(Into::into),
        }
    }

    pub(super) fn read_change_events(
        &self,
        after: Option<ChangeWatermark>,
        context: &OperationContext,
    ) -> Result<RuntimeChangeEventPage, ConnectError> {
        let feed = self
            .feed
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("runtime feed lock poisoned".into()))?;
        let feed = feed.as_ref().ok_or_else(|| {
            ConnectError::UnsupportedOperation(
                "the legacy collection has no runtime change feed".to_string(),
            )
        })?;
        self.runtime
            .as_ref()
            .expect("a runtime feed always has a runtime")
            .read_change_events(
                feed,
                after,
                NonZeroUsize::new(256).expect("constant is non-zero"),
                context,
            )
            .map_err(Into::into)
    }

    pub(super) fn ack_change_events(
        &self,
        through: ChangeWatermark,
        context: &OperationContext,
    ) -> Result<(), ConnectError> {
        let feed = self
            .feed
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("runtime feed lock poisoned".into()))?;
        let feed = feed.as_ref().ok_or_else(|| {
            ConnectError::UnsupportedOperation(
                "the legacy collection has no runtime change feed".to_string(),
            )
        })?;
        self.runtime
            .as_ref()
            .expect("a runtime feed always has a runtime")
            .ack_change_events(feed, through, context)
            .map_err(Into::into)
    }
}

struct PermitPool {
    available: Mutex<usize>,
    changed: Condvar,
}

impl PermitPool {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity),
            changed: Condvar::new(),
        }
    }

    fn acquire(&self, context: &OperationContext) -> Result<Permit<'_>, ConnectError> {
        let mut available = self
            .available
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("executor permit lock poisoned".into()))?;
        loop {
            context.check()?;
            if *available > 0 {
                *available -= 1;
                return Ok(Permit { pool: self });
            }
            let wait = context.deadline().remaining().min(WAIT_SLICE);
            let (next, _) = self.changed.wait_timeout(available, wait).map_err(|_| {
                ConnectError::CollectionOpen("executor permit lock poisoned".into())
            })?;
            available = next;
        }
    }
}

struct Permit<'a> {
    pool: &'a PermitPool,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Ok(mut available) = self.pool.available.lock() {
            *available += 1;
            self.pool.changed.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(duration: Duration) -> OperationContext {
        OperationContext::new(
            &mdbase::OperationCancellation::new(),
            mdbase::runtime::OperationDeadline::after(duration),
        )
    }

    #[test]
    fn queued_permit_honors_deadline_and_releases_capacity() {
        let pool = PermitPool::new(1);
        let held = pool.acquire(&context(Duration::from_secs(1))).unwrap();
        let expired = context(Duration::ZERO);
        assert!(matches!(
            pool.acquire(&expired),
            Err(ConnectError::Provider(
                mdbase::runtime::ProviderError::OperationDeadline
            ))
        ));
        drop(held);
        assert!(pool.acquire(&context(Duration::from_secs(1))).is_ok());
    }

    #[test]
    fn foreground_saturation_cannot_consume_mutation_capacity() {
        let foreground = PermitPool::new(2);
        let mutation = PermitPool::new(1);
        let _read_one = foreground
            .acquire(&context(Duration::from_secs(1)))
            .unwrap();
        let _read_two = foreground
            .acquire(&context(Duration::from_secs(1)))
            .unwrap();
        assert!(mutation.acquire(&context(Duration::from_secs(1))).is_ok());
    }
}
