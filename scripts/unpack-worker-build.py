import pathlib
import stat
import sys
import zipfile

archive, destination = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    if not 1 <= len(entries) <= 80 or sum(item.file_size for item in entries) > 128 * 1024 * 1024:
        raise ValueError('bounded Worker archive required')
    names = set()
    for item in entries:
        path = pathlib.PurePosixPath(item.filename)
        mode = item.external_attr >> 16
        if (path.is_absolute() or '..' in path.parts or '\\' in item.filename
                or item.filename in names or item.flag_bits & 1
                or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise ValueError('regular unique relative archive entries required')
        names.add(item.filename)
    destination.mkdir()
    for item in entries:
        path = destination / item.filename
        if item.is_dir():
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as output:
                output.write(bundle.read(item))
