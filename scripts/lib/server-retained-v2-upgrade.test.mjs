import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { authorizationSigningMessage } from '../../packages/protocol/dist/index.js';
import { assertIssuanceRejected, assertPhase, manifest, requestForm, signedRequest } from '../../test/upgrade/server-retained-v2-probe.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('server rollback requests carry fresh valid signatures and exact semantic contracts', async () => {
  for (const version of [1, 2]) {
    const base = 'http://127.0.0.1:8787';
    const application = { id: randomUUID(), manifest_digest: 'a'.repeat(64) };
    const proof = await signedRequest(application, base, version);
    const bytes = Buffer.from(proof.binding.installation_signing_public_key, 'base64url');
    const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') } });
    assert.equal(verify('sha256', authorizationSigningMessage(proof.binding), {
      key: publicKey, dsaEncoding: 'ieee-p1363'
    }, Buffer.from(proof.signature, 'base64url')), true);
    const changed = structuredClone(proof.binding);
    changed.authorization_nonce = Buffer.alloc(32, 7).toString('base64url');
    assert.equal(verify('sha256', authorizationSigningMessage(changed), {
      key: publicKey, dsaEncoding: 'ieee-p1363'
    }, Buffer.from(proof.signature, 'base64url')), false);
    assert.equal(proof.binding.contracts.semantic_capabilities, version);
    assert.equal(manifest(base, version).requirements.capabilities.contract_version, version);
    assert.deepEqual(JSON.parse(requestForm(proof).get('application_authorization')), proof);
    assert.notEqual((await signedRequest(application, base, version)).binding.authorization_id, proof.binding.authorization_id);
    assert.equal(Date.parse(proof.binding.expires_at) - Date.parse(proof.binding.issued_at), 600_000);
  }
});

test('server gate assertions reject generic failures and unknown phases', () => {
  const body = { error: { message: 'Fresh application authorization issuance is disabled for semantic capability contract version 2.' } };
  assertIssuanceRejected({ status: 400 }, body);
  for (const status of [200, 401, 403, 404, 500]) assert.throws(() => assertIssuanceRejected({ status }, body));
  assert.throws(() => assertIssuanceRejected({ status: 400 }, { error: { message: 'Invalid signature' } }));
  assert.throws(() => assertPhase('retained-authority-success'));
});

test('server mode is bounded, explicit, and leaves the historical default intact', async () => {
  const entry = await read('test/upgrade/server-from-previous');
  const shell = await read('test/upgrade/server-retained-v2.sh');
  assert.match(entry, /--retained-v2-pending/);
  assert.match(entry, /seeding previous-release scoped and canonical authorization/);
  assert.match(entry, /proving account deletion rollback/);
  assert.match(shell, /408c67bc10f128e0833f0da62cb3efb9d94657d7/);
  assert.match(shell, /FRESH_APPLICATION_AUTHORIZATION_VERSIONS/);
  assert.doesNotMatch(shell, /docker pull|--entrypoint|INSERT INTO|UPDATE .* SET|GITHUB_TOKEN/);
  assert.match(shell, /activated_grants_qualified:false/);
  assert.match(shell, /token_refresh_adoption_qualified:false/);
  const workflow = await read('.github/workflows/server-ci.yml');
  assert.match(workflow, /run: env -u DATABASE_URL -u UPGRADE_SERVER_URL test\/upgrade\/server-from-previous --retained-v2-pending/);
  assert.match(workflow, /SERVER_RETAINED_V2: \$\{\{ needs\.retained-v2-server-pending\.result \}\}/);
  assert.match(workflow, /"\$SERVER_UPGRADE" "\$SERVER_RETAINED_V2"/);
  let position = -1;
  for (const step of ['probe candidate', 'probe restart', 'probe rollback', 'probe reupgrade']) {
    const next = shell.indexOf(step, position + 1);
    assert.ok(next > position); position = next;
  }
});

test('server shell programs parse', async () => {
  for (const path of ['test/upgrade/server-from-previous', 'test/upgrade/server-retained-v2.sh']) {
    await execute('bash', ['-n', new URL(path, root).pathname]);
  }
});

test('server input guard rejects beta94 before Docker or any external access', async () => {
  const script = new URL('test/upgrade/server-retained-v2.sh', root).pathname;
  await assert.rejects(() => execute('bash', ['-c', 'source "$1"; server_retained_v2_inputs', 'test', script], {
    env: { ...process.env, MDBASE_CONNECT_PREVIOUS_RELEASE: 'v0.1.0-beta.94',
      MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT: '408c67bc10f128e0833f0da62cb3efb9d94657d7' }, stdio: 'pipe'
  }), error => error.code === 2 && /requires exact beta.95/.test(error.stderr));
});
