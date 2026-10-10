//! The host queue: a [`FilePlatform`] whose operations are performed by
//! someone else, later.
//!
//! The WASM runtime cannot call the Obsidian vault API synchronously, and the
//! simulator wants to decide when (and whether, before a crash) each operation
//! completes. Both use [`QueuedPlatform`]:
//!
//! 1. the store calls a [`FilePlatform`] method; the call records a [`FileOp`]
//!    with a fresh [`OpId`] and returns a pending future;
//! 2. the host drains requests with [`HostQueue::take_requests`], performs them
//!    in any order (the vault API, IndexedDB, a simulated OS), and reports each
//!    result with [`HostQueue::complete`];
//! 3. the host then polls the store again, and the future resolves.
//!
//! [`FileOp`] is the request vocabulary the Obsidian runtime implements in TS.
//! Its byte encoding over the raw WASM ABI is defined with the `mdbn-wasm` ABI;
//! the variants here are the contract.
//!
//! Operations the host's platform does not support must complete with
//! [`FsErrorKind::Unsupported`], consistent with the [`Capabilities`] the host
//! declared.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};

use crate::platform::{
    Capabilities, DirEntry, FileMeta, FilePlatform, FlushScope, FsError, FsErrorKind, FsResult,
    Guarded, Holders, LockHandle, LockShare, PlatformEnvironment, ReadResult, RelPath,
};

/// Identifies one queued operation. Unique per queue, increasing.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct OpId(pub u64);

/// One file operation for the host to perform. Mirrors [`FilePlatform`]; see
/// its methods for semantics.
#[derive(Clone, PartialEq, Eq, Debug)]
#[allow(missing_docs)] // fields are the trait method parameters of the same names
pub enum FileOp {
    Environment,
    Stat {
        path: RelPath,
    },
    Read {
        path: RelPath,
    },
    ReadRange {
        path: RelPath,
        offset: u64,
        len: u32,
    },
    List {
        dir: RelPath,
    },
    CreateDirAll {
        dir: RelPath,
    },
    WriteNew {
        path: RelPath,
        bytes: Vec<u8>,
        durable: bool,
    },
    Append {
        path: RelPath,
        bytes: Vec<u8>,
    },
    RenameNoreplace {
        from: RelPath,
        to: RelPath,
    },
    RemoveFile {
        path: RelPath,
    },
    Flush {
        scope: FlushScope,
    },
    Exchange {
        a: RelPath,
        b: RelPath,
    },
    CopyMetadata {
        from: RelPath,
        to: RelPath,
    },
    Lock {
        path: RelPath,
        share: LockShare,
    },
    LockedRead {
        handle: LockHandle,
    },
    LockedOverwrite {
        handle: LockHandle,
        bytes: Vec<u8>,
        durable: bool,
    },
    LockedMoveAside {
        handle: LockHandle,
        to: RelPath,
    },
    Unlock {
        handle: LockHandle,
    },
    GuardedReplace {
        path: RelPath,
        expect: Vec<u8>,
        new: Vec<u8>,
    },
    GuardedCreate {
        path: RelPath,
        bytes: Vec<u8>,
    },
    OtherHolders {
        path: RelPath,
    },
    GuardedTrash {
        path: RelPath,
        expect: Vec<u8>,
    },
}

/// A successful operation's value. The variant must match the operation:
/// `Unit` for operations returning `()`, and so on.
#[derive(Clone, PartialEq, Eq, Debug)]
#[allow(missing_docs)]
pub enum FileOpOutput {
    Unit,
    Environment(PlatformEnvironment),
    Meta(FileMeta),
    Read(ReadResult),
    Bytes(Vec<u8>),
    Entries(Vec<DirEntry>),
    Lock(LockHandle),
    Guarded(Guarded),
    Holders(Holders),
}

/// The completion of one operation.
pub type FileOpResult = FsResult<FileOpOutput>;

#[derive(Default)]
struct Queue {
    next: u64,
    requests: VecDeque<(OpId, FileOp)>,
    done: BTreeMap<OpId, FileOpResult>,
    collected: u64,
}

/// The host's side of a [`QueuedPlatform`].
#[derive(Clone, Default)]
pub struct HostQueue(Rc<RefCell<Queue>>);

impl HostQueue {
    /// Every operation submitted since the last call, in submission order.
    pub fn take_requests(&self) -> Vec<(OpId, FileOp)> {
        self.0.borrow_mut().requests.drain(..).collect()
    }

    /// Report the result of `id`. Completing an unknown or already completed id
    /// is ignored (a host may race a shutdown).
    pub fn complete(&self, id: OpId, result: FileOpResult) {
        let mut q = self.0.borrow_mut();
        if id.0 < q.next {
            q.done.entry(id).or_insert(result);
        }
    }

    /// Operations submitted whose results the store has not collected yet.
    pub fn in_flight(&self) -> u64 {
        let q = self.0.borrow();
        q.next - q.collected
    }
}

/// A [`FilePlatform`] whose operations are performed by the host through a
/// [`HostQueue`].
pub struct QueuedPlatform {
    caps: Capabilities,
    queue: HostQueue,
}

impl QueuedPlatform {
    /// A platform with the host's declared capabilities, and the queue the host
    /// serves.
    pub fn new(caps: Capabilities) -> (QueuedPlatform, HostQueue) {
        let queue = HostQueue::default();
        (
            QueuedPlatform {
                caps,
                queue: queue.clone(),
            },
            queue,
        )
    }

    fn submit(&self, op: FileOp) -> OpFuture {
        let mut q = self.queue.0.borrow_mut();
        let id = OpId(q.next);
        q.next += 1;
        q.requests.push_back((id, op));
        OpFuture {
            id,
            queue: self.queue.clone(),
        }
    }
}

/// Resolves when the host completes the operation.
struct OpFuture {
    id: OpId,
    queue: HostQueue,
}

impl Future for OpFuture {
    type Output = FileOpResult;

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<FileOpResult> {
        // The store's task loop re-polls every pending task after the host
        // completes operations, so no waker is registered.
        let mut q = self.queue.0.borrow_mut();
        match q.done.remove(&self.id) {
            Some(r) => {
                q.collected += 1;
                Poll::Ready(r)
            }
            None => Poll::Pending,
        }
    }
}

fn mismatch(want: &str, got: &FileOpOutput) -> FsError {
    FsError::new(
        FsErrorKind::Other,
        format!("host completed a {want} operation with {got:?}"),
    )
}

macro_rules! expect_output {
    ($fut:expr, $want:literal, $pat:pat => $val:expr) => {{
        let fut = $fut;
        async move {
            match fut.await? {
                $pat => Ok($val),
                other => Err(mismatch($want, &other)),
            }
        }
    }};
}

impl FilePlatform for QueuedPlatform {
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn environment(&self) -> impl Future<Output = FsResult<PlatformEnvironment>> {
        expect_output!(self.submit(FileOp::Environment), "environment", FileOpOutput::Environment(e) => e)
    }

    fn stat(&self, path: &RelPath) -> impl Future<Output = FsResult<FileMeta>> {
        expect_output!(self.submit(FileOp::Stat { path: path.clone() }), "stat", FileOpOutput::Meta(m) => m)
    }

    fn read(&self, path: &RelPath) -> impl Future<Output = FsResult<ReadResult>> {
        expect_output!(self.submit(FileOp::Read { path: path.clone() }), "read", FileOpOutput::Read(r) => r)
    }

    fn read_range(
        &self,
        path: &RelPath,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        let op = FileOp::ReadRange {
            path: path.clone(),
            offset,
            len,
        };
        expect_output!(self.submit(op), "read_range", FileOpOutput::Bytes(b) => b)
    }

    fn list(&self, dir: &RelPath) -> impl Future<Output = FsResult<Vec<DirEntry>>> {
        expect_output!(self.submit(FileOp::List { dir: dir.clone() }), "list", FileOpOutput::Entries(e) => e)
    }

    fn create_dir_all(&self, dir: &RelPath) -> impl Future<Output = FsResult<()>> {
        expect_output!(self.submit(FileOp::CreateDirAll { dir: dir.clone() }), "create_dir_all", FileOpOutput::Unit => ())
    }

    fn write_new(
        &self,
        path: &RelPath,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<FileMeta>> {
        let op = FileOp::WriteNew {
            path: path.clone(),
            bytes: bytes.to_vec(),
            durable,
        };
        expect_output!(self.submit(op), "write_new", FileOpOutput::Meta(m) => m)
    }

    fn append(&self, path: &RelPath, bytes: &[u8]) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::Append {
            path: path.clone(),
            bytes: bytes.to_vec(),
        };
        expect_output!(self.submit(op), "append", FileOpOutput::Unit => ())
    }

    fn rename_noreplace(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::RenameNoreplace {
            from: from.clone(),
            to: to.clone(),
        };
        expect_output!(self.submit(op), "rename_noreplace", FileOpOutput::Unit => ())
    }

    fn remove_file(&self, path: &RelPath) -> impl Future<Output = FsResult<()>> {
        expect_output!(self.submit(FileOp::RemoveFile { path: path.clone() }), "remove_file", FileOpOutput::Unit => ())
    }

    fn flush(&self, scope: FlushScope) -> impl Future<Output = FsResult<()>> {
        expect_output!(self.submit(FileOp::Flush { scope }), "flush", FileOpOutput::Unit => ())
    }

    fn exchange(&self, a: &RelPath, b: &RelPath) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::Exchange {
            a: a.clone(),
            b: b.clone(),
        };
        expect_output!(self.submit(op), "exchange", FileOpOutput::Unit => ())
    }

    fn copy_metadata(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::CopyMetadata {
            from: from.clone(),
            to: to.clone(),
        };
        expect_output!(self.submit(op), "copy_metadata", FileOpOutput::Unit => ())
    }

    fn lock(&self, path: &RelPath, share: LockShare) -> impl Future<Output = FsResult<LockHandle>> {
        let op = FileOp::Lock {
            path: path.clone(),
            share,
        };
        expect_output!(self.submit(op), "lock", FileOpOutput::Lock(h) => h)
    }

    fn locked_read(&self, handle: LockHandle) -> impl Future<Output = FsResult<ReadResult>> {
        expect_output!(self.submit(FileOp::LockedRead { handle }), "locked_read", FileOpOutput::Read(r) => r)
    }

    fn locked_overwrite(
        &self,
        handle: LockHandle,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::LockedOverwrite {
            handle,
            bytes: bytes.to_vec(),
            durable,
        };
        expect_output!(self.submit(op), "locked_overwrite", FileOpOutput::Unit => ())
    }

    fn locked_move_aside(
        &self,
        handle: LockHandle,
        to: &RelPath,
    ) -> impl Future<Output = FsResult<()>> {
        let op = FileOp::LockedMoveAside {
            handle,
            to: to.clone(),
        };
        expect_output!(self.submit(op), "locked_move_aside", FileOpOutput::Unit => ())
    }

    fn unlock(&self, handle: LockHandle) -> impl Future<Output = FsResult<()>> {
        expect_output!(self.submit(FileOp::Unlock { handle }), "unlock", FileOpOutput::Unit => ())
    }

    fn guarded_replace(
        &self,
        path: &RelPath,
        expect: &[u8],
        new: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let op = FileOp::GuardedReplace {
            path: path.clone(),
            expect: expect.to_vec(),
            new: new.to_vec(),
        };
        expect_output!(self.submit(op), "guarded_replace", FileOpOutput::Guarded(g) => g)
    }

    fn guarded_create(
        &self,
        path: &RelPath,
        bytes: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let op = FileOp::GuardedCreate {
            path: path.clone(),
            bytes: bytes.to_vec(),
        };
        expect_output!(self.submit(op), "guarded_create", FileOpOutput::Guarded(g) => g)
    }

    fn other_holders(&self, path: &RelPath) -> impl Future<Output = FsResult<Holders>> {
        expect_output!(self.submit(FileOp::OtherHolders { path: path.clone() }), "other_holders", FileOpOutput::Holders(h) => h)
    }

    fn guarded_trash(
        &self,
        path: &RelPath,
        expect: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let op = FileOp::GuardedTrash {
            path: path.clone(),
            expect: expect.to_vec(),
        };
        expect_output!(self.submit(op), "guarded_trash", FileOpOutput::Guarded(g) => g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{CaseSensitivity, Durability, EventFidelity, FileKind, ReplaceStrategy};
    use std::task::Waker;

    fn caps() -> Capabilities {
        Capabilities {
            replace: ReplaceStrategy::GuardedInPlace,
            exclusive_create: false,
            durability: Durability::None,
            case: CaseSensitivity::Insensitive,
            file_ids: false,
            mtime_resolution_ns: 1_000_000,
            events: EventFidelity::Hint,
            transient_missing: false,
            private_dir: RelPath::new(".mdbase").unwrap(),
        }
    }

    fn poll<F: Future>(f: Pin<&mut F>) -> Poll<F::Output> {
        f.poll(&mut Context::from_waker(Waker::noop()))
    }

    #[test]
    fn ops_complete_out_of_order() {
        let (p, host) = QueuedPlatform::new(caps());
        let a = RelPath::new("a.md").unwrap();
        let b = RelPath::new("b.md").unwrap();
        let mut fa = Box::pin(p.stat(&a));
        let mut fb = Box::pin(p.guarded_replace(&b, b"old", b"new"));
        assert!(poll(fa.as_mut()).is_pending());
        assert!(poll(fb.as_mut()).is_pending());

        let reqs = host.take_requests();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].1, FileOp::Stat { path: a.clone() });
        assert!(matches!(&reqs[1].1, FileOp::GuardedReplace { expect, .. } if expect == b"old"));
        assert_eq!(host.in_flight(), 2);

        host.complete(
            reqs[1].0,
            Ok(FileOpOutput::Guarded(Guarded::Mismatch(b"user".to_vec()))),
        );
        assert!(poll(fa.as_mut()).is_pending());
        assert_eq!(
            poll(fb.as_mut()),
            Poll::Ready(Ok(Guarded::Mismatch(b"user".to_vec())))
        );
        let meta = FileMeta {
            kind: FileKind::File,
            size: 3,
            mtime_ns: 7,
            ctime_ns: None,
            id: None,
        };
        host.complete(reqs[0].0, Ok(FileOpOutput::Meta(meta.clone())));
        assert_eq!(poll(fa.as_mut()), Poll::Ready(Ok(meta)));
        assert_eq!(host.in_flight(), 0);
    }

    #[test]
    fn wrong_output_and_errors() {
        let (p, host) = QueuedPlatform::new(caps());
        let a = RelPath::new("a.md").unwrap();
        let mut f1 = Box::pin(p.read(&a));
        let mut f2 = Box::pin(p.exchange(&a, &a));
        let reqs = host.take_requests();
        host.complete(reqs[0].0, Ok(FileOpOutput::Unit));
        host.complete(reqs[1].0, Err(FsError::unsupported("exchange")));
        // A duplicate completion is ignored.
        host.complete(reqs[1].0, Ok(FileOpOutput::Unit));
        // An id that was never issued is ignored.
        host.complete(OpId(99), Ok(FileOpOutput::Unit));
        match poll(f1.as_mut()) {
            Poll::Ready(Err(e)) => assert_eq!(e.kind, FsErrorKind::Other),
            other => panic!("{other:?}"),
        }
        match poll(f2.as_mut()) {
            Poll::Ready(Err(e)) => assert_eq!(e.kind, FsErrorKind::Unsupported),
            other => panic!("{other:?}"),
        }
    }
}
