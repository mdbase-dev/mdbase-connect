#!/usr/bin/env python3
"""Extract only the fixed producer ZIP profile; never execute its contents."""
import os
from pathlib import Path
import stat
import sys
import zipfile

FILES = {'index.js', 'index_bg.wasm', 'package.json', 'worker/shim.mjs',
         'SHA256SUMS', 'SOURCE_REVISION', 'BUILD.json', 'wrangler.jsonc'}
LIMIT = 64 * 1024 * 1024


def extract(source, output):
    output = Path(output)
    if output.exists():
        raise ValueError('output already exists')
    with zipfile.ZipFile(source) as archive:
        seen = set()
        files = []
        for entry in archive.infolist():
            if entry.filename in seen:
                raise ValueError('duplicate archive member')
            seen.add(entry.filename)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if entry.is_dir():
                if entry.filename != 'worker/' or kind not in (0, stat.S_IFDIR):
                    raise ValueError('unexpected archive directory')
                continue
            if entry.filename not in FILES or kind not in (0, stat.S_IFREG):
                raise ValueError('unexpected archive path or file type')
            if entry.file_size > LIMIT or entry.flag_bits & 1:
                raise ValueError('oversized or encrypted archive member')
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('unsupported archive compression')
            files.append(entry)
        if {entry.filename for entry in files} != FILES or sum(e.file_size for e in files) > 128 * 1024 * 1024:
            raise ValueError('missing or oversized archive inventory')
        # Validate every member before creating any output path.
        payloads = []
        for entry in files:
            with archive.open(entry) as member:
                data = member.read(LIMIT + 1)
                if len(data) != entry.file_size or len(data) > LIMIT:
                    raise ValueError('decompressed archive size mismatch')
                payloads.append((entry.filename, data))
    output.mkdir(mode=0o700)
    (output / 'worker').mkdir(mode=0o700)
    for name, data in payloads:
        with (output / name).open('xb') as file:
            os.chmod(file.fileno(), 0o600)
            file.write(data)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage: extract-log-worker.py PRODUCER.zip OUTPUT')
        extract(sys.argv[1], sys.argv[2])
    except (ValueError, OSError, zipfile.BadZipFile):
        sys.exit('Worker ZIP extraction refused')
