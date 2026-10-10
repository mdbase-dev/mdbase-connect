//! A local-disk object store standing in for R2/S3 in local runs.
//!
//! Production uses R2 for both D2 candidates (`log-service-api.md` §6). Locally,
//! the gateway serves the same pre-signed-URL protocol from this directory.

use std::path::PathBuf;

use mdbn_log_service::backend::{Archive, ObjectStore};
use mdbn_log_service::error::{Result, ServiceError};
use mdbn_log_service::model::{RetentionTier, archive_object_key, archive_segment_key, object_key};
use mdbn_wire::common::{B32, Uuid};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Objects as files under a root directory; the archive is the `archive/`
/// directory beside them (expiry is left to an external sweep).
pub struct FsObjects {
    root: PathBuf,
}

impl FsObjects {
    /// A store rooted at `root` (created if missing).
    pub fn new(root: PathBuf) -> Self {
        std::fs::create_dir_all(&root).expect("object root");
        FsObjects { root }
    }
}

fn io(e: std::io::Error) -> ServiceError {
    ServiceError::backend(format!("object store: {e}"))
}

fn bounded_buffer(length: u64) -> Result<Vec<u8>> {
    if length > mdbn_log_service::limits::MAX_OBJECT_BYTES {
        return Err(ServiceError::backend("object size"));
    }
    let length = usize::try_from(length).map_err(|_| ServiceError::backend("object size"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| ServiceError::backend("object allocation"))?;
    bytes.resize(length, 0);
    Ok(bytes)
}

impl ObjectStore for FsObjects {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let path = self.root.join(key);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .map_err(io)?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).expect("entropy");
        let tmp = path.with_extension(format!("tmp{}", u64::from_le_bytes(nonce)));
        tokio::fs::write(&tmp, &bytes).await.map_err(io)?;
        tokio::fs::rename(&tmp, &path).await.map_err(io)
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        let path = self.root.join(key);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .map_err(io)?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).expect("entropy");
        let tmp = path.with_extension(format!("new{}", u64::from_le_bytes(nonce)));
        tokio::fs::write(&tmp, &bytes).await.map_err(io)?;
        // link(2) fails if the target exists: write-once.
        let r = tokio::fs::hard_link(&tmp, &path).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        match r {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(io(e)),
        }
    }

    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Option<Vec<u8>>> {
        let path = self.root.join(key);
        let mut f = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io(e)),
        };
        // Inspect actual backing size before allocation, not just the signed
        // metadata size. Also avoid read_to_end growth if a file is replaced or
        // modified outside this immutable store while a read is in flight.
        let flen = f.metadata().await.map_err(io)?.len();
        if flen > mdbn_log_service::limits::MAX_OBJECT_BYTES {
            return Err(ServiceError::backend("object size"));
        }
        match range {
            None => {
                let mut v = bounded_buffer(flen)?;
                f.read_exact(&mut v).await.map_err(io)?;
                let mut extra = [0u8; 1];
                if f.read(&mut extra).await.map_err(io)? != 0 {
                    return Err(ServiceError::backend("object changed"));
                }
                Ok(Some(v))
            }
            Some((off, len)) => {
                if off.checked_add(len).is_none_or(|end| end > flen)
                    || len > mdbn_log_service::limits::MAX_OBJECT_BYTES
                {
                    return Err(ServiceError::invalid("range"));
                }
                f.seek(std::io::SeekFrom::Start(off)).await.map_err(io)?;
                let mut v = bounded_buffer(len)?;
                f.read_exact(&mut v).await.map_err(io)?;
                Ok(Some(v))
            }
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        match tokio::fs::remove_file(self.root.join(key)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        }
    }
}

impl Archive for FsObjects {
    async fn put_segment(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.put(&archive_segment_key(collection, tier, from, to), bytes)
            .await
    }

    async fn archive_object(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        address: &B32,
    ) -> Result<()> {
        let src = self.root.join(object_key(collection, address));
        let dst = self
            .root
            .join(archive_object_key(collection, tier, address));
        tokio::fs::create_dir_all(dst.parent().unwrap())
            .await
            .map_err(io)?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).expect("entropy");
        let tmp = dst.with_extension(format!("tmp{}", u64::from_le_bytes(nonce)));
        // A filesystem copy (no buffering here), then an atomic rename.
        match tokio::fs::copy(&src, &tmp).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io(e)),
            Ok(_) => {}
        }
        let r = tokio::fs::rename(&tmp, &dst).await.map_err(io);
        if r.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
        r
    }
}
