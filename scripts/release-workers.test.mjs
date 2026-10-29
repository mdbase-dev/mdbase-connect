// Hermetic source/API and post-authentication byte-custody regressions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, REPOSITORY, DO_JOB, CI_JOBS, CI_WORKFLOW, IDENTITY, OPS_VERIFIER_COMMIT,
  check, inputs, publisher, gate, fileInventory } from './release-workers.mjs';

const source = 'a'.repeat(40), connect = 'b'.repeat(40), trustPublisher = 'c'.repeat(40);
const base = resolve(dirname(fileURLToPath(import.meta.url)), '../target/release-workers-tests');
mkdirSync(base, { recursive: true });
const publicAsset = Buffer.from('{"unit_test_only":true}\n');
function env(environment = 'staging') {
  return { RELEASE_ENVIRONMENT: environment, SOURCE_REVISION: source, CI_RUN_ID: '1', CI_RUN_ATTEMPT: '2', LOG_RUN_ID: '3', LOG_RUN_ATTEMPT: '4',
    TRUST_RELEASE: JSON.stringify({ source_commit: connect, image_run: 101, trust_run: 102, publisher_commit: trustPublisher, asset_sha256: sha256(publicAsset) }),
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ACTOR: 'callumalpass', GITHUB_TRIGGERING_ACTOR: 'callumalpass', GITHUB_SHA: source,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release-workers.yml@refs/heads/main`, GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '2' };
}
const clone = value => structuredClone(value);
function withBundle(fn, environment = 'staging') {
  // Synthetic post-authentication byte custody only: never a signed release or
  // the private managed configuration. No source/config/profile is published.
  const CP = `https://connect${environment === 'staging' ? '-staging' : ''}.mdbase.dev`, LOG = 'https://log.example.test';
  const e = env(environment), dir = mkdtempSync(join(base, 'fixture-'));
  const write = (name, data) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), data); };
  const json = (name, value) => write(name, JSON.stringify(value));
  const input = inputs(e), src = { repository: REPOSITORY, commit: connect, version: '1.0.0-synthetic' };
  const image = Buffer.from(JSON.stringify({ ...src, publication: { runId: 101, runAttempt: 3 } }));
  const bundle = Buffer.from(JSON.stringify({ ...src, schemaVersion: 1, kind: 'mdbase-release-trust-bundle',
    trustAssets: [{ path: `next-trust/${environment}.json`, length: publicAsset.length, sha256: sha256(publicAsset), environment, controlPlaneOrigin: CP, logOrigin: LOG, source: src }],
    imageBundle: { path: 'image-release-bundle.json', length: image.length, sha256: sha256(image), publicationRunId: 101, publicationRunAttempt: 3 },
    publication: { runId: 102, runAttempt: 4, publisherCommit: trustPublisher }, qualification: { runId: 103, runAttempt: 5 } }));
  const proofs = { 'release-trust-bundle.json': bundle, 'release-trust-bundle.sigstore.json': Buffer.from('synthetic, not an authenticated signature'),
    'image-release-bundle.json': image, 'image-release-bundle.sigstore.json': Buffer.from('synthetic, not an authenticated signature') };
  const context = Buffer.from(JSON.stringify({ schema_version: 1, kind: 'mdbase-next-build-trust-context',
    context: { sha256: sha256(publicAsset), environment, control_plane_origin: CP, log_origin: LOG, source: src },
    provenance: { asset_path: `next-trust/${environment}.json`, asset_length: publicAsset.length,
      proof_sha256: Object.fromEntries(Object.entries(proofs).map(([name, bytes]) => [name, sha256(bytes)])),
      image_publication: { run_id: 101, run_attempt: 3 }, trust_publication: { run_id: 102, run_attempt: 4, publisher_commit: trustPublisher },
      publisher_qualification: { run_id: 103, run_attempt: 5 } } }));
  for (const [name, bytes] of Object.entries(proofs)) write(`trust/${name}`, bytes);
  write(`trust/next-trust/${environment}.json`, publicAsset); write(`trust/next-trust/${environment}-context.json`, context);
  json('trust/build-receipt.json', { schema: 'mdbn-sdk/application-build/1', contextSha256: sha256(context), verifierSha256: 'd'.repeat(64), verifierSourceCommit: source });
  for (const role of ['log', 'hosted', 'escrow']) {
    json(`${role}/wrangler.json`, { main: 'compiled/worker.js', no_bundle: true });
    write(`${role}/compiled/worker.js`, 'export default {};\n');
    write(`${role}/compiled/native.wasm`, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  }
  const receipt = readFileSync(join(dir, 'trust/build-receipt.json'));
  const manifest = { schema: `mdbase-${environment}-next-stack/1`, environment, account_id: '0'.repeat(32), next_source: source,
    origins: { log: LOG, hosted: 'https://hosted.example.test', escrow: 'https://escrow.example.test' }, cp_origin: CP,
    wrangler_version: '4.147.0', cors_origins: [], initial_kms_collections: 'all',
    publication: publisher(e, input),
    qualification: { ci: { workflow: CI_WORKFLOW, run_id: input.ciId, run_attempt: input.ciAttempt },
      log: { workflow: CI_WORKFLOW, run_id: input.logId, run_attempt: input.logAttempt } },
    trust: { asset_sha256: input.trust.asset_sha256, asset_size: publicAsset.length, source: src,
      context_sha256: sha256(context), receipt_sha256: sha256(receipt),
      verifier: { source_commit: source, sha256: 'd'.repeat(64) }, ops_verifier_commit: OPS_VERIFIER_COMMIT },
    files: fileInventory(dir, environment) };
  const save = () => { const raw = `${JSON.stringify(manifest)}\n`; write('manifest.json', raw); return sha256(raw); };
  try { fn({ dir, write, json, input, e, manifest, save }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function apiFixture() {
  const run = (id, attempt) => ({ id, run_attempt: attempt, head_sha: source, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', repository: { full_name: REPOSITORY, private: false },
    actor: { login: 'callumalpass' }, triggering_actor: { login: 'callumalpass' }, path: '.github/workflows/runtime-ci.yml' });
  const runs = { 1: run(1, 2), 3: run(3, 4) };
  const jobs = names => names.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const lists = { 1: jobs(CI_JOBS), 3: jobs([DO_JOB]) }, ancestry = { status: 'identical', base_commit: { sha: source } };
  return { runs, lists, ancestry, api: path => clone(path.includes('/compare/') ? ancestry : runs[path.split('/').at(-1)]),
    list: path => clone(lists[path.split('/runs/')[1].split('/')[0]]) };
}
test('closed dispatch inputs contain no caller paths, byte artifacts, arbitrary tier or signature authority', () => {
  const e = env(); assert.equal(inputs(e).source, source);
  for (const key of ['source_commit', 'publisher_commit', 'asset_sha256']) {
    const v = JSON.parse(e.TRUST_RELEASE); v[key] = '/private/arbitrary-file';
    assert.throws(() => inputs({ ...e, TRUST_RELEASE: JSON.stringify(v) }));
  }
  for (const v of [{ ...JSON.parse(e.TRUST_RELEASE), checkout: '/private' }, { ...JSON.parse(e.TRUST_RELEASE), publisher_commit: [trustPublisher] }, [], null]) assert.throws(() => inputs({ ...e, TRUST_RELEASE: JSON.stringify(v) }));
  const duplicate = e.TRUST_RELEASE.replace('{', '{"publisher_commit":"' + connect + '",');
  assert.throws(() => inputs({ ...e, TRUST_RELEASE: duplicate }));
  for (const [key, value] of [['SOURCE_REVISION', 'main'], ['CI_RUN_ID', '0'], ['CI_RUN_ATTEMPT', '1;echo bad'], ['LOG_RUN_ID', '9007199254740992'], ['LOG_RUN_ATTEMPT', '-1']]) assert.throws(() => inputs({ ...e, [key]: value }));
});

test('publication equals the protected main dispatch SHA, exact identity, actor and rerun actor', () => {
  const e = env(), input = inputs(e);
  assert.equal(publisher(e, input).publisher_commit, source);
  for (const [key, value] of [['GITHUB_REF', 'refs/pull/1/merge'], ['GITHUB_REF_PROTECTED', 'false'], ['GITHUB_REPOSITORY', 'fork/repo'],
    ['GITHUB_EVENT_NAME', 'pull_request_target'], ['GITHUB_SHA', connect], ['GITHUB_ACTOR', 'other'], ['GITHUB_TRIGGERING_ACTOR', 'other'],
    ['GITHUB_WORKFLOW_REF', `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`], ['GITHUB_RUN_ID', '0'], ['GITHUB_RUN_ATTEMPT', 'NaN']]) {
    assert.throws(() => publisher({ ...e, [key]: value }, input));
  }
});

test('CLI refuses local/non-main context before invoking git, GitHub, a compiler or signing', () => {
  const script = fileURLToPath(new URL('./release-workers.mjs', import.meta.url));
  const e = { ...env(), PATH: '', GITHUB_REF: 'refs/pull/1/merge' };
  const child = spawnSync(process.execPath, [script, 'verify'], { env: e, encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
  assert.match(child.stderr, /^Managed Worker publication refused:/);
  assert.ok(!child.stderr.includes('/private/'));
});
test('exact successful source CI and log attempts on main qualify, with no artifact bytes input', () => {
  const input = inputs(env()), f = apiFixture(input);
  gate(input, f.api, f.list);
  assert.ok(CI_JOBS.includes('Hosted worker'));
  assert.ok(CI_JOBS.includes('sdk execution'));
});
test('successful exact-main CI and log owner dispatches qualify with every mandatory execution job', () => {
  const input = inputs(env());
  for (const ciEvent of ['push', 'workflow_dispatch']) {
    for (const logEvent of ['push', 'workflow_dispatch']) {
      const f = apiFixture(input);
      f.runs[1].event = ciEvent; f.runs[3].event = logEvent;
      gate(input, f.api, f.list);
      f.lists[1] = f.lists[1].filter(job => job.name !== 'sdk execution');
      assert.throws(() => gate(input, f.api, f.list));
    }
  }
});
test('PR, schedule, merge-group and workflow-call evidence never qualifies as a main push or dispatch', () => {
  const input = inputs(env());
  for (const id of [1, 3]) {
    for (const event of ['pull_request', 'pull_request_target', 'schedule', 'merge_group', 'workflow_call']) {
      const f = apiFixture(input); f.runs[id].event = event;
      assert.throws(() => gate(input, f.api, f.list));
    }
  }
});
for (const [key, value] of [['head_sha', connect], ['head_branch', 'topic'], ['run_attempt', 3], ['event', 'pull_request'], ['status', 'in_progress'], ['conclusion', 'skipped'], ['path', '.github/workflows/fake.yml']]) {
  test(`source qualification refuses ${key} mismatch`, () => {
    const input = inputs(env()), f = apiFixture(input); f.runs[1][key] = value;
    assert.throws(() => gate(input, f.api, f.list));
  });
}
test('fork/private repo and alternate actor qualification are refused', () => {
  const input = inputs(env());
  for (const mutate of [r => { r.repository.full_name = 'fork/repo'; }, r => { r.repository.private = true; }, r => { r.actor.login = 'other'; }, r => { r.triggering_actor.login = 'other'; }]) {
    const f = apiFixture(input); mutate(f.runs[1]); assert.throws(() => gate(input, f.api, f.list));
  }
});
test('missing, skipped, duplicate or cancelled native hosted jobs cannot hide behind successful result wrappers', () => {
  const input = inputs(env());
  for (const mutate of [jobs => jobs.filter(j => j.name !== 'Hosted worker'), jobs => [...jobs, jobs.find(j => j.name === 'Hosted worker')],
    jobs => jobs.map(j => j.name === 'Hosted worker' ? { ...j, conclusion: 'skipped' } : j), jobs => jobs.map(j => j.name === DO_JOB ? { ...j, conclusion: 'cancelled' } : j)]) {
    const f = apiFixture(input); f.lists[1] = mutate(f.lists[1]); f.lists[3] = mutate(f.lists[3]);
    assert.throws(() => gate(input, f.api, f.list));
  }
});
test('source leaving main and attempt reruns racing qualification fail closed', () => {
  const input = inputs(env());
  const f = apiFixture(input); f.ancestry.status = 'diverged'; assert.throws(() => gate(input, f.api, f.list));
  const g = apiFixture(input); let seen = 0;
  const api = path => { const result = g.api(path); if (path.endsWith('/runs/1') && ++seen === 2) result.run_attempt++; return result; };
  assert.throws(() => gate(input, api, g.list));
});


for (const environment of ['staging', 'production']) {
  test(`${environment}: digest-bound build custody before and after signing`, () => withBundle(({ dir, input, e, save, write }) => {
    const digest = save();
    assert.equal(check(dir, digest, input, e), digest);
    write('manifest.sigstore.json', 'synthetic signature, not authentication');
    assert.equal(check(dir, digest, input, e), digest);
    assert.throws(() => check(dir, 'f'.repeat(64), input, e));
    write('hosted/compiled/native.wasm', 'changed');
    assert.throws(() => check(dir, digest, input, e));
  }, environment));
}
for (const file of ['request.json', 'trust/manifest.json', 'hosted/compiled/.env', 'log/compiled/worker.js.map', 'escrow/compiled/extra.js']) {
  test(`unexpected transfer member refuses: ${file}`, () => withBundle(({ dir, write, input, e, save }) => {
    const digest = save(); write(file, 'not a release file');
    assert.throws(() => check(dir, digest, input, e));
  }));
}
test('symlink and hardlink transfer members refuse', () => withBundle(({ dir, input, e, save }) => {
  const digest = save();
  symlinkSync(join(dir, 'hosted/compiled/worker.js'), join(dir, 'escrow/compiled/alias.js'));
  assert.throws(() => check(dir, digest, input, e));
  rmSync(join(dir, 'escrow/compiled/alias.js'));
  linkSync(join(dir, 'hosted/compiled/native.wasm'), join(dir, 'log/compiled/alias.wasm'));
  assert.throws(() => check(dir, digest, input, e));
}));
test('closed manifest cannot relabel source, publisher, tier, trust or add private request fields', () => withBundle(({ dir, manifest, save, input, e }) => {
  const original = clone(manifest);
  for (const mutate of [
    m => { m.request = {}; }, m => { m.next_source = connect; }, m => { m.environment = 'production'; },
    m => { m.publication.repository = 'other/repo'; }, m => { m.trust.verifier.source_commit = connect; },
    m => { m.qualification.log.workflow = 'other.yml'; }, m => { m.trust.ops_verifier_commit = 'f'.repeat(40); },
  ]) {
    Object.assign(manifest, clone(original)); delete manifest.request;
    mutate(manifest); const digest = save();
    assert.throws(() => check(dir, digest, input, e));
  }
}));
test('missing or changed handoff proof refuses even without signing', () => withBundle(({ dir, write, input, e, save }) => {
  const digest = save(); write('trust/release-trust-bundle.sigstore.json', 'changed');
  assert.throws(() => check(dir, digest, input, e));
}));
test('no LAB profile or runtime signer override', () => {
  for (const environment of ['lab', 'local', '', '../production']) assert.throws(() => inputs(env(environment)));
  assert.equal(IDENTITY, 'https://github.com/mdbase-dev/mdbase-connect/.github/workflows/release-workers.yml@refs/heads/main');
});
