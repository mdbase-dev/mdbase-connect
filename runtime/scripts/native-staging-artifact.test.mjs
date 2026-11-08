// Synthetic custody proofs only, NOT release authentication: the handoff wraps
// the reviewed in-repo assets with stub Sigstore files, as Ops output would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, buildStagingArtifact, cargoArgs, checkStagingArtifact, recordStagingArtifact } from './native-staging-artifact.mjs';

const hex = b => createHash('sha256').update(b).digest('hex');
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
const json = v => Buffer.from(JSON.stringify(sorted(v)));
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pins = JSON.parse(readFileSync(path.join(product, 'config/release-components.json'))).sdkPublication.environments;
const asset = name => readFileSync(path.join(product, `config/next-trust/${name}.json`));

function handoff(directory, environment, assetBytes = asset(environment)) {
  const pin = pins[environment];
  const source = { repository: 'mdbase-dev/mdbase-connect', commit: pin.sourceCommit, version: pin.sourceVersion };
  const image = json({ ...source, publication: { runId: 11, runAttempt: 1 } });
  const inventory = json({ schemaVersion: 1, kind: 'mdbase-release-trust-bundle', ...source,
    imageBundle: { path: 'image-release-bundle.json', length: image.length, sha256: hex(image), publicationRunId: 11, publicationRunAttempt: 1 },
    publication: { workflow: 'publish-images.yml', runId: 12, runAttempt: 1, publisherCommit: 'c'.repeat(40) },
    qualification: { workflow: 'server-ci.yml', runId: 13, runAttempt: 1 },
    trustAssets: [{ path: `next-trust/${environment}.json`, length: assetBytes.length, sha256: hex(assetBytes), environment,
      controlPlaneOrigin: pin.cpOrigin, logOrigin: pin.logOrigin, source }] });
  const proofs = { 'image-release-bundle.json': image, 'release-trust-bundle.json': inventory,
    'image-release-bundle.sigstore.json': Buffer.from('{"synthetic":"not-authentication"}'),
    'release-trust-bundle.sigstore.json': Buffer.from('{"synthetic":"not-authentication"}') };
  const context = json({ schema_version: 1, kind: 'mdbase-next-build-trust-context',
    context: { sha256: hex(assetBytes), environment, control_plane_origin: pin.cpOrigin, log_origin: pin.logOrigin, source },
    provenance: { asset_path: `next-trust/${environment}.json`, asset_length: assetBytes.length,
      proof_sha256: Object.fromEntries(Object.entries(proofs).map(([k, b]) => [k, hex(b)])),
      image_publication: { run_id: 11, run_attempt: 1 },
      trust_publication: { run_id: 12, run_attempt: 1, publisher_commit: 'c'.repeat(40) },
      publisher_qualification: { run_id: 13, run_attempt: 1 } } });
  mkdirSync(path.join(directory, 'next-trust'), { recursive: true });
  for (const [file, bytes] of Object.entries(proofs)) writeFileSync(path.join(directory, file), bytes);
  writeFileSync(path.join(directory, `next-trust/${environment}.json`), assetBytes);
  writeFileSync(path.join(directory, `next-trust/${environment}-context.json`), context);
  return directory;
}

// A minimal x86-64 ELF image around the given embedded payloads.
const elf = (...payloads) => {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  header.writeUInt16LE(0x3e, 18);
  return Buffer.concat([header, ...payloads.flatMap(p => [Buffer.alloc(13), p]), Buffer.alloc(13)]);
};

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-staging-'));
  const repo = path.join(directory, 'repo');
  for (const file of ['config/release-components.json', 'config/next-trust/staging.json', 'config/next-trust/production.json',
    'config/next-trust/lab.json', 'runtime/Cargo.lock', 'runtime/rust-toolchain.toml']) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    copyFileSync(path.join(product, file), path.join(repo, file));
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '-A');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const binary = path.join(directory, 'mdbase');
  writeFileSync(binary, elf(asset('staging')));
  return { directory, repo, commit: git('rev-parse', 'HEAD'), binary, handoff: handoff(path.join(directory, 'handoff'), 'staging'),
    receipt: path.join(directory, 'receipt.json'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('records exact source, build, trust handoff and artifact identities; checks reproduced bytes', () => {
  const f = fixture();
  try {
    const result = recordStagingArtifact(f);
    const receipt = JSON.parse(readFileSync(f.receipt));
    assert.equal(result.commit, f.commit);
    assert.equal(result.receipt_sha256, hex(readFileSync(f.receipt)));
    assert.equal(receipt.schema, 'mdbase-native-staging-artifact/1');
    assert.equal(receipt.source.commit, f.commit);
    assert.equal(receipt.source.cargo_lock_sha256, hex(readFileSync(path.join(product, 'runtime/Cargo.lock'))));
    assert.deepEqual(receipt.build, sorted(BUILD));
    assert.equal(receipt.trust.environment, 'staging');
    assert.equal(receipt.trust.control_plane_origin, 'https://connect-staging.mdbase.dev');
    assert.equal(receipt.trust.asset_sha256, pins.staging.sha256);
    assert.equal(receipt.trust.handoff.context_sha256, hex(readFileSync(path.join(f.handoff, 'next-trust/staging-context.json'))));
    assert.equal(receipt.trust.handoff.trust_publication.run_id, 12);
    assert.deepEqual(Object.keys(receipt.trust.handoff.proof_sha256).sort(), ['image-release-bundle.json',
      'image-release-bundle.sigstore.json', 'release-trust-bundle.json', 'release-trust-bundle.sigstore.json']);
    assert.equal(receipt.artifact.sha256, hex(readFileSync(f.binary)));
    // Deterministic: the same inputs give the same receipt bytes.
    const again = path.join(f.directory, 'again.json');
    recordStagingArtifact({ ...f, receipt: again });
    assert.deepEqual(readFileSync(again), readFileSync(f.receipt));
    assert.throws(() => recordStagingArtifact(f), /EEXIST/);
    assert.equal(checkStagingArtifact(f).sha256, receipt.artifact.sha256);
    const rebuilt = path.join(f.directory, 'rebuilt');
    writeFileSync(rebuilt, Buffer.concat([readFileSync(f.binary), Buffer.from([0])]));
    assert.throws(() => checkStagingArtifact({ ...f, binary: rebuilt }), /differ from the recorded build/);
  } finally { f.cleanup(); }
});

const faults = {
  'missing proof': f => rmSync(path.join(f.handoff, 'release-trust-bundle.sigstore.json')),
  'missing context': f => rmSync(path.join(f.handoff, 'next-trust/staging-context.json')),
  'extra handoff file': f => writeFileSync(path.join(f.handoff, 'next-trust/production.json'), asset('production')),
  'changed proof': f => writeFileSync(path.join(f.handoff, 'image-release-bundle.sigstore.json'), '{}'),
  'crossed production handoff': f => { rmSync(f.handoff, { recursive: true }); handoff(f.handoff, 'production'); },
  'crossed LAB handoff': f => { rmSync(f.handoff, { recursive: true }); handoff(f.handoff, 'lab'); },
  'coherent other staging asset': f => {
    rmSync(f.handoff, { recursive: true });
    handoff(f.handoff, 'staging', Buffer.concat([asset('staging'), Buffer.from(' ')]));
  },
  'artifact without staging trust': f => writeFileSync(f.binary, elf(Buffer.from('mdbase'))),
  'artifact with production trust': f => writeFileSync(f.binary, elf(asset('staging'), asset('production'))),
  'artifact with LAB trust': f => writeFileSync(f.binary, elf(asset('lab'), asset('staging'))),
  'artifact not an x86-64 executable': f => writeFileSync(f.binary, Buffer.concat([Buffer.from('#!/bin/sh\n'), asset('staging')])),
  'dirty source': f => writeFileSync(path.join(f.repo, 'untracked'), ''),
};
for (const [fault, apply] of Object.entries(faults)) test(`refuses ${fault} before writing a receipt`, () => {
  const f = fixture();
  try {
    apply(f);
    assert.throws(() => recordStagingArtifact(f), /Native staging artifact refused/);
    assert.throws(() => readFileSync(f.receipt), /ENOENT/);
  } finally { f.cleanup(); }
});

test('check refuses a receipt whose commit pins other staging trust', () => {
  const f = fixture();
  try {
    recordStagingArtifact(f);
    const receipt = JSON.parse(readFileSync(f.receipt));
    receipt.trust.asset_sha256 = pins.production.sha256;
    writeFileSync(f.receipt, JSON.stringify(receipt));
    assert.throws(() => checkStagingArtifact(f), /not its commit's staging pin/);
  } finally { f.cleanup(); }
});

test('the supported build remaps only checkout and Cargo home paths and needs a clean checkout', () => {
  assert.deepEqual(cargoArgs('/w/src', '/h/.cargo'), ['build', '--locked', '--release', '-p', 'mdbn-daemon', '--bin', 'mdbase',
    '--features', 'staging',
    '--config', 'target.x86_64-unknown-linux-gnu.rustflags=["--remap-path-prefix=/w/src=/source","--remap-path-prefix=/h/.cargo=/cargo"]',
    '--config', 'env.CFLAGS="-ffile-prefix-map=/w/src=/source -ffile-prefix-map=/h/.cargo=/cargo"']);
  const f = fixture();
  try {
    writeFileSync(path.join(f.repo, 'untracked'), '');
    assert.throws(() => buildStagingArtifact({ output: path.join(f.directory, 'out'), repo: f.repo }), /not clean/);
  } finally { f.cleanup(); }
});
