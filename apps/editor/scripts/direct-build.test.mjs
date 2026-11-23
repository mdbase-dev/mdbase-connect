import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { takePairInvitation } from '../direct/invitation.ts';
import { cleanDirectEntry } from '../direct/trust.ts';
import { editorDirectOrigin } from './direct-origin.mjs';

const origin = 'https://direct.example.org';
test('the direct SDK file alias is immutable across frozen installs', async () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const spec = pkg.dependencies['@mdbase-dev/sdk-self-hosted'];
  assert.match(spec, /^file:vendor\/sdk-self-hosted-[0-9a-f]{64}\.tgz$/);
  const bytes = await readFile(new URL(spec.slice(5), root));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(spec, `file:vendor/sdk-self-hosted-${digest}.tgz`);
  // direct-archive.mjs verify rebuilds these bytes from the recorded source tree.
  const facts = JSON.parse(await readFile(new URL(spec.slice(5).replace(/\.tgz$/, '.json'), root), 'utf8'));
  assert.equal(facts.sha256, digest);
  assert.equal(facts.sri, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.match(facts.source.tree, /^[0-9a-f]{40}$/);
  const lock = await readFile(new URL('../../pnpm-lock.yaml', root), 'utf8');
  assert(lock.includes(`resolution: {integrity: ${facts.sri}, tarball: file:apps/editor/${spec.slice(5)}}`));
});

const fixture = () => {
  const page = { location: new URL(origin), navigator: { serviceWorker: { controller: null, getRegistrations: async () => [] } } };
  page.top = page;
  return page;
};

test('the optional chooser destination is a dedicated literal HTTPS origin', () => {
  assert.equal(editorDirectOrigin(), undefined);
  assert.equal(editorDirectOrigin(origin), origin);
  for (const value of ['http://direct.example.org', 'https://editor.mdbase.dev', 'https://editor-staging.mdbase.dev',
    'https://editor-lab.mdbase.dev.', `${origin}/`, `${origin}?x=1`, `${origin}#x`, `${origin}/direct`, 'https://user@direct.example.org']) {
    assert.throws(() => editorDirectOrigin(value));
  }
});

test('only the top-level clean root may open or restore a grant', async () => {
  assert.equal(await cleanDirectEntry(origin, fixture()), true);
  for (const suffix of ['/note', '/?', '/#', '/?grant=example', '/#example']) {
    const page = fixture(); page.location = new URL(origin + suffix);
    assert.equal(await cleanDirectEntry(origin, page), false);
  }
  assert.equal(await cleanDirectEntry('https://other.example.org', fixture()), false);
  const framed = fixture(); framed.top = {};
  assert.equal(await cleanDirectEntry(origin, framed), false);
});

test('worker discovery must succeed and find neither a registration nor a controller', async () => {
  const none = fixture(); none.navigator.serviceWorker = undefined;
  assert.equal(await cleanDirectEntry(origin, none), true, 'a browser without service workers has none to refuse');
  for (const worker of [{ controller: {} }, { getRegistrations: async () => { throw Error('denied'); } },
    ...['installing', 'waiting', 'active'].map(state => ({ getRegistrations: async () => [{ [state]: {} }] }))]) {
    const page = fixture(); page.navigator.serviceWorker = worker;
    assert.equal(await cleanDirectEntry(origin, page), false);
  }
  const page = fixture(); const worker = page.navigator.serviceWorker;
  worker.getRegistrations = async () => { worker.controller = {}; return []; };
  assert.equal(await cleanDirectEntry(origin, page), false);
});

test('static entry permits WSS and HTTPS connections and blocks forms, workers and media', async () => {
  const html = await readFile(new URL('../direct/index.html', import.meta.url), 'utf8');
  const policy = new Map(/Content-Security-Policy" content="([^"]+)"/.exec(html)[1].split('; ').map(directive => {
    const [name, ...sources] = directive.split(' '); return [name, sources];
  }));
  assert.deepEqual(policy.get('connect-src'), ['wss:', 'https:']);
  for (const directive of ['default-src', 'img-src', 'worker-src', 'form-action', 'base-uri']) assert.deepEqual(policy.get(directive), ["'none'"]);
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.equal(policy.has('media-src'), false);
  assert.match(html, /name="referrer" content="no-referrer"/);
  // Documents the entry page does not cover (a host's 404) get the same policy from the response.
  const served = await readFile(new URL('../direct/public/_headers', import.meta.url), 'utf8');
  const header = /Content-Security-Policy: (.+)/.exec(served)[1];
  assert.equal(header, [...policy].map(([name, sources]) => [name, ...sources].join(' ')).join('; ') + "; frame-ancestors 'none'");
  assert.match(served, /Cross-Origin-Opener-Policy: same-origin/);
});

test('an invalid invitation is scrubbed and refused without copying its contents into history', () => {
  const pin = 'a'.repeat(64);
  const good = encodeURIComponent('https://192.168.1.23:8443#sha256=' + pin);
  for (const path of ['/?x#' + 'mdbase-pair=' + good, '/wrong#mdbase-pair=' + good,
    '/#mdbase-pair=%', '/#mdbase-pair=', '/#mdbase-pair=' + good + '&code=12345678',
    '/#mdbase-pair=' + encodeURIComponent('https://example.test'), '/#mdbase-pair=' + good + '%0A']) {
    const page = fixture();
    page.location = new URL(origin + path);
    const calls = [];
    page.history = { replaceState: (...args) => { calls.push(args); page.location = new URL(args[2], origin); } };
    assert.throws(() => takePairInvitation(page));
    assert.deepEqual(calls, [[null, '', '/']]);
  }
});
