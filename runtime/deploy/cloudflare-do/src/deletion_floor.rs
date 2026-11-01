//! Native backend-owned lookup through the actual nil LOG binding, not CP SQL.
use super::*;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::schema::Wire;

const REPLY_CAP: usize = 1024;

// Private namespace capability, NOT CP/device/point-response authentication.
// Only the real backend's bound namespace + physical actor ID can construct it.
// It exposes one fixed denial-metadata lookup, no arbitrary request forwarding.
struct BackendNilRoute {
    stub: Stub,
    collection: Uuid,
}
impl BackendNilRoute {
    fn from_backend(backend: &DoBackend, collection: &Uuid) -> LsResult<Self> {
        if *collection == REGISTRY {
            return Err(CollectionDeletionRecord::unavailable());
        }
        backend.require_namespace_actor(collection)?;
        let stub = backend
            .registry_stub()
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        Ok(Self {
            stub,
            collection: *collection,
        })
    }
    async fn fetch(self) -> LsResult<Response> {
        self.stub
            .fetch_with_str(&format!(
                "https://registry/registry/collection-deletion?c={}&target={}",
                REGISTRY.to_uuid_string(),
                self.collection.to_uuid_string()
            ))
            .await
            .map_err(|_| CollectionDeletionRecord::unavailable())
    }
}

/// What this collection actor last learned from the nil registry about its own
/// floor, so a publishing commit needs no registry round trip under the write
/// lock. Floors are immutable, so a found floor is kept for the actor's life.
/// Absence stays valid only because the registry fences this actor (clearing
/// `known` and advancing `fence`) before it inserts a floor or Closing row for
/// the collection, and refuses lookups while that fence is outstanding; a lookup
/// that overlapped a fence caches nothing. In memory only: a restarted actor
/// starts unknown and asks again.
#[derive(Default)]
pub(super) struct FloorCache {
    fence: u64,
    known: Option<Option<CollectionDeletionRecord>>,
}

/// Registry side of the fence: the collection stays in `fencing` (and its
/// lookups refuse) until this guard drops, after the floor/Closing insert.
pub(super) struct FenceGuard<'a> {
    backend: &'a DoBackend,
    collection: Uuid,
}
impl Drop for FenceGuard<'_> {
    fn drop(&mut self) {
        let mut fencing = self.backend.fencing.borrow_mut();
        if let Some(n) = fencing.get_mut(&self.collection) {
            *n -= 1;
            if *n == 0 {
                fencing.remove(&self.collection);
            }
        }
    }
}

fn gone(record: CollectionDeletionRecord) -> ServiceError {
    let mut error = ServiceError::reason(mdbn_log_service::Code::Gone, "collection_deletion_floor");
    error.details = Some(record.to_cbor());
    error
}

/// Namespace-only route on a collection actor; the public Worker never forwards it.
pub(super) const FENCE_PATH: &str = "/deletion-floor-fence";

pub(super) fn publishes(writes: &[Write]) -> bool {
    writes.iter().any(|write| match write {
        Write::CreateCollection(_) => true,
        Write::PutMeta(meta) => meta.status != mdbn_log_service::model::Status::Gone,
        Write::UpsertAcl(acl) => acl.active,
        Write::InsertItem(_)
        | Write::PutObject(_)
        | Write::InsertSnapshot(_)
        | Write::EndorseSnapshot(_) => true,
        Write::Notify(notice) => !notice.gone,
        Write::DeleteObject(_) | Write::DeleteSnapshot(_) | Write::DeleteEntriesThrough(_) => false,
    })
}
impl DoBackend {
    /// Collection actor: forget the cached floor answer and void any lookup in
    /// flight. Synchronous, so the registry's acknowledgement orders after it.
    pub(super) fn fence_floor_cache(&self) {
        let mut cache = self.floor_cache.borrow_mut();
        cache.fence += 1;
        cache.known = None;
    }

    /// Registry: fence the collection's actor before inserting its floor or
    /// Closing row. Lookups for it refuse from now until the guard drops, so no
    /// absence observed after the actor's acknowledgement can be cached.
    pub(super) async fn fence_collection(&self, collection: &Uuid) -> LsResult<FenceGuard<'_>> {
        *self.fencing.borrow_mut().entry(*collection).or_default() += 1;
        let guard = FenceGuard {
            backend: self,
            collection: *collection,
        };
        let location = self
            .location
            .clone()
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        let stub = do_location::stub(&self.ns, &collection.to_uuid_string(), location)
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        let response = stub
            .fetch_with_str(&format!(
                "https://collection{FENCE_PATH}?c={}",
                collection.to_uuid_string()
            ))
            .await
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        if response.status_code() != 200 {
            return Err(CollectionDeletionRecord::unavailable());
        }
        Ok(guard)
    }

    /// Registry: a collection whose actor is being fenced has no answer yet.
    fn refuse_fencing(&self, collection: &Uuid) -> LsResult<()> {
        if self.fencing.borrow().contains_key(collection) {
            return Err(CollectionDeletionRecord::unavailable());
        }
        Ok(())
    }

    /// The floor, from this actor's cache when known (see [`FloorCache`]).
    pub(super) async fn cached_deletion_floor(
        &self,
        collection: &Uuid,
        budget: &Budget,
    ) -> LsResult<Option<CollectionDeletionRecord>> {
        if self.is_registry.get() {
            return self.lookup_deletion_floor(collection, budget).await;
        }
        // The cache answers for this actor's own collection only.
        self.require_namespace_actor(collection)?;
        let fence = {
            let cache = self.floor_cache.borrow();
            if let Some(known) = cache.known {
                return Ok(known);
            }
            cache.fence
        };
        let found = self.lookup_deletion_floor(collection, budget).await?;
        let mut cache = self.floor_cache.borrow_mut();
        if cache.fence != fence {
            return Err(CollectionDeletionRecord::unavailable());
        }
        cache.known = Some(found);
        Ok(found)
    }

    /// Fill the cache before a writer takes the lock. A failure is not an error
    /// here: only a publishing commit needs the answer, and it refuses unknown.
    pub(super) async fn prefetch_deletion_floor(&self, collection: &Uuid, budget: &Budget) {
        if !self.is_registry.get() && self.floor_cache.borrow().known.is_none() {
            let _ = self.cached_deletion_floor(collection, budget).await;
        }
    }

    /// The commit-time floor check: synchronous, from the cache only. Unknown
    /// (lookup failed, or a fence arrived since) fails closed.
    pub(super) fn refuse_cached_deletion_floor(&self) -> LsResult<()> {
        match self.floor_cache.borrow().known {
            Some(None) => Ok(()),
            Some(Some(record)) => Err(gone(record)),
            None => Err(CollectionDeletionRecord::unavailable()),
        }
    }

    pub(super) async fn notify_collection_deleted(&self, collection: &Uuid) -> LsResult<()> {
        let location = self.location.clone().map_err(ls_err)?;
        let stub =
            do_location::stub(&self.ns, &collection.to_uuid_string(), location).map_err(ls_err)?;
        let response = stub
            .fetch_with_str(&format!(
                "https://collection/collection-deleted?c={}",
                collection.to_uuid_string()
            ))
            .await
            .map_err(ls_err)?;
        if response.status_code() != 200 {
            return Err(CollectionDeletionRecord::unavailable());
        }
        Ok(())
    }

    // Actor IDs are actual State/namespace values, not request role/UUID claims.
    // This ordinary named-object proof is NOT an admitted PITR member/run pin;
    // required profiles still cannot instantiate DoBackend at all.
    fn require_namespace_actor(&self, collection: &Uuid) -> LsResult<()> {
        let expected = self
            .ns
            .id_from_name(&collection.to_uuid_string())
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        if expected.to_string() != self.actor_id {
            return Err(CollectionDeletionRecord::unavailable());
        }
        Ok(())
    }
    pub(super) fn deletion_floor_response(&self, collection: &Uuid) -> LsResult<Vec<u8>> {
        self.require_namespace_actor(&REGISTRY)?;
        let original = self.deletion_floor_local(collection)?;
        if original.is_none() {
            self.refuse_collection_closing(collection)?;
            self.refuse_fencing(collection)?;
        }
        let floor = original.map(|r| CollectionDeletionRecord {
            collection: r.collection,
            deletion_id: r.deletion_id,
            lifecycle_epoch: r.lifecycle_epoch,
        });
        mdbn_wire::cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            collection.to_cbor(),
            floor.map_or(Cbor::Null, CollectionDeletionRecord::to_cbor),
        ]))
        .map_err(|_| CollectionDeletionRecord::unavailable())
    }
    pub(super) async fn lookup_deletion_floor(
        &self,
        collection: &Uuid,
        budget: &Budget,
    ) -> LsResult<Option<CollectionDeletionRecord>> {
        if *collection == REGISTRY {
            return Err(CollectionDeletionRecord::unavailable());
        }
        if self.is_registry.get() {
            self.require_namespace_actor(&REGISTRY)?;
            let original = self.deletion_floor_local(collection)?;
            if original.is_none() {
                self.refuse_collection_closing(collection)?;
                self.refuse_fencing(collection)?;
            }
            return original
                .map(|r| CollectionDeletionRecord {
                    collection: r.collection,
                    deletion_id: r.deletion_id,
                    lifecycle_epoch: r.lifecycle_epoch,
                })
                .map(CollectionDeletionRecord::validate)
                .transpose();
        }
        let response = BackendNilRoute::from_backend(self, collection)?
            .fetch()
            .await?;
        if response.status_code() != 200 {
            return Err(CollectionDeletionRecord::unavailable());
        }
        // The namespace response must remain bounded BEFORE generic decode.
        // Reuse mandatory BYOB ingress on its native byte stream; no text/json/
        // arrayBuffer or unbounded default-reader fallback, and no network effect.
        let bytes = match response.body() {
            ResponseBody::Body(bytes) => {
                if bytes.len() > REPLY_CAP {
                    return Err(CollectionDeletionRecord::unavailable());
                }
                bytes.clone()
            }
            ResponseBody::Stream(stream) => {
                let mut init = RequestInit::new();
                init.with_method(Method::Post)
                    .with_body(Some(stream.clone().into()));
                let request = Request::new_with_init("https://registry.read.internal/", &init)
                    .map_err(|_| CollectionDeletionRecord::unavailable())?;
                let body = ingress::read(&request, REPLY_CAP)
                    .await
                    .map_err(|_| CollectionDeletionRecord::unavailable())?;
                body.bytes.clone()
            }
            ResponseBody::Empty => return Err(CollectionDeletionRecord::unavailable()),
        };
        let decoded = budget
            .raw(&bytes)
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        let Cbor::Array(values) = decoded else {
            return Err(CollectionDeletionRecord::unavailable());
        };
        if values.len() != 3
            || values[0] != Cbor::Uint(1)
            || Uuid::from_cbor(&values[1]).ok() != Some(*collection)
        {
            return Err(CollectionDeletionRecord::unavailable());
        }
        match &values[2] {
            Cbor::Null => Ok(None),
            value => {
                let record = CollectionDeletionRecord::parse(value)?;
                if record.collection != *collection {
                    return Err(CollectionDeletionRecord::unavailable());
                }
                Ok(Some(record))
            }
        }
    }
}
