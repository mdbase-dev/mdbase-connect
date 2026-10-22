//! Original-client source IO through the actor's authenticated log transport.
use super::rpc::Stage;
use super::{Replica, Store};
use crate::{
    api::ErrorCode,
    file_source::SourceNeed,
    log::{CallId, LogReply, LogRequest, LogResponse},
};
use mdbn_wire::common::Uuid;
fn request(need: SourceNeed) -> (mdbn_wire::common::Hash, u64) {
    match need {
        SourceNeed::BlobPart {
            address, max_bytes, ..
        }
        | SourceNeed::Manifest { address, max_bytes } => (address, max_bytes),
        SourceNeed::Chunk { address, bytes, .. } => (address, bytes),
    }
}
impl<S: Store> Replica<S> {
    pub(crate) fn declared_setup_rpc_step(&mut self) {
        self.declared_setup_rpc_prune();
        let Some(mut job) = self.declared_setup_rpc_job.take() else {
            return;
        };
        if let Stage::Collecting(session) = &job.stage
            && let Err(error) = self.check_collection_setup_session(session)
        {
            job.stage = Stage::Failed(error.into_problem());
        }
        if job.call.is_some() {
            self.declared_setup_rpc_job = Some(job);
            return;
        }
        let placeholder = ErrorCode::Internal.problem("setup state transition incomplete");
        job.stage = match std::mem::replace(&mut job.stage, Stage::Failed(placeholder)) {
            Stage::Collecting(mut session) => {
                match self.collection_setup_session_need(&mut session) {
                    Err(error) => Stage::Failed(error.into_problem()),
                    Ok(None) => match self.finish_collection_setup_session(*session) {
                        Ok(review) => Stage::Reviewed(Box::new(review)),
                        Err(error) => Stage::Failed(error.into_problem()),
                    },
                    Ok(Some(need)) => {
                        let (address, max) = request(need);
                        let call = self.queue(LogRequest::GetObject {
                            collection: self.cfg.collection,
                            address,
                            range: Some((0, max)),
                        });
                        self.inflight.insert(
                            call,
                            super::super::append::Inflight::DeclaredSetupSource(job.ticket, need),
                        );
                        job.call = Some(call);
                        Stage::Collecting(session)
                    }
                }
            }
            Stage::Reviewed(review) => match self.check_collection_setup_review(&review) {
                Ok(()) => Stage::Reviewed(review),
                Err(error) => Stage::Failed(error.into_problem()),
            },
            failed => failed,
        };
        self.declared_setup_rpc_job = Some(job);
    }
    pub(crate) fn on_declared_setup_source_reply(
        &mut self,
        ticket: Uuid,
        need: SourceNeed,
        call: CallId,
        reply: LogReply,
    ) {
        self.declared_setup_rpc_prune();
        let Some(mut job) = self.declared_setup_rpc_job.take() else {
            return;
        };
        if job.ticket != ticket || job.call != Some(call) {
            self.declared_setup_rpc_job = Some(job);
            return;
        }
        job.call = None;
        if let Stage::Collecting(session) = &mut job.stage {
            let result = match reply {
                Ok(LogResponse::GetObject { bytes, size, .. })
                    if size == bytes.len() as u64 && size <= request(need).1 =>
                {
                    self.supply_collection_setup_session(session, need, &bytes)
                }
                _ => Err(ErrorCode::Unavailable.err("complete setup source is unavailable")),
            };
            if let Err(error) = result {
                job.stage = Stage::Failed(error.into_problem());
            }
        }
        self.declared_setup_rpc_job = Some(job);
        self.declared_setup_rpc_step();
    }
}
