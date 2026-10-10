//! Native backend-owned lookup through the actual nil LOG binding, not CP SQL.
use super::*;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::schema::Wire;

const REPLY_CAP: usize = 1024;
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
    pub(super) async fn refuse_deletion_floor(
        &self,
        collection: &Uuid,
        budget: &Budget,
    ) -> LsResult<()> {
        if let Some(record) = self.lookup_deletion_floor(collection, budget).await? {
            let mut error =
                ServiceError::reason(mdbn_log_service::Code::Gone, "collection_deletion_floor");
            error.details = Some(record.to_cbor());
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn deletion_floor_response(&self, collection: &Uuid) -> LsResult<Vec<u8>> {
        let original = self.deletion_floor_local(collection)?;
        if original.is_none() {
            self.refuse_collection_closing(collection)?;
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
            let original = self.deletion_floor_local(collection)?;
            if original.is_none() {
                self.refuse_collection_closing(collection)?;
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
        let stub = self
            .ns
            .get_by_name(&REGISTRY.to_uuid_string())
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
        let response = stub
            .fetch_with_str(&format!(
                "https://registry/registry/collection-deletion?c={}&target={}",
                REGISTRY.to_uuid_string(),
                collection.to_uuid_string()
            ))
            .await
            .map_err(|_| CollectionDeletionRecord::unavailable())?;
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
