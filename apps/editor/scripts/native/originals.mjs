// OFF-CI NX-TRUST/TNAPP authenticate once. CI binds original bytes only.
// Canonical producer packet: nx-tnapp-public-target-sdk-verification-inputs.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const requireValue = (ok, reason) => { if (!ok) throw Error(`Refusing native originals: ${reason}`); };
const equal = (a, b, reason) => requireValue(isDeepStrictEqual(a, b), reason);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const packages = { sdk: '@mdbase-dev/sdk', ui: '@mdbase-dev/ui', protocol: '@mdbase-dev/connect-protocol' };
export const digestNames = ['NATIVE_SDK_SHA256', 'NATIVE_PROTOCOL_SHA256', 'NATIVE_TRUST_ASSET_SHA256'];
export function protectedHashes(env = process.env) {
  const hashes = Object.fromEntries(digestNames.map(name => [name, env[name]]));
  requireValue(Object.values(hashes).every(value => /^[a-f0-9]{64}$/.test(value ?? '')), 'three protected per-environment original SHA256 values required');
  return hashes;
}
async function regular(root, name) {
  requireValue(typeof name === 'string' && name.split('/').every(p => /^[\w.@~-]+$/.test(p) && p !== '.' && p !== '..'), 'unsafe input path');
  const path = join(root, name);
  requireValue((await lstat(path)).isFile() && await realpath(path) === path, 'input symlink/nonregular file');
  return readFile(path);
}
export function originalMembers(bytes) {
  return JSON.parse(execFileSync('python3', ['-B', fileURLToPath(new URL('./archive-members.py', import.meta.url))], { input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}
function memberBytes(archive, members, path) {
  requireValue(members.some(m => m.path === path), `missing original ${path}`);
  return execFileSync('tar', ['-xOzf', archive, `package/${path}`], { maxBuffer: 128 * 1024 * 1024 });
}
export async function installedMembers(root, ignoredPaths = new Set()) {
  const out = [];
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), rel = prefix + name, stat = await lstat(path);
      // Installer dependency/CLI namespaces are not original package source.
      // Never follow, execute, classify or delete excluded entries. Callers may
      // exclude a namespace ONLY when the archive has no originals beneath it.
      if (ignoredPaths.has(rel)) continue;
      requireValue(!stat.isSymbolicLink(), `installed member symlink ${rel}`);
      if (stat.isDirectory()) await walk(path, rel + '/');
      else {
        requireValue(stat.isFile(), `nonregular installed member ${rel}`);
        const bytes = await readFile(path);
        out.push({ path: rel, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await walk(root);
  return out.sort((a,b) => a.path < b.path ? -1 : 1);
}
export async function loadOriginals({ target, repoRoot, hashes, installed = false, fetchImpl = fetch }) {
  requireValue(['staging','production'].includes(target), 'unknown target; no LAB retarget');
  // Library callers must supply explicit expectations. Only the CLI's separate
  // protectedHashes() call intentionally reads process.env; undefined here must
  // not trigger that default overload and then leave `hashes` unvalidated.
  protectedHashes(hashes ?? {});
  repoRoot = await realpath(repoRoot);
  const approvedBytes = await regular(repoRoot, `config/native-publish/${target}.json`);
  const approved = JSON.parse(approvedBytes);
  requireValue(approved.target === target && /^[a-f0-9]{64}$/.test(approved.factsSha256) && /^[a-f0-9]{40}$/.test(approved.sdkSource) && /^[a-f0-9]{40}$/.test(approved.sdkTree), 'approved source intake input');
  const app = join(repoRoot, 'apps/editor');
  const pkg = await json(join(app, 'package.json'));
  const lockBytes = await regular(repoRoot, 'pnpm-lock.yaml');
  const lock = lockBytes.toString();
  const archives = {}, originals = {};
  for (const [key, name] of Object.entries(packages)) {
    const pin = pkg.dependencies?.[name];
    let path, bytes;
    const importer = lock.split('\n  apps/editor:\n')[1]?.split(/\n  [^ ]/)[0];
    if (key === 'ui') {
      requireValue(typeof pin === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pin), `${name} must be an exact npm version`);
      requireValue(approved.ui?.version === pin && /^sha512-[A-Za-z0-9+/]{86}==$/.test(approved.ui?.integrity ?? ''), 'UI committed version/integrity pin missing or mismatched');
      const entry = lock.split(`\n  '${name}@${pin}':\n`)[1]?.split(/\n  [^ ]/)[0];
      const dependency = importer?.split(`'${name}':\n        specifier: ${pin}\n        version: `)[1]?.split('\n')[0];
      requireValue(dependency?.split('(')[0] === pin && entry?.includes(`    resolution: {integrity: ${approved.ui.integrity}}\n`), `${name} frozen registry integrity mismatch`);
      path = `https://registry.npmjs.org/${name}/-/ui-${pin}.tgz`;
      const response = await fetchImpl(path, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      requireValue(response.ok, `${name}@${pin} registry archive unavailable (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
      equal(`sha512-${hash(bytes, 'sha512')}`, approved.ui.integrity, 'UI registry archive integrity mismatch');
    } else {
      requireValue(typeof pin === 'string' && pin.startsWith('file:'), `${name} must remain a file pin`);
      path = relative(repoRoot, resolve(app, pin.slice(5)));
      bytes = await regular(repoRoot, path);
      const sha256 = hash(bytes), sri = `sha512-${hash(bytes, 'sha512')}`;
      equal(sha256, hashes[`NATIVE_${key.toUpperCase()}_SHA256`], `${key} protected archive hash mismatch`);
      requireValue(importer?.includes(`'${name}':\n        specifier: ${pin}\n`), `${name} frozen importer pin mismatch`);
      const escaped = `${name}@file:${path}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const resolution = new RegExp(`  '${escaped}':\\n    resolution: \\{integrity: ([^,]+), tarball: file:([^}]+)\\}`).exec(lock);
      requireValue(resolution?.[1] === sri && resolution?.[2] === path, `${name} frozen archive integrity mismatch`);
    }
    const members = originalMembers(bytes);
    if (key === 'ui') {
      const manifest = JSON.parse(execFileSync('tar', ['-xOzf', '-', 'package/package.json'], { input: bytes }));
      requireValue(manifest.name === name && manifest.version === pin, 'UI registry package identity mismatch');
    }
    if (installed) {
      const installedRoot = await realpath(join(app, 'node_modules', name));
      requireValue(!relative(repoRoot, installedRoot).startsWith('..'), 'installed package outside checkout');
      // Editor uses hoisted pnpm installs. A package's installed dependencies
      // and generated CLI links are not original package members. Never exclude
      // ANY namespace owned by the archive (in particular SDK bundled modules).
      // External dependency resolution remains governed by the frozen lock;
      // this check proves original bytes, not fresh dependency authentication.
      const owns = path => members.some(m => m.path === path || m.path.startsWith(path + '/'));
      const ignored = !owns('node_modules') ? new Set(['node_modules'])
        : !owns('node_modules/.bin') ? new Set(['node_modules/.bin']) : new Set();
      const actual = await installedMembers(installedRoot, ignored);
      const byPath = new Map(actual.map(m => [m.path,m]));
      const originalPaths = new Set(members.map(m => m.path));
      const extras = actual.filter(m => !originalPaths.has(m.path)).map(m => m.path).slice(0,3);
      const differences = members.filter(m => !isDeepStrictEqual(m,byPath.get(m.path))).slice(0,3).map(m => ({expected:m,actual:byPath.get(m.path)??null}));
      equal(actual, members, `${name} ALL installed original members differ: ${JSON.stringify({expectedCount:members.length,actualCount:actual.length,extras,differences})}`);
    }
    archives[key] = { path, ...(key === 'ui' ? { version: pin } : {}), bytes: bytes.length, sha256: hash(bytes), sri: `sha512-${hash(bytes, 'sha512')}`, members: members.length };
    originals[key] = members;
  }
  // This is a delivery location, not a new approval descriptor/schema.
  const packet = `apps/editor/vendor/native-release/${target}`;
  const packetFile = (path) => regular(repoRoot, `${packet}/${path}`);
  const factsBytes = await packetFile('artifact-facts.json');
  equal(hash(factsBytes), approved.factsSha256, 'approved facts digest mismatch');
  const facts = JSON.parse(factsBytes);
  equal([facts.source,facts.sourceTree],[approved.sdkSource,approved.sdkTree],'approved SDK source/tree mismatch');
  const sdk = archives.sdk, sdkPath = join(repoRoot, sdk.path), members = originals.sdk;
  const producerMembers = JSON.parse(await packetFile('members.json'));
  requireValue(Array.isArray(producerMembers), 'producer complete SDK inventory type');
  // Canonical producer sidecar retains npm archive order. Compare ALL entries
  // by path without rewriting originals, deduplicating or dropping any entry.
  equal(producerMembers.toSorted((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), members, 'producer complete SDK inventory mismatch');
  requireValue(facts.archive === sdk.path.split('/').at(-1) && facts.bytes === sdk.bytes && facts.sha256 === sdk.sha256 && facts.sri === sdk.sri && facts.members === sdk.members && /^[a-f0-9]{40}$/.test(facts.source) && /^[a-f0-9]{40}$/.test(facts.sourceTree), 'canonical artifact facts mismatch');
  const provenanceBytes = await packetFile('provenance.json');
  requireValue(provenanceBytes.equals(memberBytes(sdkPath, members, 'dist/native/provenance.json')), 'provenance not byte-identical to original');
  const provenance = JSON.parse(provenanceBytes);
  equal([facts.trust,facts.handoff,facts.verifier],[provenance.trust,provenance.handoff,provenance.verifier], 'approved facts/provenance trust/handoff/verifier mismatch');
  requireValue(provenance.schema === 'mdbn-sdk/application-assets/1' && provenance.environment === target && provenance.trust?.environment === target, 'provenance target mismatch');
  const contextBytes = await packetFile(`next-trust/${target}-context.json`), context = JSON.parse(contextBytes);
  const asset = await packetFile(`next-trust/${target}.json`);
  const receiptBytes = await packetFile('build-receipt.json'), receipt = JSON.parse(receiptBytes);
  const cp = target === 'staging' ? 'https://connect-staging.mdbase.dev' : 'https://connect.mdbase.dev';
  const t = provenance.trust, c = context.context, h = provenance.handoff, v = provenance.verifier;
  requireValue(context.schema_version === 1 && context.kind === 'mdbase-next-build-trust-context', 'canonical context schema');
  requireValue(c.environment === target && c.control_plane_origin === cp && c.source?.repository === 'mdbase-dev/mdbase-connect' && /^[a-f0-9]{40}$/.test(c.source.commit) && typeof c.source.version === 'string' && c.source.version.length > 0, 'target CP/source context mismatch');
  const log = new URL(c.log_origin);
  requireValue(log.protocol === 'https:' && log.origin === c.log_origin && !log.username && !log.password, 'exact authenticated log origin');
  equal([hash(asset), t.sha256, c.sha256], Array(3).fill(hashes.NATIVE_TRUST_ASSET_SHA256), 'RAW signed asset hash differs (not module/context/receipt hash)');
  equal([t.cpOrigin,t.logOrigin,t.sourceCommit,t.sourceVersion], [cp,c.log_origin,c.source.commit,c.source.version], 'trust context bindings');
  requireValue(h.contextSha256 === hash(contextBytes) && h.receiptSha256 === hash(receiptBytes) && h.asset_length === asset.length && h.asset_path === `next-trust/${target}.json`, 'handoff original byte binding');
  for (const [key,value] of Object.entries(context.provenance)) equal(h[key], value, `context provenance ${key}`);
  const proofs = {};
  for (const filename of ['release-trust-bundle.json','release-trust-bundle.sigstore.json','image-release-bundle.json','image-release-bundle.sigstore.json']) {
    proofs[filename] = await packetFile(filename);
    equal(hash(proofs[filename]), h.proof_sha256?.[filename], `original proof ${filename}`);
  }
  const inventory = JSON.parse(proofs['release-trust-bundle.json']), image = JSON.parse(proofs['image-release-bundle.json']);
  const a = inventory.trustAssets?.[0], b = inventory.imageBundle;
  const sourceMatches = value => value?.repository === c.source.repository && value?.commit === c.source.commit && value?.version === c.source.version;
  requireValue(inventory.schemaVersion === 1 && inventory.kind === 'mdbase-release-trust-bundle' && sourceMatches(inventory) && sourceMatches(image) && inventory.trustAssets?.length === 1, 'canonical authenticated release inventory identity');
  requireValue(a.path === h.asset_path && a.length === asset.length && a.sha256 === hashes.NATIVE_TRUST_ASSET_SHA256 && a.environment === target && a.controlPlaneOrigin === cp && a.logOrigin === c.log_origin && sourceMatches(a.source), 'release inventory RAW signed trust asset binding');
  requireValue(b?.path === 'image-release-bundle.json' && b.length === proofs[b.path].length && b.sha256 === h.proof_sha256[b.path] && b.publicationRunId === h.image_publication.run_id && b.publicationRunAttempt === h.image_publication.run_attempt, 'image inventory binding');
  equal([image.publication?.runId,image.publication?.runAttempt,inventory.publication?.runId,inventory.publication?.runAttempt,inventory.publication?.publisherCommit,inventory.qualification?.runId,inventory.qualification?.runAttempt], [h.image_publication.run_id,h.image_publication.run_attempt,h.trust_publication.run_id,h.trust_publication.run_attempt,h.trust_publication.publisher_commit,h.publisher_qualification.run_id,h.publisher_qualification.run_attempt], 'original publication/qualification bindings');
  for (const key of ['image_publication','trust_publication','publisher_qualification']) requireValue(Number.isSafeInteger(h[key]?.run_id) && h[key].run_id > 0 && Number.isSafeInteger(h[key]?.run_attempt) && h[key].run_attempt > 0, `canonical ${key} identity`);
  requireValue(/^[a-f0-9]{40}$/.test(h.trust_publication.publisher_commit), 'publisher commit identity');
  requireValue(receipt.schema === 'mdbn-sdk/application-build/1' && receipt.contextSha256 === hash(contextBytes) && receipt.verifierSha256 === v.sha256 && receipt.verifierSourceCommit === v.source && v.clockOverride === false && /^[a-f0-9]{40}$/.test(v.source) && /^[a-f0-9]{64}$/.test(v.sha256), 'frozen receipt/verifier binding');
  const module = memberBytes(sdkPath, members, 'dist/application/packaged-trust.js');
  equal(hash(module), facts.packagedTrustModuleSha256, 'approved compiled trust module mismatch');
  const literal = /const metadata = (\{[^\n]+\});/.exec(module.toString());
  requireValue(literal, 'unknown canonical packaged trust literal');
  const release = JSON.parse(literal[1]);
  equal([release.schema,release.environment,release.cpOrigin,release.logOrigin,release.assetSha256,release.source], ['mdbn-app-trust/release/1',target,cp,c.log_origin,hash(asset),c.source], 'compiled appReleaseTrust asset/context binding');
  const nativeAssets = {};
  for (const [name,pin] of [['runtime.wasm',provenance.runtime],['sqlite3.wasm',provenance.sqlite],['sqlite3.js',provenance.sqlite.initializer]]) {
    const bytes = memberBytes(sdkPath,members,`dist/native/${name}`);
    requireValue(pin.sha256 === hash(bytes) && pin.bytes === bytes.length, `${name} provenance mismatch`);
    nativeAssets[name] = { sha256:hash(bytes), bytes:bytes.length };
  }
  requireValue(provenance.runtime.source?.repository === 'mdbase-dev/mdbase-next' && facts.nativeSource === provenance.runtime.source.commit && facts.nativeSha256 === provenance.runtime.sha256 && facts.nativeBytes === provenance.runtime.bytes && provenance.runtime.bytes <= provenance.runtime.maxBytes && provenance.sqlite.bytes <= provenance.sqlite.maxBytes, 'native source/budget facts');
  const dep = facts.dependencies?.find(d => d.name === packages.protocol);
  const protocol = archives.protocol;
  requireValue(dep && dep.file === `vendor/${protocol.path.split('/').at(-1)}` && dep.bytes === protocol.bytes && dep.sha256 === protocol.sha256 && dep.sri === protocol.sri, 'bundled protocol original custody');
  // Canonical facts.file is SDK-relative original vendor custody, NOT an app path
  // or invented basename alias. Bind that unchanged original tgz as well as every
  // installed/bundled protocol member below.
  const vendorProtocol = memberBytes(sdkPath, members, dep.file);
  requireValue(vendorProtocol.length === protocol.bytes && hash(vendorProtocol) === protocol.sha256 && `sha512-${hash(vendorProtocol, 'sha512')}` === protocol.sri, 'SDK vendor protocol original archive differs');
  const bundled = members.filter(m => m.path.startsWith('node_modules/@mdbase-dev/connect-protocol/')).map(m => ({...m,path:m.path.slice('node_modules/@mdbase-dev/connect-protocol/'.length)}));
  equal(bundled, originals.protocol, 'SDK bundled protocol differs from pinned original');
  return { environment:target, release, nativeAssets, archives, lockSha256:hash(lockBytes), protectedHashes:hashes,
    packet: { path:packet, approvedInputSha256:hash(approvedBytes), factsSha256:hash(factsBytes), contextSha256:hash(contextBytes), receiptSha256:hash(receiptBytes), provenanceSha256:hash(provenanceBytes) },
    trustModuleSha256:hash(module), appOrigin:target === 'staging' ? 'https://editor-staging.mdbase.dev' : 'https://editor.mdbase.dev',
    connectOrigin:cp, editorOrigin:target === 'staging' ? 'https://editor-staging.mdbase.dev' : 'https://editor.mdbase.dev' };
}
