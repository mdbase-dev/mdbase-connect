// Local archive/lock regression only; no production IO or trust authentication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';

const app = new URL('../', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

it('pins the Editor npm UI version and registry integrity in both target configs and the frozen lock', async () => {
  const pkg = await json(new URL('package.json', app));
  const version = pkg.dependencies['@mdbase-dev/ui'];
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const lock = parse(await readFile(new URL('../../pnpm-lock.yaml', app), 'utf8'));
  const dependency = lock.importers['apps/editor'].dependencies['@mdbase-dev/ui'];
  assert.equal(dependency.specifier, version);
  assert.equal(dependency.version.split('(')[0], version);
  for (const target of ['staging', 'production']) {
    const config = await json(new URL(`../../config/native-publish/${target}.json`, app));
    assert.equal(config.ui.version, version);
    assert.match(config.ui.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.deepEqual(lock.packages[`@mdbase-dev/ui@${version}`].resolution, { integrity: config.ui.integrity });
  }
});

it('pins the ordinary Editor to the original production SDK with beta.141 trust', async () => {
  const pkg = await json(new URL('package.json', app));
  const metadata = await json(new URL('vendor/mdbase-next-sdk.json', app));
  const artifact = 'sdk-eaa4e697-production-beta141.tgz';
  assert.equal(pkg.dependencies['@mdbase-dev/sdk'], `file:vendor/${artifact}`);
  assert.equal(metadata.artifact, artifact);
  assert.equal(metadata.sourceCommit, 'eaa4e697fc1198f32fc3714f377342a24c56d985');
  const archive = new URL(`vendor/${artifact}`, app);
  const bytes = await readFile(archive);
  const sha256 = 'e64771a90bed2fb3837d4b65df8930fcd124d3059fcb0bcbaf9d64dbfb148205';
  assert.equal(digest(bytes), sha256);
  assert.equal(metadata.sha256, sha256);
  assert.equal(metadata.bytes, bytes.length);
  assert.equal(metadata.integrity, `sha512-${digest(bytes, 'sha512', 'base64')}`);
  const factsBytes = await readFile(new URL(`vendor/${metadata.artifactFacts}`, app));
  assert.equal(digest(factsBytes), metadata.artifactFactsSha256);
  const facts = JSON.parse(factsBytes);
  assert.equal(facts.source, metadata.sourceCommit);
  assert.equal(facts.sha256, sha256);
  const lock = parse(await readFile(new URL('../../pnpm-lock.yaml', app), 'utf8'));
  const pin = `file:apps/editor/vendor/${artifact}`;
  assert.deepEqual(lock.importers['apps/editor'].dependencies['@mdbase-dev/sdk'], {
    specifier: `file:vendor/${artifact}`, version: pin,
  });
  assert.deepEqual(lock.packages[`@mdbase-dev/sdk@${pin}`].resolution, {
    integrity: metadata.integrity, tarball: pin,
  });
  const member = path => execFileSync('tar', ['-xOzf', fileURLToPath(archive), `package/${path}`]);
  const module = member('dist/application/packaged-trust.js');
  assert.equal(digest(module), facts.packagedTrustModuleSha256);
  const release = JSON.parse(/const metadata = (\{[^\n]+\});/.exec(module.toString())[1]);
  assert.equal(release.environment, 'production');
  assert.equal(release.cpOrigin, 'https://connect.mdbase.dev');
  assert.equal(release.logOrigin, 'https://log.mdbase.dev');
  assert.equal(release.source.version, '0.1.0-beta.141');
  assert.equal(release.assetSha256, '7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7');
  const provenance = JSON.parse(member('dist/native/provenance.json'));
  assert.equal(provenance.environment, 'production');
  assert.equal(provenance.trust.sha256, release.assetSha256);
});
