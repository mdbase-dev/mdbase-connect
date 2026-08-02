use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::{Mutex, OwnedMutexGuard};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct DataKeyCacheKey {
    environment: String,
    collection_id: Uuid,
    envelope_digest: [u8; 32],
}

impl DataKeyCacheKey {
    pub fn new(environment: &str, collection_id: Uuid, envelope_digest: [u8; 32]) -> Self {
        Self {
            environment: environment.to_string(),
            collection_id,
            envelope_digest,
        }
    }
}

struct CacheEntry {
    key: Zeroizing<[u8; 32]>,
    expires_at: Instant,
    last_used: u64,
}

struct CacheState {
    entries: HashMap<DataKeyCacheKey, CacheEntry>,
    max_entries: usize,
    ttl: Duration,
    clock: u64,
}

impl CacheState {
    fn get(&mut self, cache_key: &DataKeyCacheKey, now: Instant) -> Option<Zeroizing<[u8; 32]>> {
        self.remove_expired(now);
        self.clock = self.clock.wrapping_add(1);
        let entry = self.entries.get_mut(cache_key)?;
        entry.last_used = self.clock;
        Some(Zeroizing::new(*entry.key))
    }

    fn insert(&mut self, cache_key: DataKeyCacheKey, key: &[u8; 32], now: Instant) {
        if self.max_entries == 0 || self.ttl.is_zero() {
            return;
        }
        self.remove_expired(now);
        self.clock = self.clock.wrapping_add(1);
        if !self.entries.contains_key(&cache_key) && self.entries.len() >= self.max_entries {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(cache_key, _)| cache_key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            cache_key,
            CacheEntry {
                key: Zeroizing::new(*key),
                expires_at: now + self.ttl,
                last_used: self.clock,
            },
        );
    }

    fn remove_expired(&mut self, now: Instant) {
        self.entries.retain(|_, entry| entry.expires_at > now);
    }
}

#[derive(Clone)]
pub(super) struct DataKeyCache {
    state: Arc<Mutex<CacheState>>,
    gates: Arc<Mutex<HashMap<DataKeyCacheKey, Arc<Mutex<()>>>>>,
    enabled: bool,
}

impl DataKeyCache {
    pub fn new(max_entries: usize, ttl: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(CacheState {
                entries: HashMap::new(),
                max_entries,
                ttl,
                clock: 0,
            })),
            gates: Arc::new(Mutex::new(HashMap::new())),
            enabled: max_entries > 0 && !ttl.is_zero(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub async fn get(&self, cache_key: &DataKeyCacheKey) -> Option<Zeroizing<[u8; 32]>> {
        self.state.lock().await.get(cache_key, Instant::now())
    }

    pub async fn insert(&self, cache_key: DataKeyCacheKey, key: &[u8; 32]) {
        self.state
            .lock()
            .await
            .insert(cache_key, key, Instant::now());
    }

    pub async fn lock(&self, cache_key: &DataKeyCacheKey) -> DataKeyGate {
        let gate = self
            .gates
            .lock()
            .await
            .entry(cache_key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let guard = gate.clone().lock_owned().await;
        DataKeyGate {
            cache: self.clone(),
            cache_key: cache_key.clone(),
            gate: Some(gate),
            guard: Some(guard),
        }
    }
}

pub(super) struct DataKeyGate {
    cache: DataKeyCache,
    cache_key: DataKeyCacheKey,
    gate: Option<Arc<Mutex<()>>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for DataKeyGate {
    fn drop(&mut self) {
        self.guard.take();
        let cache = self.cache.clone();
        let cache_key = self.cache_key.clone();
        let Some(gate) = self.gate.take() else {
            return;
        };
        tokio::spawn(async move {
            let mut gates = cache.gates.lock().await;
            if Arc::strong_count(&gate) == 2
                && gates
                    .get(&cache_key)
                    .is_some_and(|candidate| Arc::ptr_eq(candidate, &gate))
            {
                gates.remove(&cache_key);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_key(value: u8) -> DataKeyCacheKey {
        DataKeyCacheKey::new("staging", Uuid::from_u128(u128::from(value)), [value; 32])
    }

    #[test]
    fn state_expires_and_evicts_least_recently_used_keys() {
        let start = Instant::now();
        let mut state = CacheState {
            entries: HashMap::new(),
            max_entries: 2,
            ttl: Duration::from_secs(30),
            clock: 0,
        };
        state.insert(cache_key(1), &[1; 32], start);
        state.insert(cache_key(2), &[2; 32], start);
        assert!(state.get(&cache_key(1), start).is_some());
        state.insert(cache_key(3), &[3; 32], start);
        assert!(state.get(&cache_key(1), start).is_some());
        assert!(state.get(&cache_key(2), start).is_none());
        assert!(state.get(&cache_key(3), start).is_some());
        assert!(state
            .get(&cache_key(1), start + Duration::from_secs(31))
            .is_none());
    }

    #[test]
    fn disabled_cache_never_retains_key_material() {
        let now = Instant::now();
        let mut state = CacheState {
            entries: HashMap::new(),
            max_entries: 0,
            ttl: Duration::from_secs(30),
            clock: 0,
        };
        state.insert(cache_key(1), &[1; 32], now);
        assert!(state.get(&cache_key(1), now).is_none());
    }

    #[tokio::test]
    async fn completed_singleflight_gates_are_removed() {
        let cache = DataKeyCache::new(2, Duration::from_secs(30));
        let key = cache_key(1);
        let gate = cache.lock(&key).await;
        assert_eq!(cache.gates.lock().await.len(), 1);
        drop(gate);
        tokio::task::yield_now().await;
        assert!(cache.gates.lock().await.is_empty());
    }
}
