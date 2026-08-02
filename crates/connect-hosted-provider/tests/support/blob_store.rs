use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Utc;
use futures_util::stream;
use mdbase_connect_hosted_provider::{
    ApiError, ApiResult, BlobByteStream, BlobStore, PresignedPart, UploadedPart,
};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyCheckpoint {
    /// Pause after the destination has become visible.
    AfterPublish,
    /// Snapshot the source, then pause before the destination becomes visible.
    BeforePublish,
}

#[derive(Default)]
struct GateState {
    armed: Option<CopyCheckpoint>,
    reached: bool,
    released: bool,
}

#[derive(Default)]
struct CopyGate {
    state: Mutex<GateState>,
    changed: Notify,
}

impl CopyGate {
    async fn arm(&self, checkpoint: CopyCheckpoint) {
        *self.state.lock().await = GateState {
            armed: Some(checkpoint),
            reached: false,
            released: false,
        };
    }

    async fn checkpoint(&self, checkpoint: CopyCheckpoint) {
        let should_pause = {
            let mut state = self.state.lock().await;
            if state.armed == Some(checkpoint) {
                state.reached = true;
                self.changed.notify_waiters();
                true
            } else {
                false
            }
        };
        if !should_pause {
            return;
        }
        loop {
            let notified = self.changed.notified();
            if self.state.lock().await.released {
                return;
            }
            notified.await;
        }
    }

    async fn wait_until_reached(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let notified = self.changed.notified();
                if self.state.lock().await.reached {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("copy checkpoint was not reached");
    }

    async fn release(&self) {
        self.state.lock().await.released = true;
        self.changed.notify_waiters();
    }
}

#[derive(Clone, Default)]
pub struct ControlledBlobStore {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    copy_gate: Arc<CopyGate>,
    delete_gate: Arc<CopyGate>,
    delete_failures_remaining: Arc<Mutex<u32>>,
}

impl ControlledBlobStore {
    pub async fn put(&self, key: impl Into<String>, bytes: impl Into<Vec<u8>>) {
        self.objects.lock().await.insert(key.into(), bytes.into());
    }

    pub async fn contains(&self, key: &str) -> bool {
        self.objects.lock().await.contains_key(key)
    }

    pub async fn keys(&self) -> Vec<String> {
        self.objects.lock().await.keys().cloned().collect()
    }

    pub async fn arm_copy(&self, checkpoint: CopyCheckpoint) {
        self.copy_gate.arm(checkpoint).await;
    }

    pub async fn wait_for_copy(&self) {
        self.copy_gate.wait_until_reached().await;
    }

    pub async fn release_copy(&self) {
        self.copy_gate.release().await;
    }

    pub async fn fail_next_delete(&self) {
        *self.delete_failures_remaining.lock().await += 1;
    }

    pub async fn arm_delete(&self) {
        self.delete_gate.arm(CopyCheckpoint::BeforePublish).await;
    }

    pub async fn wait_for_delete(&self) {
        self.delete_gate.wait_until_reached().await;
    }

    pub async fn release_delete(&self) {
        self.delete_gate.release().await;
    }
}

#[async_trait]
impl BlobStore for ControlledBlobStore {
    fn upload_part_size(&self) -> u64 {
        5 * 1024 * 1024
    }

    fn download_part_size(&self) -> u64 {
        5 * 1024 * 1024
    }

    async fn ready(&self) -> ApiResult<()> {
        Ok(())
    }

    async fn create_multipart(&self, key: &str) -> ApiResult<String> {
        Ok(format!("multipart:{key}"))
    }

    async fn presign_put(&self, key: &str, _content_length: u64) -> ApiResult<PresignedPart> {
        Ok(presigned(key))
    }

    async fn presign_part(
        &self,
        key: &str,
        _upload_id: &str,
        _part_number: i32,
        _content_length: u64,
    ) -> ApiResult<PresignedPart> {
        Ok(presigned(key))
    }

    async fn complete_multipart(
        &self,
        _key: &str,
        _upload_id: &str,
        _parts: &[UploadedPart],
    ) -> ApiResult<()> {
        Ok(())
    }

    async fn list_multipart_parts(
        &self,
        _key: &str,
        _upload_id: &str,
    ) -> ApiResult<Vec<UploadedPart>> {
        Ok(Vec::new())
    }

    async fn abort_multipart(&self, _key: &str, _upload_id: &str) -> ApiResult<()> {
        Ok(())
    }

    async fn object_exists(&self, key: &str) -> ApiResult<bool> {
        Ok(self.contains(key).await)
    }

    async fn copy(&self, source_key: &str, destination_key: &str) -> ApiResult<()> {
        let bytes = self
            .objects
            .lock()
            .await
            .get(source_key)
            .cloned()
            .ok_or_else(|| missing_object(source_key))?;
        self.copy_gate
            .checkpoint(CopyCheckpoint::BeforePublish)
            .await;
        self.objects
            .lock()
            .await
            .insert(destination_key.to_string(), bytes);
        self.copy_gate
            .checkpoint(CopyCheckpoint::AfterPublish)
            .await;
        Ok(())
    }

    async fn verify_object(&self, key: &str, size: u64, content_digest: &str) -> ApiResult<()> {
        let objects = self.objects.lock().await;
        let bytes = objects.get(key).ok_or_else(|| missing_object(key))?;
        let digest = format!("sha256:{:x}", Sha256::digest(bytes));
        if bytes.len() as u64 != size || digest != content_digest {
            return Err(ApiError::conflict(
                "file_object_mismatch",
                format!("Object {key} does not match its declared content."),
            ));
        }
        Ok(())
    }

    async fn read_range(&self, key: &str, offset: u64, length: u64) -> ApiResult<BlobByteStream> {
        let objects = self.objects.lock().await;
        let bytes = objects.get(key).ok_or_else(|| missing_object(key))?;
        let start = usize::try_from(offset).map_err(|_| missing_object(key))?;
        let end =
            usize::try_from(offset.saturating_add(length)).map_err(|_| missing_object(key))?;
        let range = bytes
            .get(start..end)
            .map(ToOwned::to_owned)
            .ok_or_else(|| missing_object(key))?;
        Ok(Box::pin(stream::once(async move { Ok(range.into()) })))
    }

    async fn delete(&self, key: &str) -> ApiResult<()> {
        let mut failures = self.delete_failures_remaining.lock().await;
        if *failures > 0 {
            *failures -= 1;
            return Err(ApiError::internal("injected object deletion failure"));
        }
        drop(failures);
        self.delete_gate
            .checkpoint(CopyCheckpoint::BeforePublish)
            .await;
        self.objects.lock().await.remove(key);
        Ok(())
    }
}

fn presigned(key: &str) -> PresignedPart {
    PresignedPart {
        method: "PUT".to_string(),
        url: format!("https://objects.invalid/{key}"),
        headers: BTreeMap::new(),
        expires_at: Utc::now() + chrono::Duration::minutes(5),
    }
}

fn missing_object(key: &str) -> ApiError {
    ApiError::conflict(
        "file_object_missing",
        format!("Object {key} does not exist."),
    )
}
