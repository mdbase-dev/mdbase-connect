"""Prove generated release archives match the checked two-file contract."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from verify_archive import archive_names, verify_and_extract

RELEASE = Path(__file__).resolve().parent
VERSION = "0.2.0-beta.1"
PAYLOAD = b"test release binary\x00not executed"


class PackageTests(unittest.TestCase):
    def test_reproducible_archives_pass_the_pinned_verifier(self):
        cases = [("x86_64-unknown-linux-gnu", False), ("aarch64-unknown-linux-gnu", False),
                 ("x86_64-pc-windows-msvc", True), ("universal-apple-darwin", False),
                 ("universal-apple-darwin", True)]
        for target, unsigned in cases:
            with self.subTest(target=target, unsigned=unsigned), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "in" / f"bin-{target}"
                source.mkdir(parents=True)
                binary = "mdbase.exe" if "windows" in target else "mdbase"
                (source / binary).write_bytes(PAYLOAD)
                if "apple" in target:
                    (source / "macos-mode").write_text("unsigned\n" if unsigned else "signed\n")
                outputs = []
                for index in range(2):
                    output = root / f"out-{index}"
                    subprocess.run(
                        ["bash", str(RELEASE / "package.sh"), str(root / "in"), str(output), VERSION],
                        env={**os.environ, "SOURCE_DATE_EPOCH": "1710000000"},
                        check=True, capture_output=True,
                    )
                    stem, _, extension = archive_names(VERSION, target, unsigned)
                    archive = output / f"{stem}.{extension}"
                    self.assertEqual(list(output.iterdir()), [archive])
                    outputs.append(archive.read_bytes())
                    stage = root / f"verified-{index}"
                    verify_and_extract(archive, stage, VERSION, target,
                                       hashlib.sha256(outputs[-1]).hexdigest(), len(outputs[-1]), unsigned)
                    self.assertEqual(sorted(p.name for p in stage.iterdir()), sorted([binary, "VERSION"]))
                    self.assertEqual((stage / binary).read_bytes(), PAYLOAD)
                    self.assertEqual((stage / "VERSION").read_text(), f"{VERSION}\n")
                self.assertEqual(*outputs)


if __name__ == "__main__":
    unittest.main()
