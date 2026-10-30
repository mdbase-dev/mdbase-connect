import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_WORKFLOW, REPOSITORY, check, fileInventory, gate, gh, inputs, pages,
  publisher, readReleaseBuild, regular, root, sha256 } from './release-workers.mjs';

const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const positive = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function buildReceipt(env, api = gh, list = pages) {
  requireThat(['staging', 'production'].includes(env.RELEASE_ENVIRONMENT)
    && /^[0-9a-f]{40}$/.test(env.SOURCE_REVISION ?? '')
    && positive(env.BUILD_RUN_ID) && positive(env.BUILD_RUN_ATTEMPT), 'exact source and build attempt required');
  publisher(env, { environment: env.RELEASE_ENVIRONMENT, source: env.SOURCE_REVISION });
  const run = api(`repos/${REPOSITORY}/actions/runs/${env.BUILD_RUN_ID}`);
  requireThat(run.id === Number(env.BUILD_RUN_ID) && run.run_attempt === Number(env.BUILD_RUN_ATTEMPT)
    && run.repository?.full_name === REPOSITORY && run.repository?.private === false
    && run.path === `.github/workflows/${BUILD_WORKFLOW}` && run.event === 'workflow_run'
    && run.head_branch === 'main' && /^[0-9a-f]{40}$/.test(run.head_sha ?? '')
    && run.status === 'completed' && run.conclusion === 'success', 'successful protected-main build required');
  const ancestry = api(`repos/${REPOSITORY}/compare/${run.head_sha}...main`);
  requireThat(['identical', 'ahead'].includes(ancestry.status) && ancestry.base_commit?.sha === run.head_sha,
    'builder must remain on reviewed main');
  const name = `unsigned-${env.RELEASE_ENVIRONMENT}-workers-${env.SOURCE_REVISION}-${run.id}-${run.run_attempt}`;
  const artifacts = list(`repos/${REPOSITORY}/actions/runs/${run.id}/artifacts`, 'artifacts').filter(value => value.name === name);
  requireThat(artifacts.length === 1, 'one exact immutable build artifact required');
  const artifact = artifacts[0];
  requireThat(typeof artifact.id === 'number' && positive(artifact.id) && artifact.expired === false
    && /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')
    && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha,
    'unexpired digest-bound build artifact required');
  return { workflow: BUILD_WORKFLOW, run_id: run.id, run_attempt: run.run_attempt,
    publisher_commit: run.head_sha, artifact_id: artifact.id, artifact_digest: artifact.digest };
}

export function selectedManifest(directory, receipt, env) {
  const raw = regular(join(directory, 'manifest.json'), 65536), manifest = JSON.parse(raw);
  requireThat(manifest.publication?.workflow === BUILD_WORKFLOW
    && same(manifest.publication, { repository: REPOSITORY, workflow: BUILD_WORKFLOW,
      run_id: receipt.run_id, run_attempt: receipt.run_attempt, publisher_commit: receipt.publisher_commit }),
    'build manifest/run identity mismatch');
  const trust = readReleaseBuild(join(directory, `trust/next-trust/${env.RELEASE_ENVIRONMENT}-context.json`),
    join(directory, 'trust/build-receipt.json'));
  const input = inputs({ RELEASE_ENVIRONMENT: env.RELEASE_ENVIRONMENT, SOURCE_REVISION: env.SOURCE_REVISION,
    CI_RUN_ID: String(manifest.qualification?.ci?.run_id), CI_RUN_ATTEMPT: String(manifest.qualification?.ci?.run_attempt),
    LOG_RUN_ID: String(manifest.qualification?.log?.run_id), LOG_RUN_ATTEMPT: String(manifest.qualification?.log?.run_attempt),
    TRUST_RELEASE: JSON.stringify({ source_commit: trust.sourceCommit, image_run: trust.provenance.image_publication.run_id,
      trust_run: trust.provenance.trust_publication.run_id, publisher_commit: trust.provenance.trust_publication.publisher_commit,
      asset_sha256: trust.sha256 }) });
  check(directory, sha256(raw), input, { ...env, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_SHA: receipt.publisher_commit,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/${BUILD_WORKFLOW}@refs/heads/main`,
    GITHUB_RUN_ID: String(receipt.run_id), GITHUB_RUN_ATTEMPT: String(receipt.run_attempt) });
  return { input, manifest: { ...manifest, schema: `mdbase-${input.environment}-next-stack/2`,
    publication: publisher(env, input),
    qualification: { ...manifest.qualification, build: { ...receipt, manifest_sha256: sha256(raw) } } } };
}

function main() {
  const env = process.env, receipt = buildReceipt(env);
  const base = join(root, `runtime/target/${env.RELEASE_ENVIRONMENT}-worker-release`);
  const unsigned = join(base, 'unsigned'), bundle = join(base, 'bundle');
  if (process.argv[2] === 'prepare') {
    mkdirSync(base, { recursive: true });
    const archive = execFileSync('gh', ['api', `repos/${REPOSITORY}/actions/artifacts/${receipt.artifact_id}/zip`],
      { timeout: 60000, maxBuffer: 160 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    requireThat(`sha256:${sha256(archive)}` === receipt.artifact_digest, 'GitHub artifact archive digest mismatch');
    const path = join(base, 'build.zip');
    writeFileSync(path, archive, { flag: 'wx' });
    execFileSync('python3', ['-I', '-B', join(root, 'scripts/unpack-worker-build.py'), path, unsigned], { stdio: 'pipe' });
  } else requireThat(process.argv[2] === 'check', 'one fixed selection operation required');
  const { input, manifest } = selectedManifest(unsigned, receipt, env);
  gate(input);
  const expected = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (process.argv[2] === 'prepare') {
    cpSync(unsigned, bundle, { recursive: true, errorOnExist: true, force: false });
    writeFileSync(join(bundle, 'manifest.json'), expected);
  }
  requireThat(regular(join(bundle, 'manifest.json'), 65536).equals(expected)
    && same(fileInventory(bundle, input.environment), manifest.files), 'selected bytes changed');
  requireThat(same(buildReceipt(env), receipt), 'build rerun or artifact changed during selection');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Worker selection refused: ${error.message}`); process.exitCode = 1; }
}
