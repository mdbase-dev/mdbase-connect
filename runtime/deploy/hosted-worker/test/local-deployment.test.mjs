import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// Test-only substitution of the BUILD literal, never a runtime selector.
mock.module('#hosted-local-build', { namedExports: { LOCAL_REHEARSAL_BUILD: true } });
let trust = { schema: 'mdbn-app-trust/release/1', environment: 'local', cpOrigin: 'http://127.0.0.1:8111', logOrigin: 'http://127.0.0.1:8222',
  assetSha256: 'aa'.repeat(32), source: { repository: 'mdbase-dev/mdbase-connect', commit: 'bb'.repeat(20), version: 'local' },
  trustedRoots: [new Uint8Array(32).fill(1)], policyPins: Uint8Array.of(0x80) };
const original = trust;
mock.module('#hosted-release-trust', { namedExports: { appReleaseTrust: () => trust } });
const { LocalSoftwareKms } = await import('../src/custody/local-kms.ts');
const { localOrigin } = await import('../src/local-origin.ts');
const { productionParts, deploymentRelease, ownedCppControlOrigin } = await import('../src/factory.ts');
const { ControlClient } = await import('../src/control.ts');
const { connectClient } = await import('../src/migration-connect.ts');
const collection = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';
const arn = 'arn:local:kms:local:000000000000:key/33333333-3333-4333-8333-333333333333';
const key = 'ab'.repeat(32);
const environment = { KMS_ENVIRONMENT: 'local', KMS_KEY_ARN: arn, LOCAL_KMS_KEY: key, KMS_COLLECTIONS: collection,
  CP_URL: trust.cpOrigin, LOG_URL: trust.logOrigin, CP_INBOUND_TOKEN: 't'.repeat(40) };

test('local software KMS roundtrips actual 96-byte secrets and binds context/key/envelope', async () => {
  const kms = new LocalSoftwareKms(arn, key, 'local', [collection]);
  const secret = crypto.getRandomValues(new Uint8Array(96));
  const signal = AbortSignal.timeout(5000);
  const wrapped = await kms.wrapDeviceKeys({ collection, device, secret }, signal);
  assert.deepEqual(await kms.unwrapDeviceKeys(collection, device, wrapped.envelope, arn, signal), secret);
  const second = await kms.wrapDeviceKeys({ collection, device, secret }, signal);
  assert.notDeepEqual(second.envelope, wrapped.envelope, 'fresh random GCM nonce');
  await assert.rejects(kms.unwrapDeviceKeys(collection, collection, wrapped.envelope, arn, signal), /kms_refused/);
  await assert.rejects(kms.unwrapDeviceKeys(device, device, wrapped.envelope, arn, signal), /not_allowed/);
  const changed = wrapped.envelope.slice(); changed[changed.length - 1] ^= 1;
  await assert.rejects(kms.unwrapDeviceKeys(collection, device, changed, arn, signal), /kms_refused/);
  await assert.rejects(new LocalSoftwareKms(arn, 'cd'.repeat(32), 'local', [collection]).unwrapDeviceKeys(collection, device, wrapped.envelope, arn, signal), /kms_refused/);
  await assert.rejects(kms.unwrapDeviceKeys(collection, device, wrapped.envelope, arn + 'x', signal), /key_not_configured/);
  await assert.rejects(kms.wrapDeviceKeys({ collection, device, secret: new Uint8Array(95) }, signal), /secret_invalid/);
});

test('local factory preserves actual ControlClient provenance and rejects all managed contexts', () => {
  const parts = productionParts(environment);
  assert.ok(parts?.kms instanceof LocalSoftwareKms);
  assert.equal(ownedCppControlOrigin(parts.control), trust.cpOrigin);
  assert.equal(ownedCppControlOrigin(new ControlClient({ url: trust.cpOrigin, token: 't'.repeat(40), environment: 'local' })), null);
  for (const scope of ['lab', 'staging', 'production']) {
    assert.throws(() => new LocalSoftwareKms(arn, key, scope, [collection]), /invalid_config/);
    assert.equal(productionParts({ ...environment, KMS_ENVIRONMENT: scope }), null);
    trust = { ...original, environment: scope };
    assert.equal(deploymentRelease({ ...environment, KMS_ENVIRONMENT: scope }), null);
  }
  trust = original;
  for (const missing of ['LOCAL_KMS_KEY', 'KMS_KEY_ARN', 'CP_INBOUND_TOKEN']) assert.equal(productionParts({ ...environment, [missing]: '' }), null);
});

test('HTTP needs local build AND environment=local AND exact literal loopback', () => {
  assert.ok(localOrigin('http://127.0.0.1:8111', 'local'));
  for (const origin of ['http://127.1:8111', 'http://localhost:8111', 'http://127.0.0.1:8111/', 'http://user@127.0.0.1:8111', 'http://127.0.0.1:8111/path', 'https://cp.test']) {
    assert.equal(localOrigin(origin, 'local'), false);
    assert.throws(() => new ControlClient({ url: origin, token: 't'.repeat(40), environment: 'local' }));
    assert.throws(() => connectClient({ url: origin, token: 't'.repeat(40), environment: 'local' }));
  }
  for (const scope of [undefined, 'lab', 'staging', 'production']) {
    assert.equal(localOrigin('http://127.0.0.1:8111', scope), false);
    assert.throws(() => new ControlClient({ url: 'http://127.0.0.1:8111', token: 't'.repeat(40), environment: scope }));
    assert.throws(() => connectClient({ url: 'http://127.0.0.1:8111', token: 't'.repeat(40), environment: scope }));
  }
  assert.ok(connectClient({ url: original.cpOrigin, token: 't'.repeat(40), environment: 'local' }));
});
