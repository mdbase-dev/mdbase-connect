//! Live admission around the shared publish protocol's ORIGINAL platform futures.
//! A revoked in-flight mutation refuses certification and keeps recovery custody;
//! owned handle cleanup drains even when the admission gate closes.
use crate::platform::{
    Capabilities, DirEntry, FileMeta, FilePlatform, FlushScope, FsError, FsErrorKind, FsResult,
    Guarded, Holders, LockHandle, LockShare, PlatformEnvironment, RangeHandle, ReadResult, RelPath,
};
use mdbn_replica::store::Store;

pub(super) struct Admitted<'a, P, M> {
    pub p: &'a P,
    pub inner: &'a M,
}
impl<P, M: Store> Admitted<'_, P, M> {
    fn check(&self) -> FsResult<()> {
        mdbn_replica::mirror_admission::ensure_open(self.inner)
            .map_err(|e| FsError::new(FsErrorKind::Other, e.to_string()))
    }
}
macro_rules! gated {
    ($name:ident($($arg:ident: $ty:ty),*) -> $out:ty) => {
        async fn $name(&self, $($arg: $ty),*) -> FsResult<$out> {
            self.check()?;
            let result = self.p.$name($($arg),*).await;
            self.check()?;
            result
        }
    };
}
impl<P: FilePlatform, M: Store> FilePlatform for Admitted<'_, P, M> {
    fn capabilities(&self) -> &Capabilities {
        self.p.capabilities()
    }
    fn release_policy(&self) -> crate::ReleasePolicy {
        self.p.release_policy()
    }
    fn retained_nosync(&self) -> bool {
        self.p.retained_nosync()
    }
    gated!(environment() -> PlatformEnvironment);
    gated!(stat(path: &RelPath) -> FileMeta);
    gated!(read(path: &RelPath) -> ReadResult);
    gated!(read_range(path: &RelPath, offset: u64, len: u32) -> Vec<u8>);
    gated!(read_at(h: RangeHandle, offset: u64, len: u32) -> Vec<u8>);
    gated!(range_meta(h: RangeHandle) -> FileMeta);
    gated!(list(dir: &RelPath) -> Vec<DirEntry>);
    gated!(create_dir_all(dir: &RelPath) -> ());
    gated!(write_new(path: &RelPath, bytes: &[u8], durable: bool) -> FileMeta);
    gated!(append(path: &RelPath, bytes: &[u8]) -> ());
    gated!(rename_noreplace(from: &RelPath, to: &RelPath) -> ());
    gated!(remove_file(path: &RelPath) -> ());
    gated!(flush(scope: FlushScope) -> ());
    gated!(exchange(a: &RelPath, b: &RelPath) -> ());
    gated!(copy_metadata(from: &RelPath, to: &RelPath) -> ());
    gated!(locked_read(h: LockHandle) -> ReadResult);
    gated!(locked_overwrite(h: LockHandle, bytes: &[u8], durable: bool) -> ());
    gated!(locked_move_aside(h: LockHandle, to: &RelPath) -> ());
    gated!(other_holders(path: &RelPath) -> Holders);
    gated!(guarded_replace(path: &RelPath, expect: &[u8], new: &[u8]) -> Guarded);
    gated!(guarded_create(path: &RelPath, bytes: &[u8]) -> Guarded);
    gated!(guarded_trash(path: &RelPath, expect: &[u8]) -> Guarded);
    async fn lock(&self, path: &RelPath, share: LockShare) -> FsResult<LockHandle> {
        self.check()?;
        let handle = self.p.lock(path, share).await?;
        if let Err(e) = self.check() {
            self.p.unlock(handle).await?;
            return Err(e);
        }
        Ok(handle)
    }
    async fn open_range_read(&self, path: &RelPath) -> FsResult<(RangeHandle, FileMeta)> {
        self.check()?;
        let (handle, meta) = self.p.open_range_read(path).await?;
        if let Err(e) = self.check() {
            self.p.close_range_read(handle).await?;
            return Err(e);
        }
        Ok((handle, meta))
    }
    fn unlock(&self, h: LockHandle) -> impl std::future::Future<Output = FsResult<()>> {
        self.p.unlock(h)
    }
    fn close_range_read(&self, h: RangeHandle) -> impl std::future::Future<Output = FsResult<()>> {
        self.p.close_range_read(h)
    }
}
