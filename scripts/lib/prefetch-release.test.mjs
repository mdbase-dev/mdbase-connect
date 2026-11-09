import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { cosignAssets, electronPlan, installCosign, lockedElectronVersion, prefetchElectron } from '../ci/prefetch-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('uses the lockfile resolution after workspace overrides, and guards the qualified cache consumer', async () => {
  const lock = await readFile(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.equal(lockedElectronVersion(lock), '43.8.1');
  assert.throws(() => lockedElectronVersion(lock.replaceAll("'@electron/get': 5.1.0(", "'@electron/get': 6.0.0(")), /Requalify/);
  assert.throws(() => lockedElectronVersion(''), /Exact locked Electron/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-prefetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = electronPlan('43.8.1', root);
  const zip = Buffer.from('test electron archive');
  const sums = Buffer.from(`${hash(zip)} *${plan.name}\n`);
  const assets = [{ id: 100, name: 'SHASUMS256.txt' }, { id: 101, name: plan.name }];
  const seen = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.ok(options.signal);
    seen.push(url);
    if (url === 'https://api.github.com/repos/electron/electron/releases/tags/v43.8.1') {
      assert.equal(options.headers.accept, 'application/vnd.github+json');
      return Response.json({ tag_name: plan.tag, draft: false, assets });
    }
    assert.equal(options.headers.accept, 'application/octet-stream');
    assert.match(url, /^https:\/\/api.github.com\/repos\/electron\/electron\/releases\/assets\/10[01]$/);
    return new Response(url.endsWith('/100') ? sums : zip);
  };
  return { plan, zip, sums, assets, seen, fetchImpl, options: { token: 'test-token', fetchImpl, delays: [0, 0] } };
}

test('authenticated assets fill the cache; a verified cache hit needs no network', async t => {
  const f = await fixture(t);
  await prefetchElectron(f.plan, f.options);
  assert.equal(f.seen.length, 3);
  assert.deepEqual(await readFile(join(f.plan.directory, f.plan.name)), f.zip);
  assert.deepEqual(await readFile(join(f.plan.directory, 'SHASUMS256.txt')), f.sums);
  await prefetchElectron(f.plan, { fetchImpl: () => assert.fail('cache hit must not fetch') });
  assert.equal(f.seen.length, 3);
});

test('replaces corrupted and partial caches through authenticated assets', async t => {
  const f = await fixture(t);
  await prefetchElectron(f.plan, f.options);
  for (const name of [f.plan.name, 'SHASUMS256.txt']) {
    await writeFile(join(f.plan.directory, name), 'broken');
    await prefetchElectron(f.plan, f.options);
    assert.deepEqual(await readFile(join(f.plan.directory, f.plan.name)), f.zip);
  }
  await rm(join(f.plan.directory, f.plan.name));
  await prefetchElectron(f.plan, f.options);
  assert.equal(f.seen.length, 12);
});

test('retries HTTP 504 without switching to browser download URLs', async t => {
  const f = await fixture(t);
  let failures = 0;
  await prefetchElectron(f.plan, { ...f.options, fetchImpl: (url, options) => {
    if (url.endsWith('/101') && failures++ < 2) return new Response(null, { status: 504 });
    return f.fetchImpl(url, options);
  } });
  assert.equal(failures, 3);
});

test('missing token and permanent HTTP refusals fail without anonymous fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(prefetchElectron(f.plan, { fetchImpl: () => assert.fail() }), /token required/);
  let calls = 0;
  await assert.rejects(prefetchElectron(f.plan, { ...f.options, fetchImpl: () => {
    calls++; return new Response(null, { status: 401 });
  } }), /unavailable \(401\)/);
  assert.equal(calls, 1);
});

test('rejects mismatched checksum and ambiguous or absent release assets', async t => {
  const f = await fixture(t);
  await assert.rejects(prefetchElectron(f.plan, { ...f.options, fetchImpl: (url, options) =>
    url.endsWith('/101') ? new Response('corrupt') : f.fetchImpl(url, options) }), /checksum mismatch/);
  await assert.rejects(stat(join(f.plan.directory, f.plan.name)), { code: 'ENOENT' });
  f.assets.push(f.assets[1]);
  await assert.rejects(prefetchElectron(f.plan, f.options), /Exact Electron release asset/);
  f.assets.length = 1;
  await assert.rejects(prefetchElectron(f.plan, f.options), /Exact Electron release asset/);
});

test('actual pinned @electron/get verifies the prefetched cache without downloading', async t => {
  const f = await fixture(t);
  const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  const { downloadArtifact } = await import(pathToFileURL(require.resolve('@electron/get')));
  const install = await readFile(join(dirname(require.resolve('electron/package.json')), 'install.js'), 'utf8');
  assert.match(install, /cacheRoot: process.env.electron_config_cache/);
  assert.match(install, /require\('\.\/checksums.json'\)/);
  assert.doesNotMatch(install, /unsafelyDisableChecksums/);
  await prefetchElectron(f.plan, f.options);
  const options = { version: f.plan.version, artifactName: 'electron', platform: process.platform, arch: process.arch,
    cacheRoot: dirname(f.plan.directory), checksums: { [f.plan.name]: hash(f.zip) },
    downloader: { download() { throw Error('network forbidden'); } } };
  assert.equal(await downloadArtifact(options), join(f.plan.directory, f.plan.name));
  // A cached zip must still pass Electron's independent checksum validator.
  await assert.rejects(downloadArtifact({ ...options, checksums: { [f.plan.name]: '0'.repeat(64) } }), /network forbidden/);
});

test('cosign uses pinned platform asset IDs and refuses bad bytes before installation', async t => {
  const f = await fixture(t);
  for (const [key, [id]] of Object.entries(cosignAssets)) {
    const [platform, arch] = key.split('-');
    await assert.rejects(installCosign(f.plan.directory, { token: 'test-token', platform, arch,
      fetchImpl: async (url, options) => {
        assert.equal(url, `https://api.github.com/repos/sigstore/cosign/releases/assets/${id}`);
        assert.equal(options.headers.authorization, 'Bearer test-token');
        assert.equal(options.headers.accept, 'application/octet-stream');
        return new Response('bad binary');
      } }), /Cosign checksum mismatch/);
  }
  await assert.rejects(stat(f.plan.directory), { code: 'ENOENT' });
});

test('every workflow workspace install prefetches Electron and no cosign installer uses public downloads', async () => {
  const workflows = new URL('../../.github/workflows/', import.meta.url);
  let installs = 0;
  for (const file of await readdir(workflows)) {
    if (!file.endsWith('.yml')) continue;
    const text = await readFile(new URL(file, workflows), 'utf8');
    assert.doesNotMatch(text, /uses: sigstore\/cosign-installer@/, file);
    const steps = text.split(/^      - /m);
    for (let i = 1; i < steps.length; i++) {
      if (!steps[i].startsWith('run: pnpm install') || steps[i].includes('--ignore-scripts')) continue;
      assert.match(steps[i - 1], /uses: \.\/(?:mdbase-connect\/)?\.github\/actions\/prefetch-electron\n/, file);
      assert.match(steps[i - 1], /token: \$\{\{ github.token \}\}/, file);
      installs++;
    }
  }
  assert.ok(installs >= 15);
});
