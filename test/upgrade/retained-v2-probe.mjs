import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  applicationInstallationIdFromPublicKey, authorizationSigningMessage,
  authorizationContractRequirements, AUTHORITY_PROOF_DOMAIN
} from '../../packages/protocol/dist/index.js';

const sha = (value, encoding = 'base64url') => createHash('sha256').update(value).digest(encoding);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  return { public: Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url'),
    private: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}
function signature(message, key) {
  const bytes = sign('sha256', message, { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' });
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const s = BigInt(`0x${bytes.subarray(32).toString('hex')}`);
  if (s > order / 2n) Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex').copy(bytes, 32);
  return bytes.toString('base64url');
}
export async function authorityFixture(collection) {
  const installation = keyPair(), grant = keyPair(), agreement = keyPair();
  const declaration = {
    manifest_version: 1, id: 'dev.mdbase.upgrade.retained', name: 'Retained v2 qualification', distribution: 'portable',
    requirements: { access: 'full_collection', contracts: [],
      capabilities: { contract_version: 2, required: ['records.create'] },
      configuration: [{ id: 'tags', path: '/x-fixture/tags', predicate: 'contains', value: 'retained-v2' }] },
    provisions: { configuration: [{ requirement: 'tags', operation: 'set_add', path: '/x-fixture/tags', value: 'retained-v2' }], type_packs: [] },
    notifications: { criteria: [] }
  };
  const digest = sha(canonical(declaration), 'hex');
  const operations = ['apply_collection_setup', 'assess_collection_setup', 'create'];
  const now = Date.now();
  const binding = {
    protocol_version: 5, authorization_id: randomUUID(), application_id: randomUUID(),
    application_declaration_id: declaration.id, application_manifest_digest: digest,
    application_installation_id: await applicationInstallationIdFromPublicKey(installation.public),
    installation_signing_public_key: installation.public, grant_signing_public_key: grant.public,
    grant_agreement_public_key: agreement.public, flow: 'device_code',
    authorization_nonce: randomBytes(32).toString('base64url'), issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 600_000).toISOString(), code_challenge: randomBytes(32).toString('base64url'),
    contracts: { ...authorizationContractRequirements(operations, undefined, [], 2), operation_transport_recovery: [2] }, requested_operations: operations,
    collection_id: collection
  };
  const evidence = { application_declaration: declaration, application_authorization: {
    binding, signature: signature(authorizationSigningMessage(binding), installation.private)
  } };
  return { key: grant.private, policy: {
    replica_id: randomUUID(), name: 'Retained v2 application', purpose: 'application', mode: 'read_write',
    allowed_types: [], contract_scope: [], full_collection: true, allowed_operations: operations,
    operation_transport_protocol: 3, operation_transport_recovery_protocols: [2], file_capability: null,
    allowed_origin: 'null', proof_public_key: grant.public, grant_id: randomUUID(),
    application_declaration_id: declaration.id, application_declaration_digest: `sha256:${digest}`,
    application_setup_evidence: evidence, token: randomBytes(32).toString('base64url')
  }, setup: { application_id: declaration.id, declaration_digest: `sha256:${digest}`,
    requirements: { configuration: declaration.requirements.configuration }, provisions: declaration.provisions },
  freshSetup: { application_id: declaration.id, declaration_digest: `sha256:${digest}`,
    requirements: declaration.requirements, provisions: declaration.provisions } };
}
async function main(phase, file) {
  if (phase === 'port') {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    console.log(server.address().port);
    await new Promise(resolve => server.close(resolve));
    return;
  }
  const base = process.env.UPGRADE_PROVIDER_URL;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const state = phase === 'predecessor' ? { collection: randomUUID(), account: randomUUID() } : JSON.parse(await readFile(file, 'utf8'));
  const collectionPath = `/internal/v1/collections/${state.collection}`;
  async function http(method, path, input, expected, authority) {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const credential = authority?.policy.token ?? process.env.PROVIDER_INTERNAL_TOKEN;
    const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
    if (authority) {
      const timestamp = Math.floor(Date.now() / 1000), nonce = randomUUID();
      const message = [AUTHORITY_PROOF_DOMAIN, 1, method, path, sha(body ?? ''), sha(credential), timestamp, nonce].join('\n');
      Object.assign(headers, { origin: 'null', 'x-mdbase-proof-version': '1', 'x-mdbase-proof-timestamp': String(timestamp),
        'x-mdbase-proof-nonce': nonce, 'x-mdbase-proof-signature': signature(Buffer.from(message), authority.key) });
    }
    const response = await fetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    assert.equal(response.status, expected, `${phase}: ${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const register = (authority, status = 201) => http('POST', `/internal/v2/collections/${state.collection}/replicas`, authority.policy, status);
  const policy = (authority, status = 204) => http('PATCH', `/internal/v2/replicas/${authority.policy.replica_id}/policy`, authority.policy, status);
  const op = (operation, input, status = 200, id = randomUUID(), authority = state.authority) => http('POST',
    `/v1/authorities/${state.collection}/operations/${operation}`, { protocol_version: 3, request_id: id, input }, status, authority);
  async function capability(enabled) {
    const ready = await http('GET', '/ready', undefined, 200);
    assert.equal(ready.provider.capabilities.includes('application-authorization-v2-issuance'), enabled);
  }
  async function replay() {
    assert.deepEqual(await op('create', state.create, 200, state.request), state.receipt);
    const conflict = await op('create', { ...state.create, body: 'Changed bytes' }, 409, state.request);
    assert.equal(conflict.error.code, 'mutation_request_conflict');
  }
  async function enforce(freshIssuanceEnabled = true) {
    assert.equal((await op('assess_collection_setup', state.authority.setup)).result.valid, true);
    const mismatch = structuredClone(state.authority.setup);
    mismatch.provisions.configuration[0].value = 'unapproved';
    const expanded = { ...state.authority, policy: { ...state.authority.policy, allowed_operations: [...state.authority.policy.allowed_operations, 'delete'] } };
    assert.equal(
      (await policy(expanded, 403)).error.code,
      freshIssuanceEnabled ? 'application_declaration_mismatch' : 'application_authorization_issuance_disabled'
    );
    const denied = await op('apply_collection_setup', mismatch, 403);
    assert.equal(denied.error.code, 'application_declaration_mismatch');
    // Valid request signatures, with operations outside the exact create/setup ceiling.
    for (const operation of ['read', 'update', 'delete', 'create_view_source', 'create_type', 'list_timers', 'sync']) {
      const result = await op(operation, operation === 'sync' ? { action: 'open_session' } : {}, 403);
      assert.equal(result.error.code, 'insufficient_access');
    }
  }
  if (phase === 'predecessor') {
    await capability(false);
    await http('PUT', `/internal/v1/accounts/${state.account}`, {
      entitlement_revision: 1, hosted_storage_bytes: 1073741824, retained_file_bytes: 2147483648,
      max_document_bytes: 2097152, max_single_file_bytes: 262144000, max_mirror_replicas_per_collection: 10,
      max_application_replicas_per_collection: 10, max_hosted_collections: 10, max_files_per_collection: 10000
    }, 200);
    await http('POST', '/internal/v1/collections', { account_id: state.account, collection_id: state.collection,
      template: 'mdbase', display_name: 'Retained v2 disposable', timezone: 'Australia/Melbourne' }, 201);
    state.authority = await authorityFixture(state.collection);
    state.fresh = await authorityFixture(state.collection);
    // Keep an explicitly v1 credential live throughout the same binary transitions.
    state.v1 = { ...state.authority, policy: { ...state.authority.policy,
      replica_id: randomUUID(), grant_id: randomUUID(), token: randomBytes(32).toString('base64url'),
      application_declaration_id: 'dev.mdbase.upgrade.v1',
      application_declaration_digest: `sha256:${sha(canonical({ manifest_version: 1, id: 'dev.mdbase.upgrade.v1', name: 'V1 upgrade fixture', requirements: { access: 'full_collection', contracts: [] } }), 'hex')}`,
      application_setup_evidence: undefined, allowed_operations: ['create'] } };
    await http('POST', `${collectionPath}/replicas`, state.v1.policy, 201);
    state.v1Request = randomUUID();
    state.v1Input = { path: 'upgrade/v1.md', frontmatter: { title: 'V1 preserved' }, body: 'V1 exact bytes' };
    state.v1Receipt = await op('create', state.v1Input, 200, state.v1Request, state.v1);
  } else if (phase === 'issue') {
    await capability(true);
    const candidateV1 = { ...state.v1.policy, replica_id: randomUUID(), grant_id: randomUUID(), token: randomBytes(32).toString('base64url') };
    await http('POST', `${collectionPath}/replicas`, candidateV1, 201);
    // Setup commits independently. Never describe later issuance failure as undoing it.
    const setup = await http('POST', `${collectionPath}/fresh-application-setup-v2`, state.authority.freshSetup, 200);
    assert.ok(setup.setup_assessment);
    assert.ok(setup.provision_receipt);
    const before = await http('GET', `${collectionPath}/replicas`, undefined, 200);
    assert.ok(!before.replicas.some(row => row.replica_id === state.authority.policy.replica_id || row.id === state.authority.policy.replica_id));
    await register(state.authority);
    state.request = randomUUID();
    state.create = { path: 'upgrade/retained-v2.md', frontmatter: { title: 'Candidate issued v2' }, body: 'Exact retained v2 bytes' };
    state.receipt = await op('create', state.create, 200, state.request);
    assert.ok(state.receipt.result);
    const assessment = (await op('assess_collection_setup', state.authority.setup)).result;
    assert.equal(assessment.valid, true);
    const apply = { ...state.authority.setup };
    for (const [input, output] of [
      ['expected_assessment_digest', 'assessment_digest'],
      ['expected_collection_revision', 'collection_revision'],
      ['expected_provision_digest', 'provision_digest']
    ]) {
      assert.equal(typeof assessment.result[output], 'string');
      apply[input] = assessment.result[output];
    }
    await op('apply_collection_setup', apply);
  } else if (phase === 'enforce') {
    await enforce();
  } else if (phase === 'replay') {
    await capability(true);
    await replay();
  } else if (phase === 'retained') {
    await capability(false);
    await register(state.authority);
    await policy(state.authority);
    await replay();
    await enforce(false);
    const denied = await register(state.fresh, 403);
    assert.equal(denied.error.code, 'application_authorization_issuance_disabled');
    await http('POST', `${collectionPath}/fresh-application-setup-v2`, state.fresh.freshSetup, 404);
    // A valid new application signature is not evidence of prior approval.
    const replaced = { ...state.fresh, policy: { ...state.fresh.policy, replica_id: state.authority.policy.replica_id } };
    assert.equal((await policy(replaced, 403)).error.code, 'application_authorization_issuance_disabled');
  } else if (phase === 'retained-write') {
    state.rollbackRequest = randomUUID();
    state.rollbackInput = { ...state.create, path: 'upgrade/beta95-write.md' };
    state.rollbackReceipt = await op('create', state.rollbackInput, 200, state.rollbackRequest);
  } else if (phase === 'narrow') {
    state.narrowed = structuredClone(state.authority);
    state.narrowed.policy.allowed_operations = ['assess_collection_setup', 'create'];
    await policy(state.narrowed);
  } else if (phase === 'narrowed') {
    await policy(state.narrowed);
    await register(state.narrowed);
    assert.equal((await op('assess_collection_setup', state.authority.setup)).result.valid, true);
    await op('apply_collection_setup', state.authority.setup, 403);
    // Terminal replay is a recovery boundary, not permission to perform new work.
    await replay();
    assert.deepEqual(await op('create', state.rollbackInput, 200, state.rollbackRequest), state.rollbackReceipt);
  } else if (phase === 'reupgrade') {
    await capability(true);
    await register(state.fresh);
    await op('create', { ...state.create, path: 'upgrade/reupgrade.md' }, 200, randomUUID(), state.fresh);
  } else if (phase === 'revoke') {
    await http('DELETE', `/internal/v1/replicas/${state.fresh.policy.replica_id}`, undefined, 204);
    // This is a durable revocation assertion; image rollback does not restore it.
    await op('create', { ...state.create, path: 'upgrade/revoked.md' }, 401, randomUUID(), state.fresh);
  } else throw new Error(`Unknown phase ${phase}`);
  if (phase !== 'predecessor') assert.deepEqual(await op('create', state.v1Input, 200, state.v1Request, state.v1), state.v1Receipt);
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  console.log(`${phase}: passed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(...process.argv.slice(2));
