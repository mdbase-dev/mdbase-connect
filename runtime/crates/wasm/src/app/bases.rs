//! App-runtime wrapper of the shared bounded native Bases codec.
//! Runtime/SQL health remains an additional gate before replica authority.
use super::*;
pub(crate) use mdbn_replica::bases_codec::refusal;
use mdbn_replica::{
    SessionId,
    api::{ApiResult, ErrorCode},
};

fn unavailable() -> mdbn_replica::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "runtime_not_ready",
        "app runtime is not ready for Bases execution",
    )
}
impl AppRuntime {
    fn bases_read_consuming(
        &mut self,
        session: u64,
        bytes: &mut [u8],
        read: impl FnOnce(&mut mdbn_replica::Replica<AppStore>, SessionId, &[u8]) -> ApiResult<Vec<u8>>,
    ) -> Vec<u8> {
        let result = (|| {
            if !self.healthy() {
                return Err(unavailable());
            }
            let replica = self.runtime.as_mut().ok_or_else(unavailable)?.replica_mut();
            read(replica, SessionId(session), bytes)
        })();
        wipe(bytes);
        result.unwrap_or_else(|error| refusal(error.into_problem()))
    }
    /// Consumes/wipes an independent execution READ on the original session.
    pub fn bases_execute_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        self.bases_read_consuming(session, bytes, |replica, session, bytes| {
            replica.encode_app_bases_execute(session, bytes)
        })
    }
    /// Consumes/wipes one bounded native discovery page.
    pub fn bases_list_views_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        self.bases_read_consuming(session, bytes, |replica, session, bytes| {
            replica.encode_app_bases_list_views(session, bytes)
        })
    }
    /// Consumes/wipes an exact source revision/ordinal READ.
    pub fn bases_read_view_source_consuming(&mut self, session: u64, bytes: &mut [u8]) -> Vec<u8> {
        self.bases_read_consuming(session, bytes, |replica, session, bytes| {
            replica.encode_app_bases_read_view_source(session, bytes)
        })
    }
}
