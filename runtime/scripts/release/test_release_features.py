"""Hermetic release graph checks; fake cargo emits metadata, never compiles."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "check-release-features.sh"


class ReleaseFeatures(unittest.TestCase):
    def run_check(self, graph, *args, tree_status=0):
        # Under the owned worktree, not /tmp (even though no build occurs).
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'metadata':
    print(json.dumps({'packages': [{'name': n} for n in ['shipped', 'portable']]}))
elif sys.argv[1] == 'tree':
    print(os.environ['GRAPH'])
    sys.exit(int(os.environ['TREE_STATUS']))
else:
    sys.exit(99)
""")
            cargo.chmod(0o700)
            calls = root / "calls.jsonl"
            result = subprocess.run(
                ["bash", str(SCRIPT), *args], capture_output=True, text=True,
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                     "CALLS": str(calls), "GRAPH": graph,
                     "TREE_STATUS": str(tree_status)}, check=False,
            )
            return result, [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def test_empty_root_and_allowed_dependency_features(self):
        result, _ = self.run_check("shipped v0.0.0 (/owned/shipped)|\nportable v0.0.0|default,sqlite", "shipped")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_denied_root_feature(self):
        for feature in ["lab", "testing", "testkit", "test-secret", "test_secret", "debug-hooks", "debug_hooks", "insecure-test-file"]:
            with self.subTest(feature=feature):
                result, _ = self.run_check(f"shipped v0.0.0 (/owned/shipped)|{feature}", "shipped")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"shipped/{feature}", result.stderr)

    def test_dependency_feature_and_deduplication(self):
        result, _ = self.run_check("shipped v0.0.0|\nportable v0.0.0|default,testing\nportable v0.0.0|testing", "shipped")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.count("portable/testing"), 1)

    def test_unrelated_nonworkspace_feature_is_not_a_workspace_hook(self):
        result, _ = self.run_check("shipped v0.0.0|\nthirdparty v1.0.0|testing", "shipped")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_identical_build_selection_flags_and_edges(self):
        result, calls = self.run_check("shipped v0.0.0|", "--target", "target-not-installed", "--features", "production", "--no-default-features", "shipped", "portable")
        self.assertEqual(result.returncode, 0, result.stderr)
        trees = [call for call in calls if call[0] == "tree"]
        self.assertEqual(len(trees), 2)  # never resolve both packages together
        self.assertEqual([call[call.index("-p") + 1] for call in trees], ["shipped", "portable"])
        for call in trees:
            self.assertIn("--locked", call)
            self.assertEqual(call[call.index("--target") + 1], "target-not-installed")
            self.assertEqual(call[call.index("--features") + 1], "production")
            self.assertIn("--no-default-features", call)
            self.assertEqual(call[call.index("-e") + 1], "normal,build")
            self.assertEqual(call[call.index("--format") + 1], "{p}|{f}")

    def test_all_features_forwarded_not_silently_ignored(self):
        result, calls = self.run_check("shipped v0.0.0|testing", "--all-features", "shipped")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--all-features", calls[-1])

    def test_cargo_failure_not_reported_as_a_clean_graph(self):
        result, _ = self.run_check("shipped v0.0.0|", "shipped", tree_status=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("no LAB/test-only", result.stdout)

    def test_unknown_package_and_missing_option_values(self):
        for args in [("missing",), (), ("--target",), ("--features",), ("--target", "", "shipped"), ("--all-targets", "shipped")]:
            with self.subTest(args=args):
                result, calls = self.run_check("shipped v0.0.0|", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == "tree" for call in calls))


if __name__ == "__main__":
    unittest.main()
