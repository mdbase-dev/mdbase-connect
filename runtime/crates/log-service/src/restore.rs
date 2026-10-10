//! Trusted operational settings for logical restore. This deliberately excludes
//! ACL, epoch, freeze and key state: those are rebuilt from verified signed items.

use mdbn_wire::cbor::Cbor;

use crate::error::{Result, ServiceError};
use crate::model::{CollectionMeta, Quotas, RetentionTier};

pub(crate) struct RestoreSettings {
    quotas: Quotas,
    retention_tier: RetentionTier,
    created_at: i64,
}

impl RestoreSettings {
    pub(crate) fn export(meta: &CollectionMeta) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Array(vec![
                Cbor::Uint(meta.quotas.storage_bytes),
                Cbor::Uint(meta.quotas.items_per_s),
                Cbor::Uint(meta.quotas.bytes_per_s),
                Cbor::Uint(meta.quotas.burst_items),
            ]),
            Cbor::Uint(meta.retention_tier.days()),
            Cbor::int(meta.created_at),
        ])
    }

    pub(crate) fn parse(value: &Cbor) -> Result<Self> {
        let bad = || ServiceError::invalid("restore_settings");
        let Cbor::Array(fields) = value else {
            return Err(bad());
        };
        let [
            Cbor::Uint(1),
            Cbor::Array(quota),
            Cbor::Uint(days),
            created_at,
        ] = fields.as_slice()
        else {
            return Err(bad());
        };
        let [
            Cbor::Uint(storage_bytes),
            Cbor::Uint(items_per_s),
            Cbor::Uint(bytes_per_s),
            Cbor::Uint(burst_items),
        ] = quota.as_slice()
        else {
            return Err(bad());
        };
        Ok(Self {
            quotas: Quotas {
                storage_bytes: *storage_bytes,
                items_per_s: *items_per_s,
                bytes_per_s: *bytes_per_s,
                burst_items: *burst_items,
            },
            retention_tier: RetentionTier::from_days(*days).ok_or_else(bad)?,
            created_at: created_at.as_i64().ok_or_else(bad)?,
        })
    }

    pub(crate) fn apply(self, meta: &mut CollectionMeta) {
        meta.quotas = self.quotas;
        meta.retention_tier = self.retention_tier;
        meta.created_at = self.created_at;
    }
}
