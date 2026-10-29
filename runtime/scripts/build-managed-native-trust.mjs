#!/usr/bin/env node
// Release-pipeline only. Consume the ONE completed Ops handoff, never a CP reply
// or self-derived context. No signing, network, private keys or runtime overrides.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseBuild } from './lib/read-release-trust.mjs';
import { buildAppTrust } from '../packages/sdk/scripts/build-app-trust.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = ok => { if (!ok) throw new Error('Managed native trust build refused'); };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function checked(file, digest, size) {
  const bytes = readFileSync(file);
  need(sha(bytes) === digest && (size === undefined || bytes.length === size));
  return bytes;
}
function rustContext(context) {
  const values = { ENVIRONMENT: context.environment, SHA256: context.sha256, CP_ORIGIN: context.cpOrigin,
    LOG_ORIGIN: context.logOrigin, SOURCE_COMMIT: context.sourceCommit, SOURCE_VERSION: context.sourceVersion };
  return '// PUBLIC authenticated compile-time inputs; not runtime configuration.\n' +
    Object.entries(values).map(([k, v]) => `pub const ${k}: &str = ${JSON.stringify(v)};`).join('\n') + '\n';
}
/** Post-authentication/source-review custody check, NOT an alternate verifier. */
export function checkManagedNativeTrust({ environment, outputDirectory }) {
  need(['staging', 'production'].includes(environment));
  const directory = path.join(outputDirectory, environment);
  const context = readReleaseBuild(path.join(directory, 'next-trust', `${environment}-context.json`), path.join(directory, 'build.json'));
  need(context.environment === environment && context.cpOrigin === `https://connect${environment === 'staging' ? '-staging' : ''}.mdbase.dev`);
  checked(context.asset, context.sha256, context.assetBytes);
  need(readFileSync(path.join(directory, 'context.rs'), 'utf8') === rustContext(context));
  return { environment, sha256: context.sha256, contextSha256: context.contextSha256, receiptSha256: context.receiptSha256 };
}
export function buildManagedNativeTrust({ inputFile, environment, outputDirectory }) {
  need(['staging', 'production'].includes(environment));
  const input = JSON.parse(readFileSync(inputFile));
  need(input && !Array.isArray(input) && Object.keys(input).sort().join(',') === 'context,receipt,verifier' &&
    Object.values(input).every(v => typeof v === 'string' && v.length));
  const inputs = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, path.resolve(path.dirname(inputFile), v)]));
  const context = readReleaseBuild(inputs.context, inputs.receipt);
  need(context.environment === environment && context.cpOrigin === `https://connect${environment === 'staging' ? '-staging' : ''}.mdbase.dev`);
  const asset = checked(context.asset, context.sha256, context.assetBytes);
  const verifier = checked(inputs.verifier, context.verifierSha256);
  const handoff = path.dirname(path.dirname(inputs.context));
  // Snapshot every retained byte against the completed verifier/build receipt.
  // These hashes bind custody, not an independent Sigstore authentication path.
  const files = {
    [`next-trust/${environment}.json`]: asset,
    [`next-trust/${environment}-context.json`]: checked(inputs.context, context.contextSha256),
    'build.json': checked(inputs.receipt, context.receiptSha256),
    ...Object.fromEntries(Object.entries(context.provenance.proof_sha256).map(([name, digest]) =>
      [name, checked(path.join(handoff, name), digest)])),
  };
  mkdirSync(outputDirectory, { recursive: true });
  const target = path.join(outputDirectory, environment);
  need(!existsSync(target));
  const stage = mkdtempSync(path.join(outputDirectory, '.managed-verify-'));
  try {
    // Execute only the snapshotted, source-qualified verifier bytes.
    const verifierPath = path.join(stage, 'mdbn-trust');
    const assetPath = path.join(stage, 'candidate.json');
    writeFileSync(verifierPath, verifier, { mode: 0o700, flag: 'wx' });
    writeFileSync(assetPath, asset, { flag: 'wx' });
    buildAppTrust({ ...context, verifier: verifierPath, asset: assetPath, output: path.join(stage, 'checked.mjs') });
    rmSync(verifierPath); rmSync(assetPath); rmSync(path.join(stage, 'checked.mjs'));
    files['context.rs'] = Buffer.from(rustContext(context));
    for (const [name, bytes] of Object.entries(files)) {
      const output = path.join(stage, name);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
    }
    // Reserve create-only before publication; never replace an existing input.
    mkdirSync(target, { mode: 0o700 });
    renameSync(stage, target);
    return { environment, sha256: context.sha256, contextSha256: context.contextSha256,
      receiptSha256: context.receiptSha256, verifierSourceCommit: context.verifierSourceCommit };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [first, second] = process.argv.slice(2);
    need(process.argv.length === 4 && second);
    const outputDirectory = path.join(root, 'crates/daemon/trust');
    const result = first === '--check' ? checkManagedNativeTrust({ environment: second, outputDirectory }) :
      buildManagedNativeTrust({ inputFile: path.resolve(second), environment: first, outputDirectory });
    console.log(JSON.stringify(result));
  } catch { console.error('Managed native trust generation refused.'); process.exitCode = 1; }
}
