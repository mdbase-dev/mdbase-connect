# Trusted source extractor; validate the entire immutable ZIP before writing.
import pathlib
import stat
import sys
import unicodedata
import zipfile

root = pathlib.Path(sys.argv[2])
assert root.is_dir() and not root.is_symlink() and not any(root.iterdir())
with zipfile.ZipFile(sys.argv[1]) as archive:
    seen = {}
    total = 0
    for item in archive.infolist():
        name = item.filename.rstrip('/')
        parts = name.split('/')
        mode = item.external_attr >> 16
        kind = stat.S_IFMT(mode)
        assert name and not item.filename.startswith('/') and '\\' not in name
        assert all(part not in ('', '.', '..') for part in parts)
        assert not any(ord(c) < 32 or ord(c) == 127 for c in name)
        assert unicodedata.normalize('NFC', name) == name and not item.flag_bits & 1
        assert kind in (0, stat.S_IFREG, stat.S_IFDIR) and (kind != stat.S_IFDIR or item.is_dir())
        key = name.casefold()
        assert key not in seen
        seen[key] = item.is_dir()
        total += item.file_size
        assert len(seen) <= 20000 and total <= 512 * 1024 * 1024
    for name in seen:
        parents = pathlib.PurePosixPath(name).parents
        assert all(str(p) not in seen or seen[str(p)] for p in parents if str(p) != '.')
    for item in archive.infolist():
        path = root.joinpath(*item.filename.rstrip('/').split('/'))
        if item.is_dir():
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            count = 0
            with archive.open(item) as source, path.open('xb') as dest:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    assert count <= item.file_size
                    dest.write(chunk)
            assert count == item.file_size
