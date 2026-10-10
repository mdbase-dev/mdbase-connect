//! Bounded native delegated upload lifetime. No device/external scheduling change.
//! Idle activity never extends the original authenticated journal expiry.
use super::*;

const PER_GRANT: usize = 2;
const PER_COLLECTION: usize = 16;
const IDLE_MS: i64 = 60_000;

pub(super) struct HostedLifetime {
    expires_at_ms: u64,
    idle_until_ms: i64,
}
impl HostedLifetime {
    pub(super) fn new(now_ms: i64, expires_at_ms: u64) -> Self {
        Self {
            expires_at_ms,
            idle_until_ms: now_ms.saturating_add(IDLE_MS),
        }
    }
    fn deadline(&self) -> i64 {
        self.idle_until_ms
            .min(i64::try_from(self.expires_at_ms).unwrap_or(i64::MAX))
    }
    fn check(&self, now_ms: i64) -> ApiResult<()> {
        if self.expires_at_ms <= u64::try_from(now_ms).unwrap_or(u64::MAX) {
            return Err(ErrorCode::Unavailable
                .err_with_reason("attachment_upload_expired", "the hosted upload has expired"));
        }
        if self.idle_until_ms <= now_ms {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_upload_idle",
                "the hosted upload stopped making progress",
            ));
        }
        Ok(())
    }
    pub(super) fn progress(&mut self, now_ms: i64) {
        // No late event can revive expired work. Read-only probes never call this.
        if self.check(now_ms).is_ok() {
            self.idle_until_ms = now_ms.saturating_add(IDLE_MS);
        }
    }
}
impl Upload {
    pub(super) fn hosted_deadline(&self) -> Option<i64> {
        self.lifetime.as_ref().map(HostedLifetime::deadline)
    }
}
impl<S: Store> Replica<S> {
    pub(super) fn hosted_upload_lifetime_check(&self, up: &Upload) -> ApiResult<()> {
        if up.origin.delegated.is_none() {
            return Ok(());
        }
        up.lifetime
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("no hosted upload lifetime"))?
            .check(self.now())
    }
    pub(super) fn hosted_upload_capacity(&mut self, grant: Uuid) -> ApiResult<()> {
        // Called only AFTER native authorization, before writer/decryption work.
        self.prune_hosted_uploads();
        let delegated = self
            .attachment_uploads
            .map
            .values()
            .filter_map(|up| up.origin.delegated.as_ref());
        let (mut collection_count, mut grant_count) = (0, 0);
        for context in delegated {
            collection_count += 1;
            grant_count += usize::from(context.grant() == grant);
        }
        // Terminal slots count too: finishing/failing repeatedly cannot grow RAM.
        if collection_count >= PER_COLLECTION || grant_count >= PER_GRANT {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "hosted_upload_budget",
                "the hosted upload admission budget is full",
            ));
        }
        Ok(())
    }
    /// Native timer/send/decode fence; retires ONLY exact delegated upload calls.
    /// Removing tentative state neither withdraws a captured row nor ACKs storage.
    pub(crate) fn prune_hosted_uploads(&mut self) {
        let now = self.now();
        let expired: Vec<_> = self
            .attachment_uploads
            .map
            .iter()
            .filter_map(|(id, up)| {
                (up.origin.delegated.is_some() && up.hosted_deadline().is_some_and(|t| t <= now))
                    .then_some(*id)
            })
            .collect();
        for id in expired {
            self.remove_attachment_upload(&id);
        }
    }
    pub(super) fn retire_upload_call(&mut self, up: &mut Upload) {
        if let Some((id, _)) = up.call.take() {
            self.inflight.remove(&id);
            self.calls.retain(|call| call.id != id);
            self.log_sessions.forget_call(id);
        }
    }
}
