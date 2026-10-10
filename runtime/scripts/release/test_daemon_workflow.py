"""Offline workflow/path/signing-policy regressions. Never dispatches or signs."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
import zipfile

from verify_archive import archive_names, verify_and_extract

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/daemon-release.yml"
MAPPING = "${{ github.repository == 'mdbase-dev/mdbase-connect' && 'runtime' || '.' }}"
SIGNING = "${{ github.event_name == 'workflow_dispatch' && github.repository == 'mdbase-dev/mdbase-connect' && github.ref == 'refs/heads/main' && github.actor == 'callumalpass' && github.triggering_actor == 'callumalpass' }}"


class DaemonWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = WORKFLOW.read_text()
        match = re.search(r"      - id: plan.*?        run: \|\n(.*?)(?=\n  build:)", cls.source, re.S)
        assert match
        cls.plan = textwrap.dedent(match[1]).replace("${{ github.event.pull_request.number }}", "17")

    def run_plan(self, repo, event, signing, version="0.2.0-beta.1"):
        with tempfile.TemporaryDirectory(dir=ROOT / "scripts/release") as directory:
            owned = Path(directory)
            source_root = owned / "runtime" if repo == "mdbase-dev/mdbase-connect" else owned
            scripts = source_root / "scripts/release"
            scripts.mkdir(parents=True)
            shutil.copy(ROOT / "scripts/release/validate_version.py", scripts)
            output = owned / "outputs"
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", self.plan], cwd=source_root,
                env={**os.environ, "GITHUB_REPOSITORY": repo, "GITHUB_EVENT_NAME": event,
                     "TRUSTED_SIGNING": signing, "INPUT_VERSION": version,
                     "GITHUB_OUTPUT": str(output)}, capture_output=True, text=True, check=False)
            values = dict(line.split("=", 1) for line in output.read_text().splitlines()) if output.exists() else {}
            return result, values

    def test_exact_source_mapping_and_artifact_paths(self):
        self.assertEqual(self.source.count("working-directory: ${{ env.RUNTIME_DIR }}\n"), 4)
        self.assertIn(f"RUNTIME_DIR: {MAPPING}", self.source)
        paths = re.findall(r"^          path: (.+)$", self.source, re.M)
        self.assertEqual(paths, ["${{ env.RUNTIME_DIR }}/staged/", "${{ env.RUNTIME_DIR }}/in",
                                "${{ env.RUNTIME_DIR }}/staged/", "${{ env.RUNTIME_DIR }}/in",
                                "${{ env.RUNTIME_DIR }}/dist/"])
        self.assertEqual(self.source.count("working-directory: ${{ env.RUNTIME_DIR }}/dist"), 2)
        for subject in ["*.tar.gz", "*.zip", "SHA256SUMS"]:
            self.assertIn(f"${{{{ env.RUNTIME_DIR }}}}/dist/{subject}", self.source)
        # Every job using the mapped working directory has checked-out source.
        for name in ["plan", "build", "macos", "package"]:
            block = re.search(rf"^  {name}:\n(.*?)(?=^  \w+:|\Z)", self.source, re.M | re.S)
            self.assertIsNotNone(block)
            self.assertIn("actions/checkout@", block[1])

    def test_downloaded_single_and_full_matrix_preserve_named_archive_inputs(self):
        # Pinned download-artifact v8 extracts a SINGLE pattern match directly to
        # path/. Multiple matches also extract there with merge-multiple=true.
        # Keep bin-<target>/ inside uploaded bytes, never rely on action nesting.
        self.assertEqual(self.source.count("          merge-multiple: true"), 2)
        def stage_block(name):
            match = re.search(rf"      - name: {name}\n        shell: bash\n        run: \|\n(.*?)(?=      - )", self.source, re.S)
            self.assertIsNotNone(match)
            return textwrap.dedent(match[1])

        stage = stage_block("Stage the binary")
        universal = stage_block("Stage universal binary")
        targets = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
                   "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]
        payload = b"fake compiled binary; never executed"
        version = "0.0.0-pr.1"
        for layout in ["private", "public"]:
            for full_matrix in [False, True]:
                with self.subTest(layout=layout, full_matrix=full_matrix), tempfile.TemporaryDirectory(dir=ROOT / "scripts/release") as directory:
                    checkout = Path(directory)
                    root = checkout / "runtime" if layout == "public" else checkout
                    root.mkdir(exist_ok=True)
                    destination = root / "in"
                    destination.mkdir()
                    cases = targets + ["universal-apple-darwin"] if full_matrix else targets[:1]
                    for target in cases:
                        binary = "mdbase.exe" if "windows" in target else "mdbase"
                        if target == "universal-apple-darwin":
                            output = root / "out"
                            output.mkdir()
                            (output / binary).write_bytes(payload)
                            (output / "macos-mode").write_text("unsigned\n")
                            script = universal
                        else:
                            output = root / "target" / target / "release"
                            output.mkdir(parents=True)
                            (output / binary).write_bytes(payload)
                            script = stage
                        subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=root,
                            env={**os.environ, "BINARY": "mdbase", "TARGET": target},
                            capture_output=True, check=True)
                        staged = root / "staged"
                        # Upload staged/ contents, download to in/ without another
                        # artifact-name wrapper: models BOTH one and many matches.
                        archive_bytes = io.BytesIO()
                        with zipfile.ZipFile(archive_bytes, "w") as archive:
                            for file in staged.rglob("*"):
                                if file.is_file():
                                    archive.write(file, file.relative_to(staged))
                        with zipfile.ZipFile(archive_bytes) as archive:
                            archive.extractall(destination)
                        shutil.rmtree(staged)
                    subprocess.run(["bash", str(ROOT / "scripts/release/package.sh"),
                        "in", "dist", version], cwd=root,
                        env={**os.environ, "SOURCE_DATE_EPOCH": "1710000000"},
                        capture_output=True, check=True)
                    expected = [target for target in cases if "apple" not in target or target == "universal-apple-darwin"]
                    self.assertEqual(len(list((root / "dist").iterdir())), len(expected))
                    (root / "verified").mkdir()
                    for target in expected:
                        unsigned = "windows" in target or "apple" in target
                        stem, _, extension = archive_names(version, target, unsigned)
                        archive = root / "dist" / f"{stem}.{extension}"
                        data = archive.read_bytes()
                        verified = root / "verified" / target
                        verify_and_extract(archive, verified, version, target,
                            hashlib.sha256(data).hexdigest(), len(data), unsigned)
                        binary = "mdbase.exe" if "windows" in target else "mdbase"
                        self.assertEqual((verified / binary).read_bytes(), payload)

    def test_exact_signing_repo_main_actor_and_rerun_actor(self):
        self.assertIn(f"TRUSTED_SIGNING: {SIGNING}", self.source)
        self.assertEqual(self.source.count("if: needs.plan.outputs.signing == 'true'"), 3)
        self.assertIn("SIGNING_REPO: ${{ needs.plan.outputs.signing }}", self.source)
        self.assertIn('"https://github.com/${GITHUB_REPOSITORY}/.github/workflows/daemon-release.yml@${GITHUB_REF}"', self.source)

    def test_stamped_binary_checks_effective_debug_cfg(self):
        self.assertIn("MDBN_RELEASE_VERSION: ${{ needs.plan.outputs.version }}", self.source)
        main = (ROOT / "crates/daemon/src/main.rs").read_text()
        self.assertIn('option_env!("MDBN_RELEASE_VERSION").is_none() || !cfg!(debug_assertions)', main)
        self.assertIn('"version-stamped artifacts must disable debug assertions"', main)

    def test_one_binary_never_examples_tests_or_workspace(self):
        self.assertIn('cargo build --release --locked -p "$PACKAGE" --bin "$BINARY" --target "$TARGET"', self.source)
        for flag in ["--workspace", "--all-targets", "--examples", "--tests", "--benches", "--all-features"]:
            self.assertNotIn(flag, self.source)

    def test_private_dispatch_is_unsigned_full_matrix(self):
        result, values = self.run_plan("mdbase-dev/mdbase-next", "workflow_dispatch", "false")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["signing"], "false")
        self.assertEqual(len(json.loads(values["matrix"])), 5)

    def test_public_main_dispatch_plan_uses_runtime_subtree(self):
        result, values = self.run_plan("mdbase-dev/mdbase-connect", "workflow_dispatch", "true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(values["signing"], "true")
        self.assertEqual(values["version"], "0.2.0-beta.1")

    def test_public_nontrusted_dispatch_refused_before_outputs(self):
        result, values = self.run_plan("mdbase-dev/mdbase-connect", "workflow_dispatch", "false")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(values)

    def test_private_and_public_prs_never_sign(self):
        for repo in ["mdbase-dev/mdbase-next", "mdbase-dev/mdbase-connect"]:
            result, values = self.run_plan(repo, "pull_request", "false")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(values["signing"], "false")
            self.assertEqual(values["version"], "0.0.0-pr.17")
            self.assertEqual(len(json.loads(values["matrix"])), 1)

    def test_invalid_dispatch_version_refused(self):
        result, values = self.run_plan("mdbase-dev/mdbase-connect", "workflow_dispatch", "true", "0.2.0-beta..1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(values)


if __name__ == "__main__":
    unittest.main()
