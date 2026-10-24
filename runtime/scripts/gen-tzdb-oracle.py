#!/usr/bin/env python3
"""Pin independent Python ZoneInfo offset expectations for embedded tzdb 2026e.

Usage: scripts/gen-tzdb-oracle.py /path/to/compiled/pinned/zones
Never reads the host's zoneinfo search path. Generate those files using
zic -b slim from the same official 2026e source as gen-tzdb-table.py.
"""
from datetime import datetime, timezone
from pathlib import Path
import argparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zones", type=Path)
    args = parser.parse_args()
    epochs = [(1880, 1), (1900, 7), (1950, 1), (1970, 7), (2026, 1), (2026, 7), (2050, 1), (2400, 7), (9999, 7)]
    seconds = [int(datetime(y, m, 15, 12, tzinfo=timezone.utc).timestamp()) for y, m in epochs]
    # Exact modern DST boundaries, non-hour transitions and date-line shifts.
    probes = [
        ("Australia/Melbourne", "2026-10-03T16:00:00+00:00"),
        ("Australia/Melbourne", "2026-04-04T16:00:00+00:00"),
        ("America/New_York", "2026-03-08T07:00:00+00:00"),
        ("America/New_York", "2026-11-01T06:00:00+00:00"),
        ("Australia/Lord_Howe", "2026-10-03T15:30:00+00:00"),
        ("Pacific/Apia", "2011-12-30T10:00:00+00:00"),
        ("Asia/Kathmandu", "1985-12-31T18:30:00+00:00"),
        ("America/Santiago", "2026-09-06T04:00:00+00:00"),
    ]
    extra = {}
    for name, instant in probes:
        second = int(datetime.fromisoformat(instant).timestamp())
        extra.setdefault(name, []).extend([second - 1, second, second + 1])
    out = ["# IANA 2026e; Python ZoneInfo.from_file over pinned zic -b slim output."]
    names = 0
    for path in sorted(args.zones.rglob("*")):
        if not path.is_file() or not path.read_bytes().startswith(b"TZif"):
            continue
        name = path.relative_to(args.zones).as_posix()
        with path.open("rb") as f:
            zone = ZoneInfo.from_file(f, key=name)
        names += 1
        for second in sorted(set(seconds + extra.get(name, []))):
            offset = datetime.fromtimestamp(second, timezone.utc).astimezone(zone).utcoffset()
            out.append(f"{name} {second} {int(offset.total_seconds())}")
    assert names == 597, names
    destination = ROOT / "crates/core/tests/data/tzdb-2026e-offsets.txt"
    destination.write_text("\n".join(out) + "\n")
    print(f"{names} names; {len(out) - 1} offset cases -> {destination}")


if __name__ == "__main__":
    main()
