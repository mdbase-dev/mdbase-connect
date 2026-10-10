#!/usr/bin/env python3
"""Validate a hash-pinned daemon archive before writing its two regular files.

Build-time bridge helper, not an installer or signature verifier. The caller must
first authenticate the SHA256SUMS cosign identity and GitHub attestation and obtain
the expected hash/size/version from a reviewed pin or verified manifest. Never
uses extractall, a shell, archive-controlled paths, or executes an artifact.
"""
import argparse
import hashlib
import gzip
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import tarfile
import zipfile

MAX_ARCHIVE = 512 * 1024 * 1024
TARGETS = {
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "universal-apple-darwin",
    "x86_64-pc-windows-msvc",
}


class ArchiveError(ValueError):
    """Untrusted archive is not the pinned two-file release package."""


def archive_names(version, target, unsigned=False):
    """Derive the exact expected stem/file names from trusted release metadata."""
    if target not in TARGETS or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
        raise ArchiveError("invalid version or target")
    if len(version) > 128:
        raise ArchiveError("version too long")
    windows = target == "x86_64-pc-windows-msvc"
    if windows and not unsigned:
        raise ArchiveError("Windows release must be explicitly unsigned")
    if unsigned and not (windows or target == "universal-apple-darwin"):
        raise ArchiveError("unexpected unsigned target")
    stem = f"mdbase-next-{version}-{target}{'-UNSIGNED' if unsigned else ''}"
    binary = "mdbase.exe" if windows else "mdbase"
    return stem, binary, "zip" if windows else "tar.gz"


class _BoundedTar:
    """Bound decompressed offsets and individual reads, including PAX metadata."""
    def __init__(self, source):
        self.source = source

    def tell(self):
        return self.source.tell()

    def seek(self, offset, whence=0):
        if whence != 0 or not 0 <= offset <= MAX_ARCHIVE + 65536:
            raise ArchiveError("tar decompressed offset exceeds limit")
        return self.source.seek(offset)

    def read(self, size):
        if not 0 <= size <= 1024 * 1024 or self.tell() + size > MAX_ARCHIVE + 65536:
            raise ArchiveError("tar read or metadata exceeds limit")
        return self.source.read(size)


def _check_zip_directory(source, size):
    # Reproducible release ZIPs have no comment, ZIP64 or multiple disks. Check
    # bounded directory size/count before ZipFile allocates its full member list.
    if size < 22:
        raise ArchiveError("truncated ZIP directory")
    source.seek(size - 22)
    magic, disk, start_disk, on_disk, count, length, offset, comment = struct.unpack("<4s4H2IH", source.read(22))
    if magic != b"PK\x05\x06" or disk or start_disk or comment or not 2 <= count <= 3 or count != on_disk or length > 4096 or offset + length != size - 22:
        raise ArchiveError("unexpected ZIP directory layout")
    source.seek(0)


def _checked_members(members, stem, binary, is_zip):
    expected = {f"{stem}/{binary}": MAX_ARCHIVE, f"{stem}/VERSION": 256}
    files = {}
    seen = set()
    for count, member in enumerate(members, 1):
        if count > 3:
            raise ArchiveError("too many archive entries")
        name = member.filename if is_zip else member.name
        if name in seen:
            raise ArchiveError("duplicate archive entry")
        seen.add(name)
        if is_zip:
            if member.filename != member.orig_filename:
                raise ArchiveError("ZIP entry has a truncated name")
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            directory = member.is_dir() and kind in (0, stat.S_IFDIR)
            regular = not member.is_dir() and kind in (0, stat.S_IFREG)
            size = member.file_size
            if member.flag_bits & 1:
                raise ArchiveError("encrypted archive entry")
            if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ArchiveError("unsupported ZIP compression")
        else:
            directory = member.isdir()
            regular = member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not member.issparse()
            size = member.size
        # The optional single root directory is not extracted. No other directory,
        # absolute/parent/backslash path, link, device, sparse file or extra entry.
        if name in (stem, stem + "/") and directory and size == 0:
            if "root" in files:
                raise ArchiveError("duplicate root directory")
            files["root"] = member
            continue
        if not regular or name not in expected or size <= 0 or size > expected[name]:
            raise ArchiveError("unexpected archive entry type, name or size")
        files[name] = member
    if not all(name in files for name in expected):
        raise ArchiveError("archive is missing binary or VERSION")
    return {name: files[name] for name in expected}


def _write_files(container, members, stage, stem, binary, version, is_zip):
    version_member = members[f"{stem}/VERSION"]
    opener = container.open if is_zip else container.extractfile
    with opener(version_member) as stream:
        if stream.read(257) != (version + "\n").encode("ascii"):
            raise ArchiveError("VERSION does not match pinned release")
    # Destination must be a new directory. Never merge into an existing stage or
    # write through pre-existing file/symlink paths. Parent is caller-controlled.
    stage.mkdir(mode=0o700)
    try:
        for leaf in (binary, "VERSION"):
            member = members[f"{stem}/{leaf}"]
            size = member.file_size if is_zip else member.size
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            fd = os.open(stage / leaf, flags, 0o700 if leaf == binary else 0o600)
            with os.fdopen(fd, "wb") as output, opener(member) as stream:
                remaining = size
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ArchiveError("truncated archive entry")
                    output.write(chunk)
                    remaining -= len(chunk)
                if stream.read(1):
                    raise ArchiveError("archive entry exceeds declared size")
                output.flush()
                os.fsync(output.fileno())
    except BaseException:
        shutil.rmtree(stage)
        raise


def verify_and_extract(archive, stage, version, target, sha256, size, unsigned=False):
    """Verify one open archive descriptor and fully inspect entries before writing."""
    archive, stage = Path(archive), Path(stage)
    stem, binary, extension = archive_names(version, target, unsigned)
    if archive.name != f"{stem}.{extension}":
        raise ArchiveError("archive filename does not match pinned target/version")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256) or not 0 < size <= MAX_ARCHIVE:
        raise ArchiveError("invalid pinned hash or archive size")
    before = archive.lstat()
    if not stat.S_ISREG(before.st_mode) or getattr(before, "st_file_attributes", 0) & 0x400:
        raise ArchiveError("archive links/reparse points are refused")
    fd = os.open(archive, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as source:
        details = os.fstat(source.fileno())
        if not stat.S_ISREG(details.st_mode) or details.st_size != size:
            raise ArchiveError("archive is not a regular file of the pinned size")
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != sha256:
            raise ArchiveError("archive hash mismatch")
        source.seek(0)
        if extension == "zip":
            _check_zip_directory(source, size)
            with zipfile.ZipFile(source) as container:
                members = _checked_members(container.infolist(), stem, binary, True)
                _write_files(container, members, stage, stem, binary, version, True)
        else:
            try:
                with gzip.GzipFile(fileobj=source, mode="rb") as decompressed:
                    with tarfile.open(fileobj=_BoundedTar(decompressed), mode="r:", ignore_zeros=True) as container:
                        members = _checked_members(container, stem, binary, False)
                        _write_files(container, members, stage, stem, binary, version, False)
            except tarfile.TarError as error:
                raise ArchiveError("invalid tar archive") from error
    return stage / binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("stage", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", required=True, choices=sorted(TARGETS))
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--unsigned", action="store_true")
    args = parser.parse_args()
    try:
        verify_and_extract(args.archive, args.stage, args.version, args.target, args.sha256, args.size, args.unsigned)
    except (ArchiveError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        parser.exit(1, f"daemon archive verification failed: {error}\n")


if __name__ == "__main__":
    main()
