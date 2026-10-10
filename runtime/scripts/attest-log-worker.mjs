#!/usr/bin/env node
// Main-only signer input/gate and fixed-file packager. Never rebuilds or deploys.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'mdbase-dev/mdbase-next';
export const FULL_JOBS = [
  'fast lane (fmt, clippy, arch, deny, test, spec ratchet)',
  'postgres (real-Postgres integration tests)',
  'cross-target FFI check (Windows, macOS)',
  'wasm (build, size budget, determinism)',
  'sdk (typecheck, test, build)',
  'obsidian runtime (typecheck, test, build)',
  'simulation seed sweep',
  'contracts (wire.cddl generated, golden fixtures validate)',
];
export const DO_JOB = 'logsvc DO (wasm32, local conformance, restart replay)';
export const FILES = ['index.js', 'index_bg.wasm', 'package.json', 'worker/shim.mjs', 'SHA256SUMS', 'SOURCE_REVISION', 'BUILD.json', 'wrangler.jsonc'];
const HASHED = FILES.filter((file) => file !== 'SHA256SUMS');
const SHA = /^[0-9a-f]{40}$/;
class Refusal extends Error {}
const fail = (message) => { throw new Refusal(message); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function inputs(env) {
  const source = env.SOURCE_REVISION;
  if (!SHA.test(source ?? '')) fail('source revision must be full lowercase SHA');
  const positive = (key) => {
    if (!/^[1-9][0-9]*$/.test(env[key] ?? '')) fail(`${key} must be positive integer`);
    const number = Number(env[key]);
    if (!Number.isSafeInteger(number)) fail(`${key} is out of range`);
    return number;
  };
  return {
    source, producerId: positive('LOG_RUN_ID'), producerAttempt: positive('LOG_RUN_ATTEMPT'),
    ciId: positive('CI_RUN_ID'), ciAttempt: positive('CI_RUN_ATTEMPT'),
  };
}

export function verifyRun(run, expected, workflow) {
  if (run.id !== expected.id || run.run_attempt !== expected.attempt
      || run.head_sha !== expected.source || run.head_branch !== 'main'
      || run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== REPOSITORY || run.repository?.private !== true
      || run.actor?.login !== 'callumalpass' || run.triggering_actor?.login !== 'callumalpass'
      || ![`.github/workflows/${workflow}`, `.github/workflows/${workflow}@refs/heads/main`].includes(run.path)) {
    fail('exact successful main push workflow identity required');
  }
}

export function verifyJobs(jobs, required) {
  for (const name of required) {
    const found = jobs.filter((job) => job.name === name);
    if (found.length !== 1 || found[0].status !== 'completed' || found[0].conclusion !== 'success') {
      fail('full exact-commit checks must pass; skips and duplicate identities refused');
    }
  }
}

export function selectArtifact(artifacts, input) {
  const name = `logsvc-do-worker-${input.producerId}-${input.producerAttempt}`;
  const found = artifacts.filter((artifact) => artifact.name === name);
  if (found.length !== 1 || found[0].expired !== false || !Number.isSafeInteger(found[0].id) || found[0].id <= 0) {
    fail('one unexpired exact producer-attempt artifact required');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(found[0].digest ?? '')
      || !Number.isSafeInteger(found[0].size_in_bytes) || found[0].size_in_bytes <= 0
      || found[0].size_in_bytes > 128 * 1024 * 1024
      || found[0].workflow_run?.id !== input.producerId || found[0].workflow_run?.head_sha !== input.source) {
    fail('artifact producer/source identity mismatch');
  }
  return found[0];
}

function gh(path) {
  // No caller URL, shell interpolation or raw remote error output.
  let text;
  try { text = execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe' }); }
  catch { fail('GitHub identity observation failed'); }
  try { return JSON.parse(text); } catch { fail('invalid GitHub identity response'); }
}
function pages(path, key) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(result[key])) fail('invalid paginated identity response');
    items.push(...result[key]);
    if (result[key].length < 100) return items;
  }
  fail('identity pagination limit reached');
}
export function gate(input, api = gh, list = pages) {
  verifyRun(api(`repos/${REPOSITORY}/actions/runs/${input.producerId}`),
    { id: input.producerId, attempt: input.producerAttempt, source: input.source }, 'logsvc-do.yml');
  verifyRun(api(`repos/${REPOSITORY}/actions/runs/${input.ciId}`),
    { id: input.ciId, attempt: input.ciAttempt, source: input.source }, 'ci.yml');
  verifyJobs(list(`repos/${REPOSITORY}/actions/runs/${input.producerId}/attempts/${input.producerAttempt}/jobs`, 'jobs'), [DO_JOB]);
  verifyJobs(list(`repos/${REPOSITORY}/actions/runs/${input.ciId}/attempts/${input.ciAttempt}/jobs`, 'jobs'), FULL_JOBS);
  const ancestry = api(`repos/${REPOSITORY}/compare/${input.source}...main`);
  if (!['identical', 'ahead'].includes(ancestry.status) || ancestry.base_commit?.sha !== input.source) {
    fail('source is not an ancestor of current main');
  }
  const artifact = selectArtifact(list(`repos/${REPOSITORY}/actions/runs/${input.producerId}/artifacts`, 'artifacts'), input);
  // Refuse a rerun that started while the attempt-specific evidence was read.
  verifyRun(api(`repos/${REPOSITORY}/actions/runs/${input.producerId}`),
    { id: input.producerId, attempt: input.producerAttempt, source: input.source }, 'logsvc-do.yml');
  verifyRun(api(`repos/${REPOSITORY}/actions/runs/${input.ciId}`),
    { id: input.ciId, attempt: input.ciAttempt, source: input.source }, 'ci.yml');
  return artifact;
}

function regularFile(root, relative) {
  let current = root;
  const components = relative.split('/');
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (i < components.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      fail('bundle contains a link or non-regular path');
    }
    if (i === components.length - 1 && (stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)) {
      fail('bundle file is hardlinked or oversized');
    }
  }
  return readFileSync(current);
}
function inventory(root, prefix = '') {
  const found = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) fail('bundle symlink refused');
    if (stat.isDirectory()) {
      if (relative !== 'worker') fail('unexpected bundle directory');
      found.push(...inventory(root, relative));
    } else {
      if (!stat.isFile()) fail('bundle special file refused');
      found.push(relative);
    }
  }
  return found.sort();
}
export function checkedFiles(root, input) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('bundle root must be a directory');
  if (JSON.stringify(inventory(root)) !== JSON.stringify([...FILES].sort())) fail('unexpected/missing bundle files');
  const bytes = Object.fromEntries(FILES.map((file) => [file, regularFile(root, file)]));
  if (bytes.SOURCE_REVISION.toString('utf8') !== `${input.source}\n`) fail('bundle source mismatch');
  if (bytes['BUILD.json'].length > 16384 || bytes.SHA256SUMS.length > 4096) fail('oversized producer metadata');
  const text = bytes['BUILD.json'].toString('utf8');
  let build;
  try { build = JSON.parse(text); } catch { fail('invalid build receipt JSON'); }
  // This flat receipt has only fixed scalar fields. Count decoded keys as well
  // as parsed keys so duplicate/escaped-duplicate JSON fields cannot hide.
  const keys = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map((match) => JSON.parse(match[1]));
  const expectedKeys = ['schema', 'repository', 'workflow', 'source_revision', 'run_id', 'run_attempt'];
  if (!build || Array.isArray(build) || keys.length !== expectedKeys.length || new Set(keys).size !== keys.length
      || !expectedKeys.every((key) => keys.includes(key))) fail('unexpected or duplicate build fields');
  if (build.schema !== 'mdbase-next-log-worker-build/1' || build.repository !== REPOSITORY
      || build.workflow !== 'logsvc-do.yml' || build.source_revision !== input.source
      || build.run_id !== input.producerId || build.run_attempt !== input.producerAttempt) fail('build receipt mismatch');
  const sums = bytes.SHA256SUMS.toString('utf8').trimEnd().split('\n');
  if (sums.length !== HASHED.length) fail('checksum inventory mismatch');
  const seen = new Set();
  for (const line of sums) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || !HASHED.includes(match[2]) || seen.has(match[2]) || sha256(bytes[match[2]]) !== match[1]) {
      fail('invalid, duplicate or mismatched Worker checksum');
    }
    seen.add(match[2]);
  }
  return bytes;
}
export function pack(root, output, template, input, signer, artifact) {
  const bytes = checkedFiles(root, input);
  selectArtifact([artifact], input);
  if (!bytes['wrangler.jsonc'].equals(template)) fail('template does not equal exact source Git bytes');
  if (!SHA.test(signer.source) || !Number.isSafeInteger(signer.id) || signer.id <= 0
      || !Number.isSafeInteger(signer.attempt) || signer.attempt <= 0) fail('invalid signer identity');
  if (!Buffer.isBuffer(template) || template.length === 0 || template.length > 1024 * 1024) fail('invalid template');
  mkdirSync(output, { mode: 0o700 }); // Refuse existing output instead of overwriting.
  const stage = join(output, 'stage/deploy/cloudflare-do');
  mkdirSync(join(stage, 'build/worker'), { recursive: true, mode: 0o700 });
  for (const [file, content] of Object.entries(bytes)) {
    if (file !== 'wrangler.jsonc') writeFileSync(join(stage, 'build', file), content, { mode: 0o600, flag: 'wx' });
  }
  writeFileSync(join(stage, 'wrangler.jsonc'), template, { mode: 0o600, flag: 'wx' });
  const archiveName = 'logsvc-do-worker.tar.gz';
  const tar = execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-C', join(output, 'stage'), '-cf', '-', 'deploy/cloudflare-do'],
    { maxBuffer: 128 * 1024 * 1024, stdio: 'pipe', env: { ...process.env, TAR_OPTIONS: '' } });
  const archive = execFileSync('gzip', ['-n'], { input: tar, maxBuffer: 128 * 1024 * 1024, stdio: 'pipe', env: { ...process.env, GZIP: '' } });
  writeFileSync(join(output, archiveName), archive, { mode: 0o600, flag: 'wx' });
  const manifest = {
    schema: 'mdbase-next-log-worker/1', repository: REPOSITORY, source_revision: input.source,
    archive: { name: archiveName, sha256: sha256(archive) },
    producer: { workflow: 'logsvc-do.yml', run_id: input.producerId, run_attempt: input.producerAttempt,
      artifact_name: `logsvc-do-worker-${input.producerId}-${input.producerAttempt}`, artifact_sha256: artifact.digest.slice(7) },
    qualification: { workflow: 'ci.yml', run_id: input.ciId, run_attempt: input.ciAttempt },
    signer: { workflow: 'sign-log-worker.yml', source_revision: signer.source, run_id: signer.id, run_attempt: signer.attempt },
  };
  writeFileSync(join(output, 'bundle.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
  return manifest;
}

function main() {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main'
      || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') fail('main-only explicit signer dispatch required');
  const input = inputs(process.env);
  const artifact = gate(input);
  if (process.argv[2] === 'verify') {
    if (!process.env.GITHUB_OUTPUT) fail('workflow output path missing');
    writeFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${artifact.id}\nartifact_name=${artifact.name}\n`, { flag: 'a' });
  } else if (process.argv[2] === 'download' && process.argv.length === 4) {
    let zip;
    try { zip = execFileSync('gh', ['api', `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
      { timeout: 120000, maxBuffer: 128 * 1024 * 1024, stdio: 'pipe' }); }
    catch { fail('exact artifact download failed'); }
    if (`sha256:${sha256(zip)}` !== artifact.digest) fail('downloaded artifact digest mismatch');
    const output = resolve(process.argv[3]);
    mkdirSync(output, { mode: 0o700 });
    const zipPath = join(output, 'producer.zip');
    writeFileSync(zipPath, zip, { mode: 0o600, flag: 'wx' });
    execFileSync('python3', ['scripts/extract-log-worker.py', zipPath, join(output, 'files')], { stdio: 'pipe' });
  } else if (process.argv[2] === 'pack' && process.argv.length === 5) {
    let template;
    try { template = execFileSync('git', ['show', `${input.source}:deploy/cloudflare-do/wrangler.jsonc`], { maxBuffer: 1024 * 1024, stdio: 'pipe' }); }
    catch { fail('exact source template unavailable'); }
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (source !== process.env.GITHUB_SHA) fail('signer checkout/source mismatch');
    pack(resolve(process.argv[3]), resolve(process.argv[4]), template, input,
      { source, id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) }, artifact);
  } else fail('usage: attest-log-worker.mjs verify|download DIR|pack ARTIFACT_DIR OUTPUT_DIR');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Worker attestation refused: ${error instanceof Refusal ? error.message : 'invalid artifact or local precondition'}`);
    process.exitCode = 1;
  }
}
