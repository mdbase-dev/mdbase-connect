//! Process-local transport attempt and authenticated-runtime handback.
//! No wire generation or caller permission bit. The source is the captured native
//! account/registration fence; expiry and retirement are checked on every use.
use crate::logwire::TokenSource;
use mdbn_replica::replica::AuthenticatedLogSession;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// Opaque local attempt minted before transport awaits; never a wire tag.
#[derive(Clone)]
pub struct Generation(Arc<Attempt>);
struct Attempt {
    alive: AtomicBool,
    expires_at: AtomicI64,
    source: Arc<dyn TokenSource>,
}
impl Generation {
    pub(crate) fn begin(source: Arc<dyn TokenSource>) -> Self {
        Self(Arc::new(Attempt {
            alive: AtomicBool::new(true),
            expires_at: AtomicI64::new(i64::MAX),
            source,
        }))
    }
    pub(crate) async fn token(&self) -> Result<crate::logwire::Token, String> {
        self.check()?;
        let result = self.0.source.token().await;
        self.check()?;
        result
    }
    pub(crate) fn token_expiry(&self, expiry: i64) {
        self.0.expires_at.store(expiry, Ordering::SeqCst);
    }
    pub(crate) fn retire(&self) {
        self.0.alive.store(false, Ordering::SeqCst);
    }
    /// Recheck retirement, expiry and the captured native authority source.
    pub fn check(&self) -> Result<(), String> {
        if !self.live() {
            return Err("retired log attempt".into());
        }
        self.0.source.current()?;
        if !self.live() {
            return Err("retired log attempt".into());
        }
        Ok(())
    }
    fn live(&self) -> bool {
        self.0.alive.load(Ordering::SeqCst)
            && i64::try_from(crate::fsutil::now_ms()).unwrap_or(i64::MAX)
                < self.0.expires_at.load(Ordering::SeqCst)
    }
}
impl std::fmt::Debug for Generation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogGeneration(<opaque>)")
    }
}

/// Created only by the runtime after authenticated Up and post-await checking.
/// The transport cannot invent Replica's opaque identity from a wire label.
#[derive(Clone)]
pub struct Session(Arc<Binding>);
struct Binding {
    generation: Generation,
    authenticated: AuthenticatedLogSession,
}
impl Session {
    /// Trusted host handback after authenticated Up and a post-await source check.
    pub fn bind(generation: Generation, authenticated: AuthenticatedLogSession) -> Self {
        Self(Arc::new(Binding {
            generation,
            authenticated,
        }))
    }
    /// Validate the native producer before delivery/decoding.
    pub fn check(&self) -> Result<(), String> {
        self.0.generation.check()
    }
    /// Borrow the original Replica session; this is not a portable certificate.
    pub fn authenticated(&self) -> &AuthenticatedLogSession {
        &self.0.authenticated
    }
    pub(crate) fn for_generation(&self, generation: &Generation) -> bool {
        Arc::ptr_eq(&self.0.generation.0, &generation.0)
    }
    /// Exact local binding identity, so old Down cannot retire new Up.
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogSession(<opaque>)")
    }
}

/// Also retires an attempt when the enclosing future is cancelled (stop/drop).
pub(crate) struct RetireOnDrop(pub Generation);
impl Drop for RetireOnDrop {
    fn drop(&mut self) {
        self.0.retire();
    }
}
