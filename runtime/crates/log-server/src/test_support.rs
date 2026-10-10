//! Native conformance-only independent memory floors. No durable/native producer.
//! Enabled solely by the conformance dev-dependency; release/WASM builds refuse.
use std::future::Future;
use std::pin::Pin;

use mdbn_log_service::auth::Principal;
use mdbn_log_service::backend::Backend;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::mem::MemBackend;
use mdbn_log_service::{Code, Result, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, Uuid};
use mdbn_wire::schema::Wire;

use crate::AnyService;
use crate::pg::IndependentFloorReader;

/// Explicit independently owned test authority, not restored collection metadata.
#[derive(Default)]
pub struct TestDeletionFloors {
    memory: MemBackend,
}
impl IndependentFloorReader for TestDeletionFloors {
    fn read<'a>(
        &'a self,
        collection: Uuid,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CollectionDeletionRecord>>> + Send + 'a>> {
        Box::pin(async move { self.memory.collection_deletion_floor(&collection).await })
    }
}
impl TestDeletionFloors {
    pub(crate) fn call(
        &self,
        service: &AnyService,
        principal: &Principal,
        method: &str,
        params: &Cbor,
    ) -> Option<Result<Cbor>> {
        if method != "registry_record_collection_deletion" {
            return None;
        }
        Some(self.record(service, principal, params))
    }
    fn record(&self, service: &AnyService, principal: &Principal, params: &Cbor) -> Result<Cbor> {
        if !matches!(principal, Principal::ControlPlane) {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        }
        let bad = || ServiceError::invalid("test_deletion_registry_request");
        let Cbor::Map(fields) = params else {
            return Err(bad());
        };
        if fields.len() != 4
            || fields
                .iter()
                .enumerate()
                .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
        {
            return Err(bad());
        }
        if Uuid::from_cbor(&fields[0].1).ok() != Some(B16([0; 16])) {
            return Err(bad());
        }
        let Cbor::Uint(epoch) = fields[3].1 else {
            return Err(bad());
        };
        let record = CollectionDeletionRecord {
            collection: Uuid::from_cbor(&fields[1].1).map_err(|_| bad())?,
            deletion_id: Uuid::from_cbor(&fields[2].1).map_err(|_| bad())?,
            lifecycle_epoch: epoch,
        }
        .validate()?;
        // Mem's getter reads its own independent reference registry. PG's test
        // reader uses this separately owned memory registry, never SQL or Meta.
        let actual = match service {
            AnyService::Mem(s) => s.backend.record_collection_deletion(record)?,
            AnyService::Pg(_) => self.memory.record_collection_deletion(record)?,
        };
        Ok(Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), actual.collection.to_cbor()),
            (Cbor::Uint(2), actual.deletion_id.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(actual.lifecycle_epoch)),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::MemObjects;
    use mdbn_log_service::testkit::id16;
    use std::task::{Context, Poll, Waker};

    fn ready<T>(f: impl Future<Output = T>) -> T {
        let mut f = std::pin::pin!(f);
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("reference getter waited"),
        }
    }
    #[test]
    fn fixture_first_tuple_is_immutable_and_read_from_independent_memory() {
        let floors = TestDeletionFloors::default();
        let record = CollectionDeletionRecord {
            collection: id16("test-floor/collection"),
            deletion_id: id16("test-floor/deletion"),
            lifecycle_epoch: u64::MAX,
        };
        assert_eq!(ready(floors.read(record.collection)).unwrap(), None);
        floors.memory.record_collection_deletion(record).unwrap();
        assert_eq!(ready(floors.read(record.collection)).unwrap(), Some(record));
        let other = CollectionDeletionRecord {
            lifecycle_epoch: 1,
            ..record
        };
        assert_eq!(
            floors
                .memory
                .record_collection_deletion(other)
                .unwrap_err()
                .code,
            Code::Forbidden
        );
        assert_eq!(ready(floors.read(record.collection)).unwrap(), Some(record));
    }
    #[test]
    fn fixture_requires_cp_nil_route_and_exact_shape_before_floor_mutation() {
        let floors = TestDeletionFloors::default();
        let service = AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            crate::testkit_config("conformance", "http://fixture.test"),
        ));
        let c = id16("test-floor/collection");
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), B16([0; 16]).to_cbor()),
            (Cbor::Uint(1), c.to_cbor()),
            (Cbor::Uint(2), id16("test-floor/deletion").to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(u64::MAX)),
        ]);
        let device = Principal::Device {
            id: id16("test-floor/device"),
            sign_pk: mdbn_wire::common::B32([7; 32]),
            collection: Some(c),
        };
        assert_eq!(
            floors
                .call(
                    &service,
                    &device,
                    "registry_record_collection_deletion",
                    &params
                )
                .unwrap()
                .unwrap_err()
                .code,
            Code::Forbidden
        );
        for malformed in [
            Cbor::Null,
            Cbor::Map(vec![]),
            Cbor::Map(vec![(Cbor::Uint(0), c.to_cbor())]),
        ] {
            assert_eq!(
                floors
                    .call(
                        &service,
                        &Principal::ControlPlane,
                        "registry_record_collection_deletion",
                        &malformed
                    )
                    .unwrap()
                    .unwrap_err()
                    .code,
                Code::Invalid
            );
        }
        let AnyService::Mem(s) = &service else {
            unreachable!()
        };
        assert_eq!(
            ready(s.backend.collection_deletion_floor(&c)).unwrap(),
            None
        );
        assert!(
            floors
                .call(&service, &Principal::ControlPlane, "delete_log", &params)
                .is_none()
        );
        floors
            .call(
                &service,
                &Principal::ControlPlane,
                "registry_record_collection_deletion",
                &params,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            ready(s.backend.collection_deletion_floor(&c))
                .unwrap()
                .unwrap()
                .lifecycle_epoch,
            u64::MAX
        );
    }
}
