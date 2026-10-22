# Source-only, no extraction, no package code execution. npm original inventory.
import hashlib
import json
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    found = {}
    total = 0
    for member in archive:
        name = member.name
        parts = name.split('/')
        if name == 'package' and member.isdir():
            continue
        if not name.startswith('package/') or any(p in ('', '.', '..') for p in parts) or '\\' in name or any(ord(c) < 32 for c in name):
            raise ValueError('unsafe archive path')
        if member.isdir():
            continue
        if not member.isfile() or name in found or member.size > 128 * 1024 * 1024:
            raise ValueError('unsafe/duplicate archive member')
        total += member.size
        if len(found) >= 20000 or total > 512 * 1024 * 1024:
            raise ValueError('archive limits')
        data = archive.extractfile(member).read(member.size + 1)
        if len(data) != member.size:
            raise ValueError('archive member length')
        found[name] = {'path': name[8:], 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    print(json.dumps(sorted(found.values(), key=lambda item: item['path'])))
