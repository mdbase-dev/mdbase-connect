use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use tokio::{sync::Semaphore, time::timeout};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthorityImportHookPoint {
    BeforeProjectionAdvance,
    BeforeSecondPhaseLock,
    BeforeRecoveryFinalizerLock,
    AfterCollectionBeforeGenerationLock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityImportHookError {
    MissedBoundary,
}

struct AuthorityImportHookState {
    arrived: Semaphore,
    release: Semaphore,
    timeout: Duration,
}

type HookKey = (Uuid, AuthorityImportHookPoint);

fn authority_import_hooks() -> &'static Mutex<HashMap<HookKey, Arc<AuthorityImportHookState>>> {
    static HOOKS: OnceLock<Mutex<HashMap<HookKey, Arc<AuthorityImportHookState>>>> =
        OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct AuthorityImportTestHook {
    key: HookKey,
    state: Arc<AuthorityImportHookState>,
}

impl AuthorityImportTestHook {
    pub fn install(import_id: Uuid, point: AuthorityImportHookPoint, timeout: Duration) -> Self {
        assert!(
            !timeout.is_zero(),
            "authority import hook timeout must be positive"
        );
        let timeout = timeout.min(Duration::from_secs(30));
        let key = (import_id, point);
        let state = Arc::new(AuthorityImportHookState {
            arrived: Semaphore::new(0),
            release: Semaphore::new(0),
            timeout,
        });
        let replaced = authority_import_hooks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, state.clone());
        assert!(
            replaced.is_none(),
            "authority import test hook already installed"
        );
        Self { key, state }
    }

    pub async fn wait_until_paused(&self) -> Result<(), AuthorityImportHookError> {
        match timeout(self.state.timeout, self.state.arrived.acquire()).await {
            Ok(Ok(permit)) => {
                permit.forget();
                Ok(())
            }
            Ok(Err(_)) | Err(_) => Err(AuthorityImportHookError::MissedBoundary),
        }
    }

    pub fn release(&self) {
        self.state.release.add_permits(1);
    }
}

impl Drop for AuthorityImportTestHook {
    fn drop(&mut self) {
        let mut hooks = authority_import_hooks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if hooks
            .get(&self.key)
            .is_some_and(|state| Arc::ptr_eq(state, &self.state))
        {
            hooks.remove(&self.key);
        }
        self.state.arrived.close();
        self.state.release.close();
    }
}

pub(crate) async fn pause_authority_import(import_id: Uuid, point: AuthorityImportHookPoint) {
    let state = authority_import_hooks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&(import_id, point))
        .cloned();
    if let Some(state) = state {
        state.arrived.add_permits(1);
        if let Ok(Ok(permit)) = timeout(state.timeout, state.release.acquire()).await {
            permit.forget();
        }
    }
}
