import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { authorityFixture, canonical } from '../../test/upgrade/provider-upgrade-probe.mjs';
import { authorizationSigningMessage } from '../../packages/protocol/dist/index.js';

const exec = promisify(execFile);
test('provider upgrade fixture signs its original declaration and exact operation ceiling', async () => {
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

test('provider upgrade has one current scenario and cannot remove unowned resources', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const entry = await readFile(new URL('../../test/upgrade/provider-from-previous', import.meta.url), 'utf8');
  const script = await readFile(new URL('../../test/upgrade/provider-current.sh', import.meta.url), 'utf8');
  assert.match(entry, /\ncurrent_provider_run\n$/);
  assert.match(entry, /source "\$repo_root\/\.github\/previous-release\.env"/);
  assert.match(script, /for name in "\$candidate" "\$previous" "\$postgres"/);
  assert.doesNotMatch(script, /upgrade_remove_container mdbase-provider-|docker (?:system|container|volume) prune|docker pull/);
  for (const file of ['provider-from-previous', 'provider-current.sh']) {
    await exec('bash', ['-n', new URL(`../../test/upgrade/${file}`, import.meta.url).pathname]);
  }
  for (const args of [[], ['--retained-v2'], ['--legacy-prelude'], ['--current-upgrade', 'extra']]) {
    await assert.rejects(exec('bash', ['test/upgrade/provider-from-previous', ...args], { cwd: root }),
      error => error.code === 2 && /Usage: provider-from-previous --current-upgrade/.test(error.stderr));
  }
});

test('current recovery records specific refusal without deleting migration or fence state', async () => {
  const script = await readFile(new URL('../../test/upgrade/provider-current.sh', import.meta.url), 'utf8');
  assert.match(script, /timeout 45s docker wait/);
  assert.match(script, /hosted migration ledger is not an exact successful catalog prefix at/);
  assert.match(script, /rollback_result=refused-unknown-migration/);
  assert.match(script, /rollback_result=fixture-compatible/);
  assert.match(script, /candidate forward recovery/);
  assert.match(script, /cancellation_fence_preserved:true/);
  assert.doesNotMatch(script, /(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\s/i);
});

test('Server CI runs the current provider upgrade as a qualification lane', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/server-ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: test\/upgrade\/provider-from-previous --current-upgrade/);
  assert.doesNotMatch(workflow, /provider-from-previous --(?:retained-v2|legacy-prelude)|retained-v2-provider-upgrade|historical-prelude/);
  assert.match(workflow, /- current-provider-upgrade/);
  assert.match(workflow, /PROVIDER_UPGRADE: \$\{\{ needs\.current-provider-upgrade\.result \}\}/);
  assert.match(workflow, /"\$SERVER_RETAINED_V2" "\$PROVIDER_UPGRADE"/);
});
