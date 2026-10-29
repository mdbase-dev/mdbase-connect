// Synthetic custody proofs only, NOT release authentication. Throwaway signing
// keys exist only in memory. Exercise the real ONE native trust verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildManagedNativeTrust, checkManagedNativeTrust } from './build-managed-native-trust.mjs';
const sha = b => createHash('sha256').update(b).digest();
const hex = b => sha(b).toString('hex');
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
const json = v => JSON.stringify(sorted(v));
const parent = path.resolve('.artifacts/managed-native-tests');
const verifier = path.resolve(process.env.MDBN_TRUST_VERIFIER ?? 'target/debug/mdbn-trust');
const uint = n => { const b = Buffer.alloc(9); b[0] = 0x1b; b.writeBigUInt64BE(BigInt(n), 1); return b; };
export function fixture(environment) {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'fixture-'));
  const root = generateKeyPairSync('ed25519'), policy = generateKeyPairSync('ed25519');
  const pk = k => k.export({ format: 'der', type: 'spki' }).subarray(-32);
  const rootPk = pk(root.publicKey), policyPk = pk(policy.publicKey), rootId = sha(rootPk).subarray(0, 16);
  const now = Date.now() - 1000, before = now - 60000, after = now + 3600000;
  const tag = Buffer.from('mdbase/v1/cp-cert');
  const cbor = Buffer.concat([Buffer.from([0xa4, 0, 0x58, 32]), policyPk, Buffer.from([1]), uint(before), Buffer.from([2]), uint(after), Buffer.from([3, 0x50]), rootId]);
  const source = { repository: 'mdbase-dev/mdbase-connect', commit: 'a'.repeat(40), version: '0.0.0-synthetic' };
  const cp = `https://connect${environment === 'staging' ? '-staging' : ''}.mdbase.dev`, log = 'https://log.synthetic.example';
  const asset = Buffer.from(json({ schema_version: 1, environment, control_plane_origin: cp, log_origin: log, issued_at: now, source,
    roots: [{ key_id: rootId.toString('hex'), public_key: rootPk.toString('hex') }],
    policy_keys: [{ key_id: sha(policyPk).subarray(0, 16).toString('hex'), certificate: {
      policy_public_key: policyPk.toString('hex'), not_before: before, not_after: after,
      root_key_id: rootId.toString('hex'), signature: sign(null, sha(Buffer.concat([Buffer.from([tag.length]), tag, cbor])), root.privateKey).toString('hex'),
    } }] }));
  const image = Buffer.from(json({ ...source, publication: { runId: 1, runAttempt: 1 } }));
  const inventory = Buffer.from(json({ schemaVersion: 1, kind: 'mdbase-release-trust-bundle', ...source,
    imageBundle: { path: 'image-release-bundle.json', length: image.length, sha256: hex(image), publicationRunId: 1, publicationRunAttempt: 1 },
    publication: { workflow: 'publish-images.yml', runId: 2, runAttempt: 1, publisherCommit: 'c'.repeat(40) }, qualification: { workflow: 'server-ci.yml', runId: 3, runAttempt: 1 },
    trustAssets: [{ path: `next-trust/${environment}.json`, length: asset.length, sha256: hex(asset), environment, controlPlaneOrigin: cp, logOrigin: log, source }] }));
  const proofs = { 'image-release-bundle.json': image, 'release-trust-bundle.json': inventory,
    'image-release-bundle.sigstore.json': Buffer.from('{"synthetic":"not-authentication"}'), 'release-trust-bundle.sigstore.json': Buffer.from('{"synthetic":"not-authentication"}') };
  const context = Buffer.from(json({ schema_version: 1, kind: 'mdbase-next-build-trust-context',
    context: { sha256: hex(asset), environment, control_plane_origin: cp, log_origin: log, source },
    provenance: { asset_path: `next-trust/${environment}.json`, asset_length: asset.length,
      proof_sha256: Object.fromEntries(Object.entries(proofs).map(([k, b]) => [k, hex(b)])),
      image_publication: { run_id: 1, run_attempt: 1 }, trust_publication: { run_id: 2, run_attempt: 1, publisher_commit: 'c'.repeat(40) }, publisher_qualification: { run_id: 3, run_attempt: 1 } } }));
  const handoff = path.join(directory, 'handoff'); mkdirSync(path.join(handoff, 'next-trust'), { recursive: true });
  for (const [file, bytes] of Object.entries(proofs)) writeFileSync(path.join(handoff, file), bytes);
  writeFileSync(path.join(handoff, `next-trust/${environment}.json`), asset);
  const contextFile = path.join(handoff, `next-trust/${environment}-context.json`); writeFileSync(contextFile, context);
  const receipt = { schema: 'mdbn-sdk/application-build/1', contextSha256: hex(context), verifierSha256: hex(readFileSync(verifier)), verifierSourceCommit: 'b'.repeat(40) };
  writeFileSync(path.join(directory, 'receipt.json'), json(receipt));
  const inputFile = path.join(directory, 'input.json'); writeFileSync(inputFile, json({ context: contextFile, receipt: 'receipt.json', verifier }));
  return { directory, handoff, contextFile, inputFile, asset, receipt, outputDirectory: path.join(directory, 'output'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
for (const environment of ['staging', 'production']) test(`${environment}: certified exact bytes plus unchanged handoff and deterministic Rust input`, () => {
  const f = fixture(environment);
  try {
    const built = buildManagedNativeTrust({ ...f, environment });
    assert.equal(built.environment, environment);
    assert.deepEqual(readFileSync(path.join(f.outputDirectory, environment, `next-trust/${environment}.json`)), f.asset);
    const checked = checkManagedNativeTrust({ ...f, environment }); assert.equal(checked.sha256, hex(f.asset));
    assert.throws(() => buildManagedNativeTrust({ ...f, environment }));
    const compilerInput = path.join(f.outputDirectory, environment, 'context.rs');
    writeFileSync(compilerInput, readFileSync(compilerInput, 'utf8') + '\n');
    assert.throws(() => checkManagedNativeTrust({ ...f, environment }));
  } finally { f.cleanup(); }
});
for (const fault of ['changed asset', 'missing proof', 'changed context', 'wrong verifier', 'bad certificate', 'cross environment']) test(`native input refuses ${fault} before compiler publication`, () => {
  const f = fixture('staging');
  try {
    if (fault === 'changed asset') writeFileSync(path.join(f.handoff, 'next-trust/staging.json'), f.asset.toString() + ' ');
    if (fault === 'missing proof') rmSync(path.join(f.handoff, 'image-release-bundle.sigstore.json'));
    if (fault === 'changed context') writeFileSync(f.contextFile, readFileSync(f.contextFile, 'utf8') + '\n');
    if (fault === 'wrong verifier') { f.receipt.verifierSha256 = '0'.repeat(64); writeFileSync(path.join(f.directory, 'receipt.json'), json(f.receipt)); }
    if (fault === 'bad certificate') {
      // Even coherently restamped synthetic custody cannot bypass the ONE
      // cryptographic verifier. None of these hashes claim authentication.
      const payload = JSON.parse(f.asset); payload.policy_keys[0].certificate.signature = '0'.repeat(128);
      const asset = Buffer.from(json(payload));
      const context = JSON.parse(readFileSync(f.contextFile)); context.context.sha256 = hex(asset); context.provenance.asset_length = asset.length;
      const inventoryPath = path.join(f.handoff, 'release-trust-bundle.json');
      const inventory = JSON.parse(readFileSync(inventoryPath)); inventory.trustAssets[0].sha256 = hex(asset); inventory.trustAssets[0].length = asset.length;
      const inventoryBytes = Buffer.from(json(inventory)); writeFileSync(inventoryPath, inventoryBytes);
      context.provenance.proof_sha256['release-trust-bundle.json'] = hex(inventoryBytes);
      const contextBytes = Buffer.from(json(context)); writeFileSync(f.contextFile, contextBytes);
      f.receipt.contextSha256 = hex(contextBytes); writeFileSync(path.join(f.directory, 'receipt.json'), json(f.receipt));
      writeFileSync(path.join(f.handoff, 'next-trust/staging.json'), asset);
    }
    assert.throws(() => buildManagedNativeTrust({ ...f, environment: fault === 'cross environment' ? 'production' : 'staging' }));
    assert.equal(existsSync(path.join(f.outputDirectory, 'staging')), false);
    assert.equal(existsSync(path.join(f.outputDirectory, 'production')), false);
  } finally { f.cleanup(); }
});
