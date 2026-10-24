#!/usr/bin/env python3
"""Hermetic archive-profile regressions; fixtures are not deploy evidence."""
import importlib.util
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location('extractor', Path(__file__).with_name('extract-log-worker.py'))
EXTRACTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXTRACTOR)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='worker-zip-test-', dir=Path(__file__).parent))
        self.addCleanup(shutil.rmtree, self.root)
        self.archive = self.root / 'producer.zip'
        self.output = self.root / 'files'

    def create(self, extra=None, omit=None, kind=None):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('worker/', b'')
            for name in sorted(EXTRACTOR.FILES - {omit}):
                entry = zipfile.ZipInfo(name)
                entry.external_attr = ((kind if kind is not None and name == 'index.js' else stat.S_IFREG) | 0o600) << 16
                archive.writestr(entry, b'toy fixture')
            if extra is not None:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    archive.writestr(extra, b'toy fixture')

    def refused(self):
        with self.assertRaises(ValueError):
            EXTRACTOR.extract(self.archive, self.output)
        self.assertFalse(self.output.exists())

    def test_exact_profile(self):
        self.create()
        EXTRACTOR.extract(self.archive, self.output)
        found = {str(path.relative_to(self.output)) for path in self.output.rglob('*') if path.is_file()}
        self.assertEqual(found, EXTRACTOR.FILES)
        self.assertTrue(all(stat.S_IMODE((self.output / name).stat().st_mode) == 0o600 for name in found))

    def test_unsafe_and_unexpected_paths(self):
        for name in ['../escape', '/absolute', 'worker/../../escape', 'worker\\shim.mjs', '.dev.vars', 'nested/']:
            with self.subTest(name=name):
                self.create(extra=name)
                self.refused()

    def test_duplicate_name(self):
        self.create(extra='index.js')
        self.refused()

    def test_missing_member(self):
        self.create(omit='BUILD.json')
        self.refused()

    def test_links_and_special_files(self):
        for kind in [stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFSOCK]:
            with self.subTest(kind=kind):
                self.create(kind=kind)
                self.refused()

    def test_size_limit_before_extraction(self):
        self.create()
        old_limit = EXTRACTOR.LIMIT
        EXTRACTOR.LIMIT = 2
        try:
            self.refused()
        finally:
            EXTRACTOR.LIMIT = old_limit

    def test_existing_output_refused(self):
        self.create()
        self.output.mkdir()
        with self.assertRaises(ValueError):
            EXTRACTOR.extract(self.archive, self.output)
        self.assertEqual(list(self.output.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
