"""Release version acceptance and fail-before-writing packaging regressions."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from validate_version import valid_version

RELEASE = Path(__file__).resolve().parent


class VersionTests(unittest.TestCase):
    def test_valid_semver(self):
        for value in ("0.0.0", "0.2.0-beta.1", "1.2.3-0", "1.2.3-01a", "1.2.3--", "1.2.3-x-y.z", "1.2.3-rc.10", "1.2.3-" + "a" * 122):
            with self.subTest(value=value):
                self.assertTrue(valid_version(value))

    def test_rejects_invalid_or_unsupported_versions(self):
        for value in ("", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-", "1.2.3-.", "1.2.3-a..b", "1.2.3-a.", "1.2.3-.a", "1.2.3-01", "1.2.3-rc.01", "1.2.3+build", "1.2.3-β", "1.2.3\n", "1.2.3-x/y", "1.2.3-$(id)", "1.2.3-" + "a" * 123):
            with self.subTest(value=value):
                self.assertFalse(valid_version(value))

    def test_packaging_rejects_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "out"
            for value in ("1.2.3-a..b", "1.2.3-rc.01", "../../escape"):
                with self.subTest(value=value):
                    result = subprocess.run(
                        ["bash", str(RELEASE / "package.sh"), temporary, str(output), value],
                        capture_output=True, text=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
