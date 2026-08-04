use uuid::Uuid;

use super::mutation_journal::HostedMutationLease;
use super::Replica;

pub(super) struct RecordOperationContext<'a> {
    pub(super) collection_id: Uuid,
    pub(super) token: &'a str,
    pub(super) replica: &'a Replica,
    pub(super) operation: &'a str,
    pub(super) request_id: Uuid,
    pub(super) mutation_lease: &'a HostedMutationLease,
}
