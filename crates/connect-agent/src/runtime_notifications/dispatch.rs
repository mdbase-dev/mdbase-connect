use super::*;
use std::collections::VecDeque;
use tokio::task::{Id, JoinSet};

#[cfg(test)]
#[path = "dispatch_queue_tests.rs"]
mod tests;

const DISPATCH_CONCURRENCY: usize = 4;
// One run may consume a full HTTP timeout. Yield after it rather than holding
// a slot across a batch of slow outbound requests from the same collection.
const RUNS_PER_TURN: usize = 1;
type DispatchResult = (Uuid, Arc<Runtime>, mdbase_runtime::RuntimeResult<usize>);

/// Payloads and retries live in the runtime store. This queue retains only one
/// readiness entry per collection and permits one dispatcher per collection.
/// Local timer/admission work never awaits these network-bound tasks.
#[derive(Default)]
pub(super) struct DispatchQueue {
    pending: VecDeque<(Uuid, Arc<Runtime>)>,
    active: HashMap<Id, Uuid>,
    tasks: JoinSet<DispatchResult>,
}

impl DispatchQueue {
    pub(super) fn schedule(&mut self, id: Uuid, runtime: Arc<Runtime>) {
        if let Some((_, pending)) = self.pending.iter_mut().find(|(pending, _)| *pending == id) {
            *pending = runtime;
        } else {
            self.pending.push_back((id, runtime));
        }
        self.start_ready();
    }

    fn start_ready(&mut self) {
        while self.active.len() < DISPATCH_CONCURRENCY {
            let next = self
                .pending
                .iter()
                .position(|(id, _)| !self.active.values().any(|active| active == id));
            let Some(index) = next else {
                break;
            };
            let (id, runtime) = self.pending.remove(index).expect("pending dispatch exists");
            let task = self.tasks.spawn(async move {
                let result = drain_notification_runtime(&runtime, RUNS_PER_TURN).await;
                (id, runtime, result)
            });
            self.active.insert(task.id(), id);
        }
    }

    pub(super) fn has_tasks(&self) -> bool {
        !self.tasks.is_empty()
    }

    pub(super) async fn completed(&mut self) {
        if let Some(result) = self.tasks.join_next_with_id().await {
            match result {
                Ok((task, (id, runtime, result))) => {
                    self.active.remove(&task);
                    match result {
                        Ok(RUNS_PER_TURN) => {
                            if !self.pending.iter().any(|(pending, _)| *pending == id) {
                                self.pending.push_back((id, runtime));
                            }
                        }
                        Ok(_) => {} // Idle or deferred; durable recovery owns retries.
                        Err(error) => {
                            tracing::warn!(collection_id = %id, %error, "notification dispatch deferred")
                        }
                    }
                }
                Err(error) => {
                    self.active.remove(&error.id());
                    tracing::warn!(%error, "notification dispatch task failed; durable recovery will retry");
                }
            }
        }
        self.start_ready();
    }
}
