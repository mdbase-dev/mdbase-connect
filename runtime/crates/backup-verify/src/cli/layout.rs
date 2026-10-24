//! CLI-only exact inventory names and immutable directory namespace checks.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "Native offline layout admission requires directory and file identities"
)]
use super::files::Identity;
use mdbn_backup_verify::Refusal;
use mdbn_log_service::{OfflineDecodeBudget, OfflineOwnedReservation};
use mdbn_wire::common::B32;
use std::fs::{self, File, Metadata};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    modified: i64,
    modified_ns: i64,
    changed: i64,
    changed_ns: i64,
}
impl DirectoryIdentity {
    #[cfg(target_os = "linux")]
    fn capture(metadata: &Metadata) -> Result<Self, Refusal> {
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_dir() {
            return Err(Refusal::Io);
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            modified: metadata.mtime(),
            modified_ns: metadata.mtime_nsec(),
            changed: metadata.ctime(),
            changed_ns: metadata.ctime_nsec(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    fn capture(_: &Metadata) -> Result<Self, Refusal> {
        Err(Refusal::Io)
    }
}
struct Directory {
    file: File,
    path: PathBuf,
    identity: DirectoryIdentity,
}
impl Directory {
    fn admit(path: &Path) -> Result<Self, Refusal> {
        let metadata = fs::symlink_metadata(path).map_err(|_| Refusal::Io)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Refusal::Layout);
        }
        let identity = DirectoryIdentity::capture(&metadata)?;
        let file = File::open(path).map_err(|_| Refusal::Io)?;
        let directory = Self {
            file,
            path: path.to_owned(),
            identity,
        };
        directory.recheck()?;
        Ok(directory)
    }
    fn recheck(&self) -> Result<(), Refusal> {
        let metadata = fs::symlink_metadata(&self.path).map_err(|_| Refusal::Io)?;
        if metadata.file_type().is_symlink()
            || DirectoryIdentity::capture(&metadata)? != self.identity
            || DirectoryIdentity::capture(&self.file.metadata().map_err(|_| Refusal::Io)?)?
                != self.identity
        {
            return Err(Refusal::Io);
        }
        Ok(())
    }
}

pub(crate) struct Layout {
    root: Directory,
    pages: Directory,
    objects: Directory,
    header: Identity,
    finish: Identity,
    work: OfflineDecodeBudget,
    _allocation: OfflineOwnedReservation,
}
pub(crate) struct ObjectName {
    pub(crate) address: B32,
    pub(crate) identity: Identity,
}
pub(crate) struct Names {
    objects: Vec<ObjectName>,
    page_identities: Vec<Option<Identity>>,
    pages: u64,
    _allocation: OfflineOwnedReservation,
}
impl Names {
    pub(crate) fn objects(&self) -> &[ObjectName] {
        &self.objects
    }
    pub(crate) fn pages(&self) -> u64 {
        self.pages
    }
    pub(crate) fn page_identity(&self, number: u64) -> Result<Identity, Refusal> {
        let index = usize::try_from(number.checked_sub(1).ok_or(Refusal::Layout)?)
            .map_err(|_| Refusal::Bounds)?;
        self.page_identities
            .get(index)
            .copied()
            .flatten()
            .ok_or(Refusal::Layout)
    }
}
impl Layout {
    /// Root whitelist only: no page/object contents or child inventory read here.
    pub(crate) fn admit(
        root: &Path,
        trust: &Path,
        completion: &Path,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let result = Self::admit_checked(root, trust, completion, work);
        if result.is_err() {
            let _ = work.reserve_owned(u64::MAX);
        }
        result
    }
    fn admit_checked(
        root: &Path,
        trust: &Path,
        completion: &Path,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let allowance = [root, trust, completion]
            .iter()
            .try_fold(8192u64, |total, path| {
                u64::try_from(path.as_os_str().as_encoded_bytes().len())
                    .ok()
                    .and_then(|bytes| bytes.checked_mul(8))
                    .and_then(|bytes| total.checked_add(bytes))
                    .ok_or(Refusal::Bounds)
            })?;
        let allocation = work.reserve_owned(allowance).map_err(|_| Refusal::Bounds)?;
        let stage = fs::canonicalize(stage_parent(root)).map_err(|_| Refusal::Io)?;
        if fs::canonicalize(stage_parent(trust)).map_err(|_| Refusal::Io)? != stage
            || fs::canonicalize(stage_parent(completion)).map_err(|_| Refusal::Io)? != stage
            || trust.file_name().is_none()
            || completion.file_name().is_none()
            || trust.file_name() == completion.file_name()
            || root.file_name() == trust.file_name()
            || root.file_name() == completion.file_name()
        {
            return Err(Refusal::Layout);
        }
        let root = Directory::admit(root)?;
        let mut seen = 0u8;
        let mut header = None;
        let mut finish = None;
        for entry in fs::read_dir(&root.path).map_err(|_| Refusal::Io)? {
            let entry = entry.map_err(|_| Refusal::Io)?;
            let name = entry.file_name();
            let (bit, directory) = match name.to_str() {
                Some("header.cbor") => (1, false),
                Some("finish.cbor") => (2, false),
                Some("pages") => (4, true),
                Some("objects") => (8, true),
                _ => return Err(Refusal::Layout),
            };
            let kind = entry.file_type().map_err(|_| Refusal::Io)?;
            if seen & bit != 0
                || kind.is_symlink()
                || if directory {
                    !kind.is_dir()
                } else {
                    !kind.is_file()
                }
            {
                return Err(Refusal::Layout);
            }
            if !directory {
                let identity = regular(&entry, 64 * 1024)?;
                if bit == 1 {
                    header = Some(identity);
                } else {
                    finish = Some(identity);
                }
            }
            seen |= bit;
        }
        if seen != 15 {
            return Err(Refusal::Layout);
        }
        let pages = Directory::admit(&root.path.join("pages"))?;
        let objects = Directory::admit(&root.path.join("objects"))?;
        let result = Self {
            root,
            pages,
            objects,
            header: header.ok_or(Refusal::Layout)?,
            finish: finish.ok_or(Refusal::Layout)?,
            work: work.clone(),
            _allocation: allocation,
        };
        result.recheck()?;
        Ok(result)
    }
    pub(crate) fn header_identity(&self) -> Identity {
        self.header
    }
    pub(crate) fn finish_identity(&self) -> Identity {
        self.finish
    }

    /// Call only AFTER independent completion authentication/header binding.
    pub(crate) fn inventory(&self, page_count: u64, object_count: u64) -> Result<Names, Refusal> {
        let result = self.inventory_checked(page_count, object_count);
        if result.is_err() {
            let _ = self.work.reserve_owned(u64::MAX);
        }
        result
    }
    fn inventory_checked(&self, page_count: u64, object_count: u64) -> Result<Names, Refusal> {
        self.recheck()?;
        if !(6..=65536).contains(&page_count) || object_count > 65536 {
            return Err(Refusal::Bounds);
        }
        let allowance = object_count
            .checked_mul(2 * std::mem::size_of::<ObjectName>() as u64)
            .and_then(|objects| {
                page_count
                    .checked_mul(2 * std::mem::size_of::<Option<Identity>>() as u64)
                    .and_then(|pages| objects.checked_add(pages))
            })
            .and_then(|bytes| bytes.checked_add(8192))
            .ok_or(Refusal::Bounds)?;
        let allocation = self
            .work
            .reserve_owned(allowance)
            .map_err(|_| Refusal::Bounds)?;
        let mut seen = Vec::new();
        seen.try_reserve_exact(page_count as usize)
            .map_err(|_| Refusal::Bounds)?;
        if seen.capacity() > 2 * page_count as usize {
            return Err(Refusal::Bounds);
        }
        seen.resize(page_count as usize, None);
        for entry in fs::read_dir(&self.pages.path).map_err(|_| Refusal::Io)? {
            let entry = entry.map_err(|_| Refusal::Io)?;
            let name = entry.file_name();
            let number = page_name(name.to_str().ok_or(Refusal::Layout)?)?;
            if number > page_count || seen[(number - 1) as usize].is_some() {
                return Err(Refusal::Layout);
            }
            seen[(number - 1) as usize] = Some(regular(&entry, 4 * 1024 * 1024)?);
        }
        if seen.iter().any(Option::is_none) {
            return Err(Refusal::Layout);
        }
        let mut objects = Vec::new();
        objects
            .try_reserve_exact(object_count as usize)
            .map_err(|_| Refusal::Bounds)?;
        if objects.capacity() > 2 * object_count as usize {
            return Err(Refusal::Bounds);
        }
        for entry in fs::read_dir(&self.objects.path).map_err(|_| Refusal::Io)? {
            let entry = entry.map_err(|_| Refusal::Io)?;
            let name = entry.file_name();
            if objects.len() == object_count as usize {
                return Err(Refusal::Layout);
            }
            let address = object_name(name.to_str().ok_or(Refusal::Layout)?)?;
            let identity = regular(&entry, 9 * 1024 * 1024)?;
            objects.push(ObjectName { address, identity });
        }
        if objects.len() != object_count as usize {
            return Err(Refusal::Layout);
        }
        objects.sort_unstable_by_key(|object| object.address);
        if objects
            .windows(2)
            .any(|pair| pair[0].address == pair[1].address)
        {
            return Err(Refusal::Layout);
        }
        self.recheck()?;
        Ok(Names {
            objects,
            page_identities: seen,
            pages: page_count,
            _allocation: allocation,
        })
    }
    pub(crate) fn recheck(&self) -> Result<(), Refusal> {
        let result = (|| {
            let _alive = self.work.reserve_owned(0).map_err(|_| Refusal::Bounds)?;
            self.root.recheck()?;
            self.pages.recheck()?;
            self.objects.recheck()
        })();
        if result.is_err() {
            let _ = self.work.reserve_owned(u64::MAX);
        }
        result
    }
}
fn stage_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}
fn regular(entry: &fs::DirEntry, maximum: u64) -> Result<Identity, Refusal> {
    let kind = entry.file_type().map_err(|_| Refusal::Io)?;
    if !kind.is_file() || kind.is_symlink() {
        return Err(Refusal::Layout);
    }
    let metadata = fs::symlink_metadata(entry.path()).map_err(|_| Refusal::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Refusal::Layout);
    }
    if metadata.len() > maximum {
        return Err(Refusal::Bounds);
    }
    Identity::capture(&metadata)
}
fn page_name(name: &str) -> Result<u64, Refusal> {
    if name.len() != 15 || !name.ends_with(".cbor") {
        return Err(Refusal::Layout);
    }
    let mut number = 0u64;
    for digit in &name.as_bytes()[..10] {
        if !digit.is_ascii_digit() {
            return Err(Refusal::Layout);
        }
        number = number * 10 + u64::from(digit - b'0');
    }
    if number == 0 {
        return Err(Refusal::Layout);
    }
    Ok(number)
}
fn object_name(name: &str) -> Result<B32, Refusal> {
    if name.len() != 69 || !name.ends_with(".cbor") {
        return Err(Refusal::Layout);
    }
    let mut address = [0u8; 32];
    for (index, pair) in name.as_bytes()[..64].chunks_exact(2).enumerate() {
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => Err(Refusal::Layout),
        };
        address[index] = digit(pair[0])? * 16 + digit(pair[1])?;
    }
    Ok(B32(address))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        stage: PathBuf,
        root: PathBuf,
        trust: PathBuf,
        completion: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let stage = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join(format!(
                    ".layout-fixture-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            let root = stage.join("cut");
            fs::create_dir_all(root.join("pages")).unwrap();
            fs::create_dir(root.join("objects")).unwrap();
            fs::write(root.join("header.cbor"), [0xf6]).unwrap();
            fs::write(root.join("finish.cbor"), [0xf6]).unwrap();
            for number in 1..=6 {
                fs::write(
                    root.join("pages").join(format!("{number:010}.cbor")),
                    [0xf6],
                )
                .unwrap();
            }
            let trust = stage.join("trust.cbor");
            let completion = stage.join("completion.cbor");
            fs::write(&trust, [0xf6]).unwrap();
            fs::write(&completion, [0xf6]).unwrap();
            Self {
                stage,
                root,
                trust,
                completion,
            }
        }
        fn admit(&self, work: &OfflineDecodeBudget) -> Result<Layout, Refusal> {
            Layout::admit(&self.root, &self.trust, &self.completion, work)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.stage);
        }
    }
    #[test]
    fn exact_names_and_counts_are_complete_and_sorted() {
        let fixture = Fixture::new();
        fs::write(
            fixture
                .root
                .join("objects")
                .join(format!("{}.cbor", "02".repeat(32))),
            [0xf6],
        )
        .unwrap();
        fs::write(
            fixture
                .root
                .join("objects")
                .join(format!("{}.cbor", "01".repeat(32))),
            [0xf6],
        )
        .unwrap();
        let work = OfflineDecodeBudget::new();
        let layout = fixture.admit(&work).unwrap();
        let names = layout.inventory(6, 2).unwrap();
        assert_eq!(names.pages(), 6);
        assert_eq!(names.objects()[0].address, B32([1; 32]));
        assert_eq!(names.objects()[1].address, B32([2; 32]));
        assert!(names.page_identity(6).is_ok());
        use super::super::files::FrozenFile;
        assert!(
            FrozenFile::admit_expected(
                &fixture.root.join("header.cbor"),
                65536,
                layout.header_identity(),
                &work
            )
            .is_ok()
        );
        assert!(
            FrozenFile::admit_expected(
                &fixture.root.join("finish.cbor"),
                65536,
                layout.finish_identity(),
                &work
            )
            .is_ok()
        );
        let object = &names.objects()[0];
        assert!(
            FrozenFile::admit_expected(
                &fixture
                    .root
                    .join("objects")
                    .join(format!("{}.cbor", object.address.to_hex())),
                9 * 1024 * 1024,
                object.identity,
                &work
            )
            .is_ok()
        );
        layout.recheck().unwrap();
    }
    #[test]
    fn missing_extra_bad_names_types_and_symlinks_refuse() {
        for kind in 0..5 {
            let fixture = Fixture::new();
            match kind {
                0 => {
                    fs::remove_file(fixture.root.join("pages/0000000006.cbor")).unwrap();
                }
                1 => {
                    fs::write(fixture.root.join("pages/0000000007.cbor"), [0xf6]).unwrap();
                }
                2 => {
                    fs::write(fixture.root.join("pages/1.cbor"), [0xf6]).unwrap();
                }
                3 => {
                    fs::create_dir(fixture.root.join("pages/0000000007.cbor")).unwrap();
                }
                _ => {
                    std::os::unix::fs::symlink(
                        "0000000001.cbor",
                        fixture.root.join("pages/0000000007.cbor"),
                    )
                    .unwrap();
                }
            }
            let work = OfflineDecodeBudget::new();
            let layout = fixture.admit(&work).unwrap();
            assert!(matches!(layout.inventory(6, 0), Err(Refusal::Layout)));
            assert!(work.reserve_owned(0).is_err());
        }
    }
    #[test]
    fn root_whitelist_sibling_scope_and_namespace_changes_are_checked() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("extra"), [0xf6]).unwrap();
        assert!(matches!(
            fixture.admit(&OfflineDecodeBudget::new()),
            Err(Refusal::Layout)
        ));
        fs::remove_file(fixture.root.join("extra")).unwrap();
        assert!(matches!(
            Layout::admit(
                &fixture.root,
                &fixture.root.join("header.cbor"),
                &fixture.completion,
                &OfflineDecodeBudget::new()
            ),
            Err(Refusal::Layout)
        ));
        let work = OfflineDecodeBudget::new();
        let layout = fixture.admit(&work).unwrap();
        fs::rename(fixture.root.join("pages"), fixture.root.join("oldpages")).unwrap();
        fs::create_dir(fixture.root.join("pages")).unwrap();
        assert_eq!(layout.recheck(), Err(Refusal::Io));
    }
    #[test]
    fn enumerated_file_identity_cannot_be_replaced_before_first_open() {
        let fixture = Fixture::new();
        let work = OfflineDecodeBudget::new();
        let layout = fixture.admit(&work).unwrap();
        let names = layout.inventory(6, 0).unwrap();
        let replacement = fixture.stage.join("replacement");
        fs::write(&replacement, [0xf6]).unwrap();
        let page = fixture.root.join("pages/0000000001.cbor");
        fs::rename(replacement, &page).unwrap();
        assert!(matches!(
            super::super::files::FrozenFile::admit_expected(
                &page,
                4 * 1024 * 1024,
                names.page_identity(1).unwrap(),
                &work
            ),
            Err(Refusal::Io)
        ));
        assert!(work.reserve_owned(0).is_err());
    }

    #[test]
    fn names_reject_uppercase_zero_traversal_and_wrong_width() {
        for name in [
            "0000000000.cbor",
            "1.cbor",
            "../0000000001.cbor",
            "0000000001.json",
            "000000000x.cbor",
        ] {
            assert_eq!(page_name(name), Err(Refusal::Layout));
        }
        for name in [
            format!("{}.cbor", "AA".repeat(32)),
            format!("{}.cbor", "00".repeat(31)),
            "../value.cbor".into(),
        ] {
            assert_eq!(object_name(&name), Err(Refusal::Layout));
        }
        assert_eq!(page_name("0000065536.cbor"), Ok(65536));
    }
}
