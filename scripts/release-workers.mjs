#!/usr/bin/env node
// Exact-main Worker source qualification and immutable build-job byte custody.
// Private managed assembly/configuration stays in ops. No compilation, signing,
// provider credentials, deployment or caller-selected paths live here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseBuild } from '../runtime/scripts/lib/read-release-trust.mjs';
export { readReleaseBuild };
export const REPOSITORY = 'mdbase-dev/mdbase-connect';
export const WORKFLOW = 'release-workers.yml';
export const CI_WORKFLOW = 'runtime-ci.yml';
export const IDENTITY = 'https://github.com/mdbase-dev/mdbase-connect/.github/workflows/release-workers.yml@refs/heads/main';
export const OPS_VERIFIER_COMMIT = 'eaaab7cafd6d58af18bbb4f316dbe349392c5cdb';
export const DO_JOB = 'logsvc DO (wasm32, local conformance, restart replay)';
export const CI_JOBS = Object.freeze(['wasm (build, size budget, determinism)', 'sdk execution',
  'obsidian runtime execution', 'Hosted worker', DO_JOB]);
export const ROLES = Object.freeze(['log', 'hosted', 'escrow']);
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[0-9a-f]{40}$/, HASH = /^[0-9a-f]{64}$/;
const fail = message => { throw new Error(message); };
const requireThat = (ok, message) => { if (!ok) fail(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && same(Object.keys(v).sort(), [...keys].sort());
const integer = v => Number.isSafeInteger(v) && v > 0;
function positive(value) {
  requireThat(/^[1-9][0-9]*$/.test(value ?? '') && integer(Number(value)), 'positive safe run identity required');
  return Number(value);
}
export function verifyRun(run, expected, workflow) {
  if (run.id !== expected.id || run.run_attempt !== expected.attempt
      || run.head_sha !== expected.source || run.head_branch !== 'main'
      || !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== REPOSITORY || run.repository?.private !== false
      || run.actor?.login !== 'callumalpass' || run.triggering_actor?.login !== 'callumalpass'
      || run.path !== `.github/workflows/${workflow}`) {
    fail('exact successful main push or dispatch workflow identity required');
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

export function gh(path) {
  // No caller URL, shell interpolation or raw remote error output.
  let text;
  try { text = execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe' }); }
  catch { fail('GitHub identity observation failed'); }
  try { return JSON.parse(text); } catch { fail('invalid GitHub identity response'); }
}
export function pages(path, key) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const result = gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(result[key])) fail('invalid paginated identity response');
    items.push(...result[key]);
    if (result[key].length < 100) return items;
  }
  fail('identity pagination limit reached');
}

export function inputs(env) {
  const environment = env.RELEASE_ENVIRONMENT === undefined ? 'staging' : env.RELEASE_ENVIRONMENT;
  requireThat(['staging', 'production'].includes(environment), 'fixed managed tier required');
  requireThat(SHA.test(env.SOURCE_REVISION ?? ''), 'full source SHA required');
  requireThat(typeof env.TRUST_RELEASE === 'string' && env.TRUST_RELEASE.length <= 4096, 'public trust release required');
  const trust = JSON.parse(env.TRUST_RELEASE);
  // The request is five scalars; reject duplicate/escaped-duplicate keys too.
  const keys = [...env.TRUST_RELEASE.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(match => JSON.parse(match[1]));
  requireThat(keys.length === 5 && new Set(keys).size === 5, 'duplicate trust release field refused');
  requireThat(exact(trust, ['source_commit', 'image_run', 'trust_run', 'publisher_commit', 'asset_sha256'])
    && typeof trust.source_commit === 'string' && SHA.test(trust.source_commit)
    && typeof trust.publisher_commit === 'string' && SHA.test(trust.publisher_commit)
    && typeof trust.asset_sha256 === 'string' && HASH.test(trust.asset_sha256)
    && integer(trust.image_run) && integer(trust.trust_run), 'closed public trust release required');
  return { environment, source: env.SOURCE_REVISION, ciId: positive(env.CI_RUN_ID), ciAttempt: positive(env.CI_RUN_ATTEMPT),
    logId: positive(env.LOG_RUN_ID), logAttempt: positive(env.LOG_RUN_ATTEMPT), trust };
}
export function publisher(env, input) {
  requireThat(input.environment === (env.RELEASE_ENVIRONMENT ?? 'staging')
    && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_REF_PROTECTED === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_ACTOR === 'callumalpass' && env.GITHUB_TRIGGERING_ACTOR === 'callumalpass'
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/${WORKFLOW}@refs/heads/main`
    && env.GITHUB_SHA === input.source, 'exact protected-main owner dispatch/source required');
  return { repository: REPOSITORY, workflow: WORKFLOW, run_id: positive(env.GITHUB_RUN_ID),
    run_attempt: positive(env.GITHUB_RUN_ATTEMPT), publisher_commit: input.source };
}
export function gate(input, api = gh, list = pages) {
  const ci = () => {
    const run = api(`repos/${REPOSITORY}/actions/runs/${input.ciId}`);
    verifyRun(run, { id: input.ciId, attempt: input.ciAttempt, source: input.source }, CI_WORKFLOW);
    // Main owner dispatches use the same mandatory execution-job gate below.
    requireThat(['push', 'workflow_dispatch'].includes(run.event), 'full source CI must be a main push or dispatch');
  };
  const log = () => verifyRun(api(`repos/${REPOSITORY}/actions/runs/${input.logId}`),
    { id: input.logId, attempt: input.logAttempt, source: input.source }, CI_WORKFLOW);
  ci(); log();
  verifyJobs(list(`repos/${REPOSITORY}/actions/runs/${input.ciId}/attempts/${input.ciAttempt}/jobs`, 'jobs'), CI_JOBS);
  verifyJobs(list(`repos/${REPOSITORY}/actions/runs/${input.logId}/attempts/${input.logAttempt}/jobs`, 'jobs'), [DO_JOB]);
  const ancestry = api(`repos/${REPOSITORY}/compare/${input.source}...main`);
  requireThat(['identical', 'ahead'].includes(ancestry.status) && ancestry.base_commit?.sha === input.source,
    'source must remain on reviewed main');
  ci(); log(); // Refuse an attempt rerun racing the qualification observations.
}

export function trustFiles(environment) {
  requireThat(['staging', 'production'].includes(environment), 'fixed managed tier required');
  return ['release-trust-bundle.json', 'release-trust-bundle.sigstore.json', 'image-release-bundle.json',
    'image-release-bundle.sigstore.json', `next-trust/${environment}.json`,
    `next-trust/${environment}-context.json`, 'build-receipt.json'];
}
export function regular(path, limit = 64 * 1024 * 1024) {
  const info = lstatSync(path);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit, 'bounded regular unaliased file required');
  return readFileSync(path);
}
export function allowedFile(path, environment) {
  if (trustFiles(environment).some(name => path === `trust/${name}`)) return true;
  return ROLES.some(role => path === `${role}/wrangler.json`
    || new RegExp(`^${role}/compiled/[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.(?:js|mjs|wasm)$`).test(path));
}
// Byte custody only. The pinned private builder separately enforces its fixed
// managed configuration before emitting the build-job digest. This checker
// never executes a downloaded bundle or substitutes for trust authentication.
export function fileInventory(directory, environment = 'staging') {
  const files = {}; let total = 0;
  const walk = (prefix = '') => {
    const here = join(directory, prefix), info = lstatSync(here);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'unaliased bundle directory required');
    for (const name of readdirSync(here).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, path = join(directory, relative), stat = lstatSync(path);
      if (stat.isDirectory()) {
        requireThat(['trust', 'trust/next-trust', ...ROLES.flatMap(role => [role, `${role}/compiled`])].includes(relative), 'unexpected bundle directory');
        walk(relative);
      } else {
        requireThat(!stat.isSymbolicLink(), 'bundle symlink refused');
        if (['manifest.json', 'manifest.sigstore.json'].includes(relative)) { regular(path, 1024 * 1024); continue; }
        requireThat(allowedFile(relative, environment), 'unexpected publication file');
        const bytes = regular(path, relative.startsWith('trust/') || relative.endsWith('/wrangler.json') ? 65536 : 64 * 1024 * 1024);
        total += bytes.length;
        requireThat(bytes.length > 0, 'empty publication file refused');
        if (relative.endsWith('.wasm')) requireThat(bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), 'native WASM header required');
        files[relative] = { sha256: sha256(bytes), size: bytes.length };
        requireThat(Object.keys(files).length <= 64 && total <= 128 * 1024 * 1024, 'bounded publication required');
      }
    }
  };
  walk();
  for (const name of trustFiles(environment)) requireThat(Object.hasOwn(files, `trust/${name}`), 'public trust proof missing');
  for (const role of ROLES) {
    requireThat(Object.hasOwn(files, `${role}/wrangler.json`), 'frozen config missing');
    const js = Object.keys(files).filter(name => name.startsWith(`${role}/compiled/`) && /\.(js|mjs)$/.test(name));
    requireThat(js.length === 1 && Object.keys(files).some(name => name.startsWith(`${role}/compiled/`) && name.endsWith('.wasm')), 'one entry and native WASM per Worker required');
  }
  return files;
}
// expectedSha256 MUST be the successful build job's output, never a dispatch
// input. Exact digest custody carries the private builder's already-checked
// profile without publishing its assembly implementation into this repository.
export function check(directory, expectedSha256, input, env) {
  const raw = regular(join(directory, 'manifest.json'), 65536);
  requireThat(HASH.test(expectedSha256 ?? '') && sha256(raw) === expectedSha256, 'build-job manifest digest mismatch');
  const m = JSON.parse(raw), files = fileInventory(directory, input.environment);
  requireThat(exact(m, ['schema', 'environment', 'account_id', 'next_source', 'origins', 'cp_origin',
    'wrangler_version', 'cors_origins', 'initial_kms_collections', 'publication', 'qualification', 'trust', 'files'])
    && m.schema === `mdbase-${input.environment}-next-stack/1` && m.environment === input.environment
    && /^[0-9a-f]{32}$/.test(m.account_id) && m.next_source === input.source
    && same(m.publication, publisher(env, input)) && same(m.files, files)
    && m.wrangler_version === '4.147.0' && same(m.cors_origins, []) && m.initial_kms_collections === 'all'
    && same(m.qualification, { ci: { workflow: CI_WORKFLOW, run_id: input.ciId, run_attempt: input.ciAttempt },
      log: { workflow: CI_WORKFLOW, run_id: input.logId, run_attempt: input.logAttempt } }), 'closed build publication mismatch');
  const trust = readReleaseBuild(join(directory, `trust/next-trust/${input.environment}-context.json`), join(directory, 'trust/build-receipt.json'));
  const asset = regular(trust.asset, 65536);
  requireThat(trust.environment === input.environment && trust.sourceCommit === input.trust.source_commit
    && trust.sha256 === input.trust.asset_sha256 && trust.assetBytes === asset.length && trust.sha256 === sha256(asset)
    && trust.provenance.trust_publication.run_id === input.trust.trust_run
    && trust.provenance.trust_publication.publisher_commit === input.trust.publisher_commit
    && trust.provenance.image_publication.run_id === input.trust.image_run && trust.verifierSourceCommit === input.source
    && exact(m.origins, ROLES) && m.origins.log === trust.logOrigin && m.cp_origin === trust.cpOrigin
    && ROLES.every(role => { try { const u = new URL(m.origins[role]); return u.protocol === 'https:' && u.origin === m.origins[role]; } catch { return false; } })
    && same(m.trust, { asset_sha256: trust.sha256, asset_size: trust.assetBytes,
      source: { repository: REPOSITORY, commit: trust.sourceCommit, version: trust.sourceVersion },
      context_sha256: trust.contextSha256, receipt_sha256: trust.receiptSha256,
      verifier: { source_commit: trust.verifierSourceCommit, sha256: trust.verifierSha256 },
      ops_verifier_commit: OPS_VERIFIER_COMMIT }), 'build trust custody mismatch');
  return sha256(raw);
}
function main() {
  const env = process.env, input = inputs(env);
  publisher(env, input);
  requireThat(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim() === input.source, 'checkout must equal dispatch source');
  execFileSync('git', ['diff', '--exit-code', 'HEAD'], { cwd: root, stdio: 'pipe' });
  gate(input);
  requireThat(process.argv.length === 3, 'one fixed workflow operation required');
  if (process.argv[2] === 'check') check(join(root, `runtime/target/${input.environment}-worker-release/bundle`), env.EXPECTED_MANIFEST_SHA256, input, env);
  else requireThat(process.argv[2] === 'verify', 'unknown workflow operation');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('Managed Worker publication refused: source, qualification, authenticated trust or frozen inventory mismatch'); process.exitCode = 1; }
}
