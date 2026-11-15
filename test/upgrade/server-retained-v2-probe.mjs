import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION, applicationInstallationIdFromPublicKey,
  authorizationContractRequirements, authorizationSigningMessage
} from '../../packages/protocol/dist/index.js';

export const phases = ['candidate', 'restart', 'rollback', 'reupgrade'];
export function assertPhase(phase) { assert.ok(phases.includes(phase), `Unknown server phase: ${phase}`); }
export function manifest(base, version) {
  return { manifest_version: 1, id: `dev.mdbase.server-upgrade.v${version}`,
    name: `Server upgrade v${version}`, homepage: base, redirect_uris: [`${base}/callback`],
    requirements: { access: 'full_collection', contracts: [], capabilities: {
      contract_version: version, required: [version === 2 ? 'records.create' : 'records.read']
    } } };
}
function keyPair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = pair.publicKey.export({ format: 'jwk' });
  return { private: pair.privateKey, public: Buffer.concat([
    Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')
  ]).toString('base64url') };
}
export async function signedRequest(application, base, version) {
  const installation = keyPair(), agreement = keyPair(), grant = keyPair();
  const verifier = randomBytes(32).toString('base64url');
  const operations = version === 2 ? ['create'] : ['read'];
  const now = Date.now();
  const binding = {
    protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    authorization_id: randomUUID(), application_id: application.id,
    application_declaration_id: manifest(base, version).id,
    application_manifest_digest: application.manifest_digest,
    application_installation_id: await applicationInstallationIdFromPublicKey(installation.public),
    installation_signing_public_key: installation.public,
    grant_agreement_public_key: agreement.public, grant_signing_public_key: grant.public,
    flow: 'authorization_code', authorization_nonce: randomBytes(32).toString('base64url'),
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString(),
    redirect_uri: `${base}/callback`, state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    contracts: authorizationContractRequirements(operations, undefined, [], version),
    requested_operations: operations
  };
  const signature = sign('sha256', authorizationSigningMessage(binding), {
    key: installation.private, dsaEncoding: 'ieee-p1363'
  });
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
  if (s > order / 2n) Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex').copy(signature, 32);
  return { binding, signature: signature.toString('base64url') };
}
export function requestForm(proof) {
  const b = proof.binding;
  return new URLSearchParams({ client_id: b.application_id, redirect_uri: b.redirect_uri,
    code_challenge: b.code_challenge, code_challenge_method: 'S256', state: b.state,
    operations: b.requested_operations.join(','), application_authorization: JSON.stringify(proof) });
}
export function assertIssuanceRejected(response, body) {
  assert.equal(response.status, 400);
  // Require the actual issuance gate, not malformed proof, absent collection, or auth failure.
  assert.equal(body.error?.message, 'Fresh application authorization issuance is disabled for semantic capability contract version 2.');
}

async function run(phase, stateFile) {
  assertPhase(phase);
  const base = process.env.UPGRADE_SERVER_URL;
  assert.match(base ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  const state = phase === 'candidate' ? {} : JSON.parse(await readFile(stateFile, 'utf8'));
  async function request(path, { body, form, cookie = state.cookie, method = 'GET' } = {}) {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual',
      signal: AbortSignal.timeout(10_000), headers: {
        ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {})
      }, ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }
  async function start(version, rejected = false) {
    const proof = await signedRequest(state.apps[version], base, version);
    const result = await request('/oauth/authorization_request', { method: 'POST', form: requestForm(proof) });
    if (rejected) { assertIssuanceRejected(result.response, result.body); return; }
    assert.equal(result.response.status, 200);
    assert.equal(result.body.authorization_id, proof.binding.authorization_id);
    assert.equal(result.body.authorization_uri, `${base}/oauth/authorize?request_id=${proof.binding.authorization_id}`);
    const claim = await fetch(result.body.authorization_uri, { headers: { cookie: state.cookie },
      redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(claim.status, 302);
    assert.equal(new URL(claim.headers.get('location'), base).href, `${base}/authorize/${proof.binding.authorization_id}`);
    return proof;
  }
  async function pending(proof) {
    const result = await request(`/v1/authorization-requests/${proof.binding.authorization_id}/status`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { status: 'pending' });
  }
  async function approvalBoundary(proof, rejected) {
    const result = await request(`/v1/authorization-requests/${proof.binding.authorization_id}/approve`, {
      method: 'POST', body: { collection_id: state.missingCollection, offer_id: state.missingOffer,
        operations: proof.binding.requested_operations }
    });
    if (rejected) assertIssuanceRejected(result.response, result.body);
    else {
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error?.message,
        'That collection is no longer being offered by a live connector. Refresh and choose again.');
    }
    await pending(proof);
  }
  if (phase === 'candidate') {
    const session = await request('/v1/dev/session', { method: 'POST', body: {
      name: 'Disposable server rollback', email: `${randomUUID()}@example.invalid`
    } });
    assert.equal(session.response.status, 200);
    state.cookie = session.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(state.cookie);
    state.apps = {};
    for (const version of [1, 2]) {
      const result = await request('/v1/apps/register', { method: 'POST', body: { manifest: manifest(base, version) } });
      assert.ok([200, 201].includes(result.response.status));
      assert.match(result.body.application.manifest_digest, /^[a-f0-9]{64}$/);
      state.apps[version] = result.body.application;
    }
    state.v1 = await start(1); state.v2 = await start(2);
    state.missingCollection = randomUUID(); state.missingOffer = randomUUID();
  }
  await pending(state.v1); await pending(state.v2);
  if (phase === 'rollback') {
    await start(2, true);
    await approvalBoundary(state.v2, true);
    // Existing signed request is not evidence of approval and cannot bypass issuance.
    const replay = await request('/oauth/authorization_request', { method: 'POST', form: requestForm(state.v2) });
    assertIssuanceRejected(replay.response, replay.body);
  } else {
    await approvalBoundary(state.v2, false);
  }
  if (phase === 'reupgrade') {
    await pending(await start(2));
    await pending(await start(1));
  }
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  console.log(`${phase}: pending request checks passed; no activated authority qualified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'port') {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });
  } else await run(process.argv[2], process.argv[3]);
}
