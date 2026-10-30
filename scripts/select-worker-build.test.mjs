import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildReceipt } from './select-worker-build.mjs';
import { REPOSITORY } from './release-workers.mjs';

function fixture() {
  const source = 'a'.repeat(40), publisher = 'b'.repeat(40);
  const env = { RELEASE_ENVIRONMENT: 'staging', SOURCE_REVISION: source, BUILD_RUN_ID: '12', BUILD_RUN_ATTEMPT: '3',
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'c'.repeat(40), GITHUB_ACTOR: 'callumalpass',
    GITHUB_TRIGGERING_ACTOR: 'callumalpass', GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release-workers.yml@refs/heads/main` };
  const run = { id: 12, run_attempt: 3, head_sha: publisher, head_branch: 'main', event: 'workflow_run',
    path: '.github/workflows/build-workers.yml', status: 'completed', conclusion: 'success',
    repository: { full_name: REPOSITORY, private: false } };
  const artifact = { id: 40, name: `unsigned-staging-workers-${source}-12-3`, expired: false,
    digest: 'sha256:' + 'd'.repeat(64), workflow_run: { id: 12, head_sha: publisher } };
  const ancestry = { status: 'ahead', base_commit: { sha: publisher } };
  const api = path => path.includes('/compare/') ? ancestry : run;
  const list = () => [artifact];
  return { env, run, artifact, ancestry, api, list };
}

test('owner selects an existing build after main advances, without source/signing SHA equality', () => {
  const f = fixture(), result = buildReceipt(f.env, f.api, f.list);
  assert.equal(result.run_attempt, 3);
  assert.equal(result.artifact_id, 40);
  assert.notEqual(f.env.SOURCE_REVISION, f.env.GITHUB_SHA);
});

test('selection refuses non-owner, unprotected/fork/PR, rerun, expired and crossed artifacts', () => {
  for (const mutate of [
    f => { f.env.GITHUB_ACTOR = 'contributor'; }, f => { f.env.GITHUB_TRIGGERING_ACTOR = 'contributor'; },
    f => { f.env.GITHUB_REF_PROTECTED = 'false'; }, f => { f.env.GITHUB_EVENT_NAME = 'push'; },
    f => { f.run.repository.full_name = 'fork/repo'; }, f => { f.run.repository.private = true; },
    f => { f.run.head_branch = 'feature'; }, f => { f.run.event = 'pull_request'; },
    f => { f.run.path = '.github/workflows/runtime-ci.yml'; }, f => { f.run.run_attempt++; },
    f => { f.run.conclusion = 'failure'; }, f => { f.artifact.expired = true; },
    f => { delete f.artifact.digest; }, f => { f.artifact.name += '-wrong'; },
    f => { f.artifact.workflow_run.id++; }, f => { f.artifact.workflow_run.head_sha = 'e'.repeat(40); },
    f => { f.list = () => [f.artifact, f.artifact]; }, f => { f.ancestry.status = 'diverged'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => buildReceipt(f.env, f.api, f.list));
  }
});

test('archive extraction refuses traversal, symlinks, duplicates and oversized entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-extract-'));
  try {
    for (const kind of ['regular', 'traversal', 'symlink', 'duplicate', 'oversize']) {
      const archive = join(directory, `${kind}.zip`), output = join(directory, kind);
      const create = spawnSync('python3', ['-I', '-B', '-c', `
import sys, zipfile
kind, path = sys.argv[1:]
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    name = '../escape' if kind == 'traversal' else 'log/compiled/worker.js'
    entry = zipfile.ZipInfo(name)
    if kind == 'symlink': entry.external_attr = 0o120777 << 16
    bundle.writestr(entry, b'export default {};')
    if kind == 'duplicate': bundle.writestr(name, b'other')
    if kind == 'oversize': bundle.writestr('large', b'x' * (128 * 1024 * 1024))
`, kind, archive]);
      assert.equal(create.status, 0);
      const result = spawnSync('python3', ['-I', '-B', new URL('./unpack-worker-build.py', import.meta.url).pathname, archive, output]);
      assert.equal(result.status === 0, kind === 'regular', result.stderr.toString());
      if (kind === 'regular') assert.equal(readFileSync(join(output, 'log/compiled/worker.js'), 'utf8'), 'export default {};');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
