import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { authorityFixture, canonical } from '../../test/upgrade/retained-v2-probe.mjs';
import { authorizationSigningMessage } from '../../packages/protocol/dist/index.js';

const exec = promisify(execFile);
test('retained-v2 fixture signs its original declaration and exact operation ceiling', async () => {
  const collection = randomUUID();
  const fixture = await authorityFixture(collection);
  const { binding, signature } = fixture.policy.application_setup_evidence.application_authorization;
  const point = Buffer.from(binding.installation_signing_public_key, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', authorizationSigningMessage(binding), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(binding.application_manifest_digest, createHash('sha256').update(canonical(fixture.policy.application_setup_evidence.application_declaration)).digest('hex'));
  assert.equal(binding.collection_id, collection);
  assert.equal(binding.contracts.semantic_capabilities, 2);
  assert.deepEqual(binding.contracts.operation_transport_recovery, fixture.policy.operation_transport_recovery_protocols);
  assert.deepEqual(binding.requested_operations, fixture.policy.allowed_operations);
  assert.equal(binding.grant_signing_public_key, fixture.policy.proof_public_key);
  const altered = structuredClone(binding);
  altered.requested_operations.push('delete');
  assert.equal(verify('sha256', authorizationSigningMessage(altered), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), false);
  assert.equal(canonical({ b: 1, a: ['é', { z: 2, a: 1 }] }), '{"a":["é",{"a":1,"z":2}],"b":1}');
});

test('retained-v2 is registered in the existing harness and cannot remove legacy resources', async () => {
  const entry = await readFile(new URL('../../test/upgrade/provider-from-previous', import.meta.url), 'utf8');
  const script = await readFile(new URL('../../test/upgrade/retained-v2.sh', import.meta.url), 'utf8');
  assert.match(entry, /--retained-v2\)/);
  assert.match(entry, /trap - EXIT\n  retained_v2_run/);
  assert.match(script, /408c67bc10f128e0833f0da62cb3efb9d94657d7/);
  assert.match(script, /fresh_semantic_versions == \[1,2\]/);
  assert.match(script, /for name in "\$candidate" "\$previous" "\$postgres"/);
  assert.doesNotMatch(script, /upgrade_remove_container mdbase-provider-|docker (?:system|container|volume) prune|docker pull/);
  assert.doesNotMatch(script, /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s/i);
  for (const file of ['retained-v2.sh', 'provider-from-previous']) {
    await exec('bash', ['-n', new URL(`../../test/upgrade/${file}`, import.meta.url).pathname]);
  }
});

test('retained-v2 rejects a mutable beta94 tag before starting resources', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  // An image tag is rejected before even consulting Git or Docker.
  await assert.rejects(exec('bash', ['test/upgrade/provider-from-previous', '--retained-v2'], {
    cwd: root, env: { ...process.env, MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE: 'ghcr.io/mdbase-dev/mdbase-connect-hosted-provider:v0.1.0-beta.94' }
  }), error => error.code === 2 && /Caller image disagrees with the checked-in beta95 predecessor/.test(error.stderr));
});

test('Server CI requires retained-v2 evidence separately from the historical v1 lane', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/server-ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: test\/upgrade\/provider-from-previous --retained-v2/);
  assert.match(workflow, /source \.github\/retained-v2-predecessor\.env/);
  assert.match(workflow, /upgrade_verify_retained_v2_release "\$PWD"/);
  assert.doesNotMatch(workflow, /vars\.RETAINED_V2_BETA95_PROVIDER_IMAGE/);
  assert.match(workflow, /provider-from-previous --legacy-prelude/);
  assert.match(workflow, /- retained-v2-provider-upgrade/);
  assert.match(workflow, /"\$PROVIDER_UPGRADE" "\$RETAINED_V2"/);
});
