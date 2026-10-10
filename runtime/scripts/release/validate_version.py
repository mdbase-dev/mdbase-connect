#!/usr/bin/env python3
"""Validate archive versions: <=128 ASCII characters, SemVer without v/build metadata."""
import re
import sys

CORE = r"(?:0|[1-9][0-9]*)"
VERSION = re.compile(rf"{CORE}\.{CORE}\.{CORE}(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?", re.ASCII)


def valid_version(value: str) -> bool:
    if len(value) > 128:
        return False
    match = VERSION.fullmatch(value)
    if match is None:
        return False
    prerelease = match.group(1)
    return prerelease is None or all(
        not (part.isdigit() and len(part) > 1 and part.startswith("0"))
        for part in prerelease.split(".")
    )


if __name__ == "__main__":
    if len(sys.argv) != 2 or not valid_version(sys.argv[1]):
        sys.exit("expected SemVer (max 128 characters), without a leading v or build metadata")
