#!/usr/bin/env python3
"""Compare mdbn-core's merge with the spec's executable model (local tool).

    cargo test -p mdbn-core --test merge_properties dump_cases -- --ignored
    scripts/diff-merge-model.py SPEC_CHECKOUT [target/merge-cases.jsonl]

SPEC_CHECKOUT is an mdbase-spec checkout (scripts/concurrent_edits_model.py).
Differences are grouped by kind; docs/spec-notes.md explains the known ones.
"""

import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
import concurrent_edits_model as model  # noqa: E402

TYPE = (Path(__file__).resolve().parent.parent / "crates/core/tests/merge_properties.rs").read_text()
TYPE = TYPE.split('const TYPE: &str = "', 1)[1].split('";', 1)[0].encode().decode("unicode_escape")

cases = Path(sys.argv[2] if len(sys.argv) > 2 else "target/merge-cases.jsonl")
types = [model.load_type(TYPE)]
diffs = collections.Counter()
examples = {}
n = 0
for line in cases.read_text().splitlines():
    c = json.loads(line)
    n += 1
    try:
        r = model.merge_records(types, c["base"], c["first"], c["second"], "items/a.md", "items/a.md", "items/a.md")
    except Exception as e:  # the model has no error handling
        diffs[f"model raised {type(e).__name__}"] += 1
        examples.setdefault(f"model raised {type(e).__name__}", (c, str(e)))
        continue
    mc = [{k: v for k, v in x.items() if k in ("kind", "field")} for x in r.conflicts]
    if mc != c["conflicts"]:
        kind = "conflicts differ"
        diffs[kind] += 1
        examples.setdefault(kind, (c, mc))
    if r.document != c["document"]:
        fm_m = model.parse_document(r.document).frontmatter
        fm_c = model.parse_document(c["document"]).frontmatter
        kind = "document differs (frontmatter values differ)" if fm_m != fm_c else "document differs (bytes only)"
        diffs[kind] += 1
        examples.setdefault(kind, (c, r.document))
print(f"{n} cases")
for kind, count in diffs.most_common():
    print(f"  {count:6d}  {kind}")
    c, other = examples[kind]
    print("    seed", c["seed"])
    print("    core:", json.dumps(c["document"]))
    print("    model:", json.dumps(other) if isinstance(other, str) else other)
