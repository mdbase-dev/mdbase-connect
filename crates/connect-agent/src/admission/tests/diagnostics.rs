use super::*;

/// Instance-local, bounded diagnostics: no payloads, paths, or authority identifiers.
#[derive(Debug)]
pub(crate) struct AdmissionTrace {
    started: Instant,
    pub(super) next: std::sync::atomic::AtomicU64,
    events: Mutex<std::collections::VecDeque<(u128, u64, WorkClass, &'static str)>>,
    changed: tokio::sync::Notify,
}

impl Default for AdmissionTrace {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            next: std::sync::atomic::AtomicU64::new(0),
            events: Mutex::new(std::collections::VecDeque::new()),
            changed: tokio::sync::Notify::new(),
        }
    }
}

impl AdmissionTrace {
    pub fn record(&self, id: u64, class: WorkClass, stage: &'static str) {
        let mut events = self.events.lock().unwrap();
        if events.len() == 128 {
            events.pop_front();
        }
        events.push_back((self.started.elapsed().as_micros(), id, class, stage));
        drop(events);
        self.changed.notify_one();
    }

    pub fn snapshot(&self) -> Vec<(u128, u64, WorkClass, &'static str)> {
        self.events.lock().unwrap().iter().copied().collect()
    }

    pub async fn wait_for_pending_reads(&self, count: usize) {
        loop {
            let changed = self.changed.notified();
            if self
                .snapshot()
                .iter()
                .filter(|event| event.3 == "read_pending")
                .count()
                >= count
            {
                return;
            }
            changed.await;
        }
    }
}

impl AdmissionScheduler {
    pub(crate) fn trace(&self) -> &Arc<AdmissionTrace> {
        &self.trace
    }
}

impl AdmissionPermit {
    pub(crate) fn trace_id(&self) -> u64 {
        self.trace_id
    }
}
