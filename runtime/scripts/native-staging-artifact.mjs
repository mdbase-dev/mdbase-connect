#!/usr/bin/env node
// Release-pipeline custody for the native staging daemon (`--features staging`),
// NOT an alternate verifier. The daemon embeds the reviewed in-repo staging asset
// and verifies it with the compiled-in mdbn-trust; this binds one built artifact
// to its exact clean source and to the completed Ops `release staging
// verify-trust` output for that same asset. No network, signing or runtime input.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrustHandoff } from './lib/read-release-trust.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, why) => { if (!ok) throw new Error(`Native staging artifact refused: ${why}`); };
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
const repository = 'mdbase-dev/mdbase-connect';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The one supported build, run in `runtime/` at the recorded commit. As for the
 * SDK publication, Rust and C paths are remapped so the bytes do not depend on
 * where the checkout or Cargo home lives; the pinned toolchain, the host C
 * toolchain and the builder's own Cargo configuration still do. The remaps are
 * `--config` arguments (not environment) so a remote cargo runner can apply them. */
export const BUILD = Object.freeze({
  directory: 'runtime',
  command: 'cargo build --locked --release -p mdbn-daemon --bin mdbase --features staging',
  config: Object.freeze([
    'target.x86_64-unknown-linux-gnu.rustflags=["--remap-path-prefix=<checkout>=/source","--remap-path-prefix=<cargo home>=/cargo"]',
    'env.CFLAGS="-ffile-prefix-map=<checkout>=/source -ffile-prefix-map=<cargo home>=/cargo"',
  ]),
  target: 'x86_64-unknown-linux-gnu',
});
/** BUILD's cargo arguments for a checkout and Cargo home, as cargo sees them. */
export const cargoArgs = (checkout, cargoHome) => [...BUILD.command.split(' ').slice(1),
  ...BUILD.config.flatMap(c => ['--config', c.replaceAll('<checkout>', checkout).replaceAll('<cargo home>', cargoHome)])];
// The unchanged verify-trust output: five signed/proof files plus its context.
const HANDOFF = ['image-release-bundle.json', 'image-release-bundle.sigstore.json',
  'next-trust/staging-context.json', 'next-trust/staging.json',
  'release-trust-bundle.json', 'release-trust-bundle.sigstore.json'];

function committed(repo, commit) {
  const show = file => execFileSync('git', ['-C', repo, 'show', `${commit}:${file}`], { maxBuffer: 1 << 26 });
  const pins = JSON.parse(show('config/release-components.json')).sdkPublication.environments.staging;
  const asset = show('config/next-trust/staging.json');
  need(sha(asset) === pins.sha256 && asset.length === pins.bytes, 'staging asset is not its reviewed pin');
  return { show, pins, asset, others: ['production', 'lab'].map(name => show(`config/next-trust/${name}.json`)) };
}

function listing(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return listing(path.join(directory, entry.name), `${name}/`);
    need(entry.isFile(), `${name} is not a regular file`);
    return [name];
  }).sort();
}

/** Built-byte verification: an x86-64 ELF embedding exactly the reviewed staging
 * asset and no other environment's asset. */
function builtBytes(binary, source) {
  const info = lstatSync(binary);
  need(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'artifact must be a regular file');
  const bytes = readFileSync(binary);
  need(bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && bytes.readUInt16LE(18) === 0x3e,
    `artifact is not an ${BUILD.target} executable`);
  need(bytes.includes(source.asset), 'artifact does not embed the staging trust asset');
  need(!source.others.some(other => bytes.includes(other)), 'artifact embeds another environment\'s trust asset');
  return { bytes: bytes.length, sha256: sha(bytes) };
}

/** Run BUILD with local cargo in this clean checkout and copy the daemon to
 * `output` (create-only). Environment flags, which would replace BUILD's remaps,
 * are dropped. */
export function buildStagingArtifact({ output, repo = root }) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  need(git('status', '--porcelain', '--untracked-files=all') === '', 'source checkout is not clean');
  const checkout = git('rev-parse', '--show-toplevel');
  const env = { ...process.env };
  for (const name of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CFLAGS']) delete env[name];
  execFileSync('cargo', cargoArgs(checkout, path.resolve(env.CARGO_HOME ?? path.join(homedir(), '.cargo'))),
    { cwd: path.join(checkout, BUILD.directory), env, stdio: 'inherit' });
  copyFileSync(path.join(checkout, BUILD.directory, 'target/release/mdbase'), output, constants.COPYFILE_EXCL);
  return { commit: git('rev-parse', 'HEAD'), artifact_sha256: sha(readFileSync(output)) };
}

/** Bind a staging daemon built by BUILD from this clean checkout to the Ops
 * handoff for its embedded asset. Writes the receipt create-only. */
export function recordStagingArtifact({ handoff, binary, receipt, repo = root }) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  need(git('status', '--porcelain', '--untracked-files=all') === '', 'source checkout is not clean');
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const source = committed(repo, commit);
  let names;
  try { names = listing(handoff); } catch (error) { need(false, `handoff unreadable (${error.message})`); }
  need(names.join() === HANDOFF.join(), 'handoff is not one complete staging verify-trust output');
  let trust;
  try { trust = readTrustHandoff(path.join(handoff, 'next-trust/staging-context.json')); } catch { need(false, 'handoff custody check failed'); }
  const { pins } = source;
  need(trust.environment === 'staging' && trust.cpOrigin === pins.cpOrigin && trust.logOrigin === pins.logOrigin
    && trust.sha256 === pins.sha256 && trust.assetBytes === pins.bytes
    && trust.sourceCommit === pins.sourceCommit && trust.sourceVersion === pins.sourceVersion,
    'handoff context is not the reviewed staging pin');
  need(readFileSync(trust.asset).equals(source.asset), 'handoff asset is not the embedded asset');
  const value = sorted({
    schema: 'mdbase-native-staging-artifact/1',
    source: { repository, commit, tree,
      cargo_lock_sha256: sha(source.show('runtime/Cargo.lock')),
      toolchain_sha256: sha(source.show('runtime/rust-toolchain.toml')) },
    build: BUILD,
    trust: { environment: 'staging', control_plane_origin: trust.cpOrigin, log_origin: trust.logOrigin,
      asset_path: 'config/next-trust/staging.json', asset_length: trust.assetBytes, asset_sha256: trust.sha256,
      source: { repository, commit: trust.sourceCommit, version: trust.sourceVersion },
      handoff: { context_sha256: trust.contextSha256, proof_sha256: trust.provenance.proof_sha256,
        image_publication: trust.provenance.image_publication,
        trust_publication: trust.provenance.trust_publication,
        publisher_qualification: trust.provenance.publisher_qualification } },
    artifact: builtBytes(binary, source),
  });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(receipt, bytes, { flag: 'wx', mode: 0o600 });
  return { receipt_sha256: sha(bytes), artifact_sha256: value.artifact.sha256, commit };
}

/** A copied or independently rebuilt artifact must reproduce the recorded bytes. */
export function checkStagingArtifact({ receipt, binary, repo = root }) {
  const value = JSON.parse(readFileSync(receipt));
  need(value?.schema === 'mdbase-native-staging-artifact/1' && /^[0-9a-f]{40}$/.test(value.source?.commit ?? ''),
    'not a native staging artifact receipt');
  const source = committed(repo, value.source.commit);
  need(value.trust?.asset_sha256 === source.pins.sha256, 'receipt trust is not its commit\'s staging pin');
  const built = builtBytes(binary, source);
  need(built.sha256 === value.artifact?.sha256 && built.bytes === value.artifact?.bytes,
    'artifact bytes differ from the recorded build');
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'build' && args.length === 1) {
      console.log(JSON.stringify(buildStagingArtifact({ output: path.resolve(args[0]) })));
    } else if (command === 'record' && args.length === 3) {
      const [handoff, binary, receipt] = args.map(arg => path.resolve(arg));
      console.log(JSON.stringify(recordStagingArtifact({ handoff, binary, receipt })));
    } else if (command === 'check' && args.length === 2) {
      const [receipt, binary] = args.map(arg => path.resolve(arg));
      console.log(JSON.stringify(checkStagingArtifact({ receipt, binary })));
    } else {
      console.error('usage: native-staging-artifact.mjs build OUTPUT | record HANDOFF BINARY RECEIPT | check RECEIPT BINARY');
      process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
