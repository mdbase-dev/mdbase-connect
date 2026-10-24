//! CLI-only immutable-stage reads. The verification library performs no I/O.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "Native offline IO requires retained OS file identities; no application platform dependency"
)]
use mdbn_backup_verify::{OwnedBytes, Refusal};
use mdbn_log_service::{OfflineDecodeBudget, OfflineOwnedReservation};
use mdbn_wire::{common::B32, hash::sha256};
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const READ_LIMIT: u64 = 256 * 1024 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Default)]
pub(crate) struct Reads {
    admitted: u64,
    failed: bool,
}
impl Reads {
    fn admit(&mut self, requested: usize) -> Result<(), Refusal> {
        if self.failed {
            return Err(Refusal::Bounds);
        }
        match self
            .admitted
            .checked_add(requested as u64)
            .filter(|bytes| *bytes <= READ_LIMIT)
        {
            Some(bytes) => {
                self.admitted = bytes;
                Ok(())
            }
            None => {
                self.failed = true;
                Err(Refusal::Bounds)
            }
        }
    }
    fn charge(&mut self, requested: usize, work: &OfflineDecodeBudget) -> Result<(), Refusal> {
        self.admit(requested)?;
        // Fixed stack-only canonical bytestring is a conservative cost token,
        // NOT an input validator. Charge the SAME invocation ledger BEFORE IO
        // or hashing; one token per <=64KiB, including zero/EOF probes. The
        // ordinary real-input parser/validator still runs and charges separately.
        let mut token = [0u8; CHUNK + 5];
        token[..5].copy_from_slice(&[0x5a, 0, 1, 0, 0]);
        for _ in 0..requested.max(1).div_ceil(CHUNK) {
            if work.request().preflight(&token).is_err() {
                self.failed = true;
                return Err(Refusal::Bounds);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Identity {
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    links: u64,
    modified: i64,
    modified_ns: i64,
    changed: i64,
    changed_ns: i64,
}
impl Identity {
    #[cfg(target_os = "linux")]
    pub(crate) fn capture(metadata: &Metadata) -> Result<Self, Refusal> {
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file() {
            return Err(Refusal::Io);
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            modified: metadata.mtime(),
            modified_ns: metadata.mtime_nsec(),
            changed: metadata.ctime(),
            changed_ns: metadata.ctime_nsec(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn capture(_: &Metadata) -> Result<Self, Refusal> {
        Err(Refusal::Io)
    }
}

pub(crate) struct FrozenFile {
    file: Option<File>,
    path: PathBuf,
    identity: Identity,
    fingerprint: Option<B32>,
    maximum: usize,
    work: OfflineDecodeBudget,
    // Path/handle bookkeeping is destroyed before releasing this allowance.
    _allocation: OfflineOwnedReservation,
}
impl FrozenFile {
    pub(crate) fn admit_expected(
        path: &Path,
        maximum: usize,
        expected: Identity,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let file = Self::admit(path, maximum, work)?;
        if file.identity != expected {
            let _ = work.reserve_owned(u64::MAX);
            return Err(Refusal::Io);
        }
        Ok(file)
    }

    pub(crate) fn admit(
        path: &Path,
        maximum: usize,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let result = Self::admit_checked(path, maximum, work);
        if result.is_err() {
            let _ = work.reserve_owned(u64::MAX);
        }
        result
    }
    fn admit_checked(
        path: &Path,
        maximum: usize,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let capacity = path
            .as_os_str()
            .as_encoded_bytes()
            .len()
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(1024))
            .ok_or(Refusal::Bounds)?;
        let allocation = work
            .reserve_owned(capacity as u64)
            .map_err(|_| Refusal::Bounds)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| Refusal::Io)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(Refusal::Layout);
        }
        if metadata.len() > maximum as u64 {
            return Err(Refusal::Bounds);
        }
        let identity = Identity::capture(&metadata)?;
        let file = File::open(path).map_err(|_| Refusal::Io)?;
        if Identity::capture(&file.metadata().map_err(|_| Refusal::Io)?)? != identity {
            return Err(Refusal::Io);
        }
        let result = Self {
            file: Some(file),
            path: path.to_owned(),
            identity,
            fingerprint: None,
            maximum,
            work: work.clone(),
            _allocation: allocation,
        };
        result.recheck()?;
        Ok(result)
    }
    pub(crate) fn recheck(&self) -> Result<(), Refusal> {
        let result = self.recheck_checked();
        if result.is_err() {
            let _ = self.work.reserve_owned(u64::MAX);
        }
        result
    }
    fn recheck_checked(&self) -> Result<(), Refusal> {
        let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| Refusal::Io)?;
        if current.file_type().is_symlink()
            || Identity::capture(&current)? != self.identity
            || self
                .file
                .as_ref()
                .map(|file| {
                    Identity::capture(&file.metadata().map_err(|_| Refusal::Io)?)
                        .map(|identity| identity != self.identity)
                })
                .transpose()?
                .unwrap_or(false)
        {
            return Err(Refusal::Io);
        }
        Ok(())
    }
    pub(crate) fn verify_at_completion(&mut self, reads: &mut Reads) -> Result<(), Refusal> {
        if self.fingerprint.is_none() {
            let _ = self.work.reserve_owned(u64::MAX);
            return Err(Refusal::Io);
        }
        self.read(reads).map(drop)?;
        self.close_handle();
        Ok(())
    }

    /// Retain identity/path/fingerprint, not one descriptor per inventory row.
    /// A later read must reopen and compare against the ORIGINAL identity.
    pub(crate) fn close_handle(&mut self) {
        self.file = None;
    }

    pub(crate) fn read(&mut self, reads: &mut Reads) -> Result<OwnedBytes, Refusal> {
        let work = self.work.clone();
        let result = self.read_checked(&work, reads);
        if result.is_err() {
            let _ = work.reserve_owned(u64::MAX);
        }
        result
    }
    fn read_checked(
        &mut self,
        work: &OfflineDecodeBudget,
        reads: &mut Reads,
    ) -> Result<OwnedBytes, Refusal> {
        self.recheck()?;
        if self.file.is_none() {
            let file = File::open(&self.path).map_err(|_| Refusal::Io)?;
            if Identity::capture(&file.metadata().map_err(|_| Refusal::Io)?)? != self.identity {
                return Err(Refusal::Io);
            }
            self.file = Some(file);
            self.recheck()?;
        }
        let length = usize::try_from(self.identity.length).map_err(|_| Refusal::Bounds)?;
        let capacity = length
            .checked_add(1)
            .filter(|capacity| *capacity <= self.maximum.saturating_add(1))
            .ok_or(Refusal::Bounds)?;
        let mut bytes = OwnedBytes::allocate(work, capacity)?;
        self.file
            .as_mut()
            .ok_or(Refusal::Io)?
            .seek(SeekFrom::Start(0))
            .map_err(|_| Refusal::Io)?;
        let mut total = 0;
        while total < capacity {
            let requested = (capacity - total).min(CHUNK);
            // Conservative admission BEFORE every read, including EOF/interrupt
            // probes. No per-file or per-pass reset; never an unbounded read_to_end.
            reads.charge(requested, work)?;
            let count = match self
                .file
                .as_mut()
                .ok_or(Refusal::Io)?
                .read(&mut bytes.fill_slice()[total..total + requested])
            {
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(Refusal::Io),
            };
            if count == 0 {
                break;
            }
            total = total.checked_add(count).ok_or(Refusal::Bounds)?;
            if total > self.maximum {
                return Err(Refusal::Bounds);
            }
        }
        self.recheck()?;
        if total != length {
            return Err(Refusal::Io);
        }
        bytes.truncate(total);
        // Metadata can have coarse timestamp resolution. Retain exact-byte
        // identity across passes too, using the existing shared wire hash.
        // Charge this additional memory scan conservatively BEFORE execution.
        reads.charge(total, work)?;
        let fingerprint = sha256(bytes.as_slice());
        if self
            .fingerprint
            .is_some_and(|original| original != fingerprint)
        {
            return Err(Refusal::Io);
        }
        self.fingerprint = Some(fingerprint);
        Ok(bytes)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join(format!(
                    ".reader-fixture-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn exact_limit_and_repeated_passes_keep_same_open_identity_and_read_counter() {
        let fixture = Fixture::new();
        let path = fixture.file("value", &[7; 32]);
        let work = OfflineDecodeBudget::new();
        let mut reads = Reads::default();
        let mut file = FrozenFile::admit(&path, 32, &work).unwrap();
        assert_eq!(file.read(&mut reads).unwrap().as_slice(), &[7; 32]);
        let first = reads.admitted;
        file.close_handle();
        assert!(file.file.is_none());
        assert_eq!(file.read(&mut reads).unwrap().as_slice(), &[7; 32]);
        assert_eq!(reads.admitted, first * 2);
        file.verify_at_completion(&mut reads).unwrap();
        assert_eq!(reads.admitted, first * 3);
        file.recheck().unwrap();
    }
    #[test]
    fn oversized_metadata_and_symlinks_refuse_before_allocation_or_decode() {
        let fixture = Fixture::new();
        let path = fixture.file("value", &[7; 33]);
        let work = OfflineDecodeBudget::new();
        assert!(matches!(
            FrozenFile::admit(&path, 32, &work),
            Err(Refusal::Bounds)
        ));
        assert!(work.request().raw(&[0xf6]).is_err());
        let link = fixture.0.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(matches!(
            FrozenFile::admit(&link, 64, &OfflineDecodeBudget::new()),
            Err(Refusal::Layout)
        ));
    }
    #[test]
    fn replacement_and_same_length_mutation_refuse_content_free_across_passes() {
        let fixture = Fixture::new();
        let path = fixture.file("value", &[7; 32]);
        let work = OfflineDecodeBudget::new();
        let mut reads = Reads::default();
        let mut file = FrozenFile::admit(&path, 32, &work).unwrap();
        file.read(&mut reads).unwrap();
        file.close_handle();
        fs::write(&path, [8; 32]).unwrap();
        assert_eq!(file.read(&mut reads).err(), Some(Refusal::Io));
        let work = OfflineDecodeBudget::new();
        let mut file = FrozenFile::admit(&path, 32, &work).unwrap();
        file.read(&mut reads).unwrap();
        file.close_handle();
        let replacement = fixture.file("replacement", &[8; 32]);
        fs::rename(replacement, &path).unwrap();
        assert!(matches!(file.read(&mut reads), Err(Refusal::Io)));
        assert!(work.reserve_owned(0).is_err());
    }
    #[test]
    fn final_byte_check_rejects_mutation_or_a_never_read_file() {
        let fixture = Fixture::new();
        let path = fixture.file("value", &[7; 32]);
        let work = OfflineDecodeBudget::new();
        let mut reads = Reads::default();
        let mut file = FrozenFile::admit(&path, 32, &work).unwrap();
        file.read(&mut reads).unwrap();
        fs::write(&path, [8; 32]).unwrap();
        assert_eq!(file.verify_at_completion(&mut reads), Err(Refusal::Io));
        let work = OfflineDecodeBudget::new();
        let mut file = FrozenFile::admit(&path, 32, &work).unwrap();
        assert_eq!(file.verify_at_completion(&mut reads), Err(Refusal::Io));
        assert!(work.reserve_owned(0).is_err());
    }

    #[test]
    fn expected_identity_matches_and_drift_refuses_before_first_read() {
        let fixture = Fixture::new();
        let path = fixture.file("value", &[7; 32]);
        let identity = Identity::capture(&fs::metadata(&path).unwrap()).unwrap();
        let work = OfflineDecodeBudget::new();
        assert!(FrozenFile::admit_expected(&path, 32, identity, &work).is_ok());
        let mut wrong = identity;
        wrong.length += 1;
        assert!(matches!(
            FrozenFile::admit_expected(&path, 32, wrong, &work),
            Err(Refusal::Io)
        ));
        assert!(work.reserve_owned(0).is_err());
    }
    #[test]
    fn cumulative_read_boundary_and_overflow_refuse_before_read() {
        let mut reads = Reads {
            admitted: READ_LIMIT - 1,
            ..Reads::default()
        };
        reads.admit(1).unwrap();
        assert_eq!(reads.admit(1), Err(Refusal::Bounds));
        assert_eq!(reads.admit(0), Err(Refusal::Bounds));
        let mut reads = Reads {
            admitted: u64::MAX,
            ..Reads::default()
        };
        assert_eq!(reads.admit(1), Err(Refusal::Bounds));
    }
}
