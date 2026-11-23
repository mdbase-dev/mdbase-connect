"""Run cargo-deny with feature bans evaluated on each actual target graph."""

import os
from pathlib import Path
import subprocess
import sys
import tomllib

root = Path(__file__).resolve().parents[1]
with (root / "deny.toml").open("rb") as config:
    targets = tomllib.load(config)["graph"]["targets"]
if not targets or not all(isinstance(target, str) and target for target in targets):
    sys.exit("deny.toml must name each target triple explicitly")

cargo = os.environ.get("CARGO", "cargo")
checks = [["check", "advisories", "licenses", "sources"]]
checks.extend(["--target", target, "check", "bans"] for target in targets)
passed = True
for check in checks:
    command = [cargo, "deny", "--locked", *check]
    print("+", *command, flush=True)
    if subprocess.run(command, cwd=root).returncode:
        passed = False
sys.exit(0 if passed else 1)
