"""Adversarial build-time archive tests; all files stay inside this worktree."""
import hashlib
import gzip
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import zipfile

from verify_archive import ArchiveError, MAX_ARCHIVE, archive_names, verify_and_extract

VERSION = "0.2.0-beta.1"
LINUX = "x86_64-unknown-linux-gnu"
WINDOWS = "x86_64-pc-windows-msvc"
ROOT = Path(__file__).resolve().parents[2] / "target" / "t"


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT, prefix="archive-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def make(self, entries=None, target=LINUX, directory=False):
        stem, binary, extension = archive_names(VERSION, target, target == WINDOWS)
        path = self.root / f"{stem}.{extension}"
        entries = entries if entries is not None else [(f"{stem}/{binary}", b"binary"), (f"{stem}/VERSION", (VERSION + "\n").encode())]
        if extension == "zip":
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
                if directory:
                    z.writestr(stem + "/", b"")
                for name, data in entries:
                    if isinstance(name, zipfile.ZipInfo):
                        z.writestr(name, data)
                    else:
                        z.writestr(name, data)
        else:
            with tarfile.open(path, "w:gz") as tar:
                if directory:
                    entry = tarfile.TarInfo(stem); entry.type = tarfile.DIRTYPE
                    tar.addfile(entry)
                for name, data in entries:
                    entry = name if isinstance(name, tarfile.TarInfo) else tarfile.TarInfo(name)
                    entry.size = len(data)
                    tar.addfile(entry, io.BytesIO(data))
        return path

    def extract(self, path, target=LINUX, **overrides):
        args = dict(archive=path, stage=self.root / "stage", version=VERSION, target=target,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(), size=path.stat().st_size, unsigned=target == WINDOWS)
        args.update(overrides)
        return verify_and_extract(**args)

    def test_valid_tar_and_zip_with_optional_root(self):
        for target in [LINUX, WINDOWS]:
            for directory in [False, True]:
                path = self.make(target=target, directory=directory)
                stage = self.root / (target + str(directory))
                binary = self.extract(path, target, stage=stage)
                self.assertEqual(binary.read_bytes(), b"binary")
                self.assertEqual((stage / "VERSION").read_text(), VERSION + "\n")
                self.assertEqual(len(list(stage.iterdir())), 2)
                if target == LINUX:
                    self.assertEqual(stat.S_IMODE(stage.stat().st_mode), 0o700)
                    self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o700)

    def test_hash_size_and_archive_filename_pin(self):
        path = self.make()
        for override in [dict(sha256="00" * 32), dict(size=path.stat().st_size + 1), dict(size=MAX_ARCHIVE + 1), dict(sha256="AB" * 32), dict(version="0.2.0-beta.2")]:
            with self.subTest(override=override), self.assertRaises(ArchiveError):
                self.extract(path, **override)
            self.assertFalse((self.root / "stage").exists())

    def test_paths_duplicates_missing_and_extra_entries(self):
        stem, binary, _ = archive_names(VERSION, LINUX)
        baseline = [(f"{stem}/{binary}", b"binary"), (f"{stem}/VERSION", (VERSION + "\n").encode())]
        for name in ["../escape", "/absolute", f"{stem}/../escape", f"{stem}\\escape", f"{stem}/extra", f"{stem}/{binary}"]:
            with self.subTest(name=name), self.assertRaises(ArchiveError):
                self.extract(self.make(baseline + [(name, b"bad")]))
            self.assertFalse((self.root / "stage").exists())
        with self.assertRaises(ArchiveError):
            self.extract(self.make(baseline[:1]))

    def test_tar_links_devices_and_sparse_files_rejected(self):
        stem, binary, _ = archive_names(VERSION, LINUX)
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE]:
            entry = tarfile.TarInfo(f"{stem}/{binary}"); entry.type = kind; entry.linkname = "/outside"
            with self.subTest(kind=kind), self.assertRaises((ArchiveError, tarfile.TarError)):
                self.extract(self.make([(entry, b""), (f"{stem}/VERSION", (VERSION + "\n").encode())]))
            self.assertFalse((self.root / "stage").exists())

    def test_zip_symlink_and_bad_version_rejected(self):
        stem, binary, _ = archive_names(VERSION, WINDOWS, True)
        link = zipfile.ZipInfo(f"{stem}/{binary}"); link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ArchiveError):
            self.extract(self.make([(link, b"/outside"), (f"{stem}/VERSION", (VERSION + "\n").encode())], WINDOWS), WINDOWS)
        with self.assertRaises(ArchiveError):
            self.extract(self.make([(f"{stem}/{binary}", b"binary"), (f"{stem}/VERSION", b"other\n")], WINDOWS), WINDOWS)
        self.assertFalse((self.root / "stage").exists())

    def test_zip_root_directory_cannot_be_a_link(self):
        stem, binary, _ = archive_names(VERSION, WINDOWS, True)
        link = zipfile.ZipInfo(stem + "/"); link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ArchiveError):
            self.extract(self.make([(link, b""), (f"{stem}/{binary}", b"binary"), (f"{stem}/VERSION", (VERSION + "\n").encode())], WINDOWS), WINDOWS)
        self.assertFalse((self.root / "stage").exists())

    def test_no_merge_into_existing_stage_or_symlink(self):
        path = self.make(); stage = self.root / "stage"; stage.mkdir()
        (stage / "kept").write_text("user bytes")
        with self.assertRaises(FileExistsError): self.extract(path)
        self.assertEqual((stage / "kept").read_text(), "user bytes")
        stage_link = self.root / "link"; stage_link.symlink_to(stage)
        with self.assertRaises(FileExistsError): self.extract(path, stage=stage_link)
        self.assertFalse((stage / "mdbase").exists())

    def test_archive_symlink_rejected(self):
        path = self.make(); real = path.with_suffix(".data"); path.rename(real); path.symlink_to(real)
        with self.assertRaises(ArchiveError): self.extract(path)

    def test_concatenated_tar_cannot_hide_extra_entries_after_padding(self):
        path = self.make()
        extra = io.BytesIO()
        with tarfile.open(fileobj=extra, mode="w") as tar:
            info = tarfile.TarInfo("hidden-extra"); info.size = 3
            tar.addfile(info, io.BytesIO(b"bad"))
        path.write_bytes(path.read_bytes() + gzip.compress(extra.getvalue()))
        with self.assertRaises(ArchiveError): self.extract(path)
        self.assertFalse((self.root / "stage").exists())

    def test_oversized_tar_metadata_is_bounded_before_allocation(self):
        stem, _, _ = archive_names(VERSION, LINUX)
        path = self.root / f"{stem}.tar.gz"
        info = tarfile.TarInfo("pax"); info.type = tarfile.XHDTYPE; info.size = MAX_ARCHIVE * 100
        path.write_bytes(gzip.compress(info.tobuf(format=tarfile.GNU_FORMAT)))
        with self.assertRaises(ArchiveError): self.extract(path)
        self.assertFalse((self.root / "stage").exists())

    def test_zip_directory_count_is_bounded_before_parsing(self):
        path = self.make(target=WINDOWS)
        payload = bytearray(path.read_bytes())
        payload[-14:-10] = b"\xff" * 4
        path.write_bytes(payload)
        with self.assertRaises(ArchiveError): self.extract(path, WINDOWS)
        self.assertFalse((self.root / "stage").exists())

    def test_archive_size_and_version_limits(self):
        stem, binary, _ = archive_names(VERSION, LINUX)
        for payload in [b"", b"x" * 257]:
            with self.assertRaises(ArchiveError):
                self.extract(self.make([(f"{stem}/{binary}", b"binary"), (f"{stem}/VERSION", payload)]))
        for version in ["../evil", "v0.2.0", "0.2.0+metadata", "x" * 129]:
            with self.assertRaises(ArchiveError): archive_names(version, LINUX)


if __name__ == "__main__":
    unittest.main()
