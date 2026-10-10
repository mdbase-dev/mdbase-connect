import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkedFiles, FILES, FULL_JOBS, gate, inputs, pack, REPOSITORY, selectArtifact, sha256, verifyJobs, verifyRun } from './attest-log-worker.mjs';

const source = 'a'.repeat(40);
const input = { source, producerId: 1, producerAttempt: 2, ciId: 3, ciAttempt: 4 };
const artifact = { id: 5, name: 'logsvc-do-worker-1-2', expired: false, digest: `sha256:${'c'.repeat(64)}`,
  size_in_bytes: 100, workflow_run: { id: 1, head_sha: source } };
const build = { schema: 'mdbase-next-log-worker-build/1', repository: REPOSITORY,
  workflow: 'logsvc-do.yml', source_revision: source, run_id: 1, run_attempt: 2 };
const template = Buffer.from('{"main":"build/worker/shim.mjs"}\n');
function run(workflow, id, attempt) {
  return { id, run_attempt: attempt, head_sha: source, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', repository: { full_name: REPOSITORY, private: true },
    actor: { login: 'callumalpass' }, triggering_actor: { login: 'callumalpass' }, path: `.github/workflows/${workflow}` };
}
function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), 'worker-sign-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = join(root, 'files');
  mkdirSync(join(files, 'worker'), { recursive: true });
  const bytes = { 'index.js': Buffer.from('export {};\n'), 'index_bg.wasm': Buffer.from('toy wasm'),
    'package.json': Buffer.from('{"type":"module"}\n'), 'worker/shim.mjs': Buffer.from('export {};\n'),
    'SOURCE_REVISION': Buffer.from(`${source}\n`), 'BUILD.json': Buffer.from(`${JSON.stringify(build)}\n`),
    'wrangler.jsonc': template };
  for (const [name, content] of Object.entries(bytes)) writeFileSync(join(files, name), content);
  writeFileSync(join(files, 'SHA256SUMS'), Object.entries(bytes).map(([name, content]) => `${sha256(content)}  ${name}\n`).join(''));
  return { root, files };
}

test('input validation refuses non-full SHAs and ambiguous run integers', () => {
  const env = { SOURCE_REVISION: source, LOG_RUN_ID: '1', LOG_RUN_ATTEMPT: '2', CI_RUN_ID: '3', CI_RUN_ATTEMPT: '4' };
  assert.deepEqual(inputs(env), input);
  for (const patch of [{ SOURCE_REVISION: 'main' }, { LOG_RUN_ID: '0' }, { CI_RUN_ID: '1;echo bad' },
    { CI_RUN_ATTEMPT: '9007199254740992' }, { LOG_RUN_ATTEMPT: '02' }]) assert.throws(() => inputs({ ...env, ...patch }));
});

test('main exact push source/run/attempt/actor identities are mandatory', () => {
  const good = run('logsvc-do.yml', 1, 2);
  const expected = { id: 1, attempt: 2, source };
  verifyRun(good, expected, 'logsvc-do.yml');
  for (const patch of [{ id: 9 }, { run_attempt: 9 }, { event: 'pull_request' }, { head_branch: 'feature' },
    { conclusion: 'failure' }, { head_sha: 'd'.repeat(40) }, { path: '.github/workflows/other.yml' },
    { actor: { login: 'other' } }, { triggering_actor: { login: 'other' } },
    { repository: { full_name: REPOSITORY, private: false } }]) {
    assert.throws(() => verifyRun({ ...good, ...patch }, expected, 'logsvc-do.yml'));
  }
});

test('full checks refuse skips, missing, failures and duplicate names', () => {
  const jobs = FULL_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  verifyJobs(jobs, FULL_JOBS);
  assert.throws(() => verifyJobs(jobs.slice(1), FULL_JOBS));
  assert.throws(() => verifyJobs([...jobs, jobs[0]], FULL_JOBS));
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    assert.throws(() => verifyJobs([{ ...jobs[0], conclusion }, ...jobs.slice(1)], FULL_JOBS));
  }
});

test('artifact must be unique, unexpired, digest-bound and from exact attempt/source', () => {
  assert.deepEqual(selectArtifact([artifact], input), artifact);
  assert.throws(() => selectArtifact([artifact, artifact], input));
  for (const patch of [{ expired: true }, { digest: null }, { size_in_bytes: 200 * 1024 * 1024 },
    { name: 'logsvc-do-worker-1-1' }, { workflow_run: { id: 1, head_sha: 'd'.repeat(40) } }]) {
    assert.throws(() => selectArtifact([{ ...artifact, ...patch }], input));
  }
});

test('gate also binds main ancestry and both required workflows', () => {
  const api = (path) => path.includes('/compare/') ? { status: 'ahead', base_commit: { sha: source } }
    : path.endsWith('/1') ? run('logsvc-do.yml', 1, 2) : run('ci.yml', 3, 4);
  const list = (path) => path.includes('/artifacts') ? [artifact]
    : path.includes('/1/attempts/2/jobs') ? [{ name: 'logsvc DO (wasm32, local conformance, restart replay)', status: 'completed', conclusion: 'success' }]
      : FULL_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  assert.equal(gate(input, api, list).id, 5);
  assert.throws(() => gate(input, (path) => path.includes('/compare/') ? { status: 'diverged', base_commit: { sha: source } } : api(path), list));
});

test('gate refuses a rerun starting during evidence observation', () => {
  let observations = 0;
  const api = (path) => path.includes('/compare/') ? { status: 'identical', base_commit: { sha: source } }
    : path.endsWith('/1') ? run('logsvc-do.yml', 1, ++observations === 1 ? 2 : 3) : run('ci.yml', 3, 4);
  const list = (path) => {
    assert(!path.includes('filter=latest'));
    return path.includes('/artifacts') ? [artifact] : path.includes('/1/attempts/2/jobs')
      ? [{ name: 'logsvc DO (wasm32, local conformance, restart replay)', status: 'completed', conclusion: 'success' }]
      : FULL_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  };
  assert.throws(() => gate(input, api, list));
});

test('fixed regular file profile and all producer checksums pass', (t) => {
  const { files } = fixture(t);
  assert.deepEqual(Object.keys(checkedFiles(files, input)).sort(), [...FILES].sort());
});

test('altered source and build attempt are refused', (t) => {
  const { files } = fixture(t);
  writeFileSync(join(files, 'SOURCE_REVISION'), `${'d'.repeat(40)}\n`);
  assert.throws(() => checkedFiles(files, input));
  writeFileSync(join(files, 'SOURCE_REVISION'), `${source}\n`);
  writeFileSync(join(files, 'BUILD.json'), JSON.stringify({ ...build, run_attempt: 1 }));
  assert.throws(() => checkedFiles(files, input));
});

test('malformed, extra and escaped-duplicate receipt fields are refused safely', (t) => {
  const { files } = fixture(t);
  for (const text of [JSON.stringify({ ...build, extra: 'toy private value' }),
    JSON.stringify(build).replace('"schema":', '"sch\\u0065ma":"ignored","schema":')]) {
    writeFileSync(join(files, 'BUILD.json'), text);
    assert.throws(() => checkedFiles(files, input), /unexpected or duplicate build fields/);
  }
  writeFileSync(join(files, 'BUILD.json'), '{toy private value');
  assert.throws(() => checkedFiles(files, input), (error) => error.message === 'invalid build receipt JSON');
});

test('checksum corruption and duplicate inventory are refused', (t) => {
  const { files } = fixture(t);
  const sums = readFileSync(join(files, 'SHA256SUMS'), 'utf8');
  writeFileSync(join(files, 'index.js'), 'changed');
  assert.throws(() => checkedFiles(files, input));
  writeFileSync(join(files, 'index.js'), 'export {};\n');
  writeFileSync(join(files, 'SHA256SUMS'), sums + sums.split('\n')[0] + '\n');
  assert.throws(() => checkedFiles(files, input));
});

test('unexpected files and symlinks are refused', (t) => {
  const { files } = fixture(t);
  writeFileSync(join(files, '.dev.vars'), 'toy fixture only');
  assert.throws(() => checkedFiles(files, input));
  rmSync(join(files, '.dev.vars'));
  rmSync(join(files, 'index.js'));
  symlinkSync('package.json', join(files, 'index.js'));
  assert.throws(() => checkedFiles(files, input));
});

test('pack is deterministic, binds producer artifact digest, and never rebuilds', (t) => {
  const { root, files } = fixture(t);
  const signer = { source: 'b'.repeat(40), id: 6, attempt: 1 };
  const first = pack(files, join(root, 'one'), template, input, signer, artifact);
  const second = pack(files, join(root, 'two'), template, input, signer, artifact);
  assert.equal(first.archive.sha256, second.archive.sha256);
  assert.equal(first.producer.artifact_sha256, 'c'.repeat(64));
  assert.deepEqual(first.qualification, { workflow: 'ci.yml', run_id: 3, run_attempt: 4 });
  const names = execFileSync('tar', ['-tzf', join(root, 'one/logsvc-do-worker.tar.gz')], { encoding: 'utf8' }).trim().split('\n');
  assert(names.every((name) => name.startsWith('deploy/cloudflare-do/')));
  assert(names.includes('deploy/cloudflare-do/wrangler.jsonc'));
  assert(names.includes('deploy/cloudflare-do/build/BUILD.json'));
});

test('pack refuses a template differing from exact source and existing output', (t) => {
  const { root, files } = fixture(t);
  const signer = { source: 'b'.repeat(40), id: 6, attempt: 1 };
  assert.throws(() => pack(files, join(root, 'bad'), Buffer.from('changed'), input, signer, artifact));
  pack(files, join(root, 'one'), template, input, signer, artifact);
  assert.throws(() => pack(files, join(root, 'one'), template, input, signer, artifact));
});
