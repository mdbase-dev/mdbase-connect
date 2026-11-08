// Authenticated SDK and frozen original members; no application imports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { authenticateProduction, stagingArchive, archiveBytes } from './authentication.mjs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
const requireValue = (ok, reason) => { if (!ok) throw Error(`Refusing native originals: ${reason}`); };
const equal = (a, b, reason) => requireValue(isDeepStrictEqual(a, b), reason);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const packages = { sdk: '@mdbase-dev/sdk', ui: '@mdbase-dev/ui', protocol: '@mdbase-dev/connect-protocol' };
export const digestNames = ['EDITOR_TRUST_ASSET_SHA256'];
export function protectedHashes(env = process.env) {
  const hashes = Object.fromEntries(digestNames.map(name => [name, env[name]]));
  requireValue(Object.values(hashes).every(value => /^[a-f0-9]{64}$/.test(value ?? '')), 'protected EDITOR_TRUST_ASSET_SHA256 required');
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
  return execFileSync('tar', ['-xOzf', '-', `package/${path}`], { input: archive, maxBuffer: 128 * 1024 * 1024 });
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

export async function productionPin(repoRoot) {
  const app=join(repoRoot,'apps/editor'),pkg=await json(join(app,'package.json'));
  const spec=pkg.dependencies['@mdbase-dev/sdk'];
  requireValue(/^file:vendor\/[\w.-]+\.tgz$/.test(spec??''),'SDK must be a committed original archive');
  const artifact=spec.slice('file:vendor/'.length);
  const candidates=[];
  for(const name of await readdir(join(app,'vendor'))) {
    if(!/^sdk-production-[\w.-]+\.json$/.test(name))continue;
    const value=await json(join(app,'vendor',name));
    if(value.artifact===artifact)candidates.push(value);
  }
  requireValue(candidates.length===1,'one production pin must describe the dependency');
  const pin=candidates[0],bytes=await regular(repoRoot,'apps/editor/vendor/'+artifact);
  requireValue(pin.schema==='tnapp/production-sdk-original/1' && pin.environment==='production' &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pin.version) && /^[a-f0-9]{40}$/.test(pin.sourceCommit),'production pin identity');
  requireValue(pin.sha256===hash(bytes) && pin.bytes===bytes.length && pin.sri==='sha512-'+hash(bytes,'sha512'),'committed SDK archive mismatch');
  requireValue(pin.publication.repository==='mdbase-dev/mdbase-connect' && pin.publication.workflow==='.github/workflows/publish-sdk-npm.yml' &&
    ['refs/heads/main', 'refs/tags/v'+pin.version].includes(pin.publication.ref),'production publication identity');
  requireValue(pin.publication.npm==='@mdbase-dev/sdk@'+pin.version && pin.publication.integrity===pin.sri &&
    pin.publication.tarball===`https://registry.npmjs.org/@mdbase-dev/sdk/-/sdk-${pin.version}.tgz` &&
    pin.publication.attestations===`https://registry.npmjs.org/-/npm/v1/attestations/@mdbase-dev%2fsdk@${pin.version}`,'committed npm publication mismatch');
  const factsBytes=await regular(repoRoot,'apps/editor/vendor/'+pin.artifactFacts);
  equal(hash(factsBytes),pin.artifactFactsSha256,'committed SDK facts digest mismatch');
  const facts=JSON.parse(factsBytes);
  equal([facts.source,facts.sha256,facts.packagedTrustModuleSha256],[pin.sourceCommit,pin.sha256,pin.packagedTrustModuleSha256],'committed SDK facts mismatch');
  return {pin,bytes,spec};
}
export async function compareInstalled(repoRoot,archives,{fetchImpl=fetch}={}) {
  for(const [key,archive] of Object.entries(archives)) {
    const bytes=archive.path.startsWith('https:')?await archiveBytes(archive.path,fetchImpl):await regular(repoRoot,archive.path);
    requireValue(hash(bytes)===archive.sha256,'installed comparison archive mismatch');
    const members=originalMembers(bytes),name=packages[key];
    const installedRoot=await realpath(join(repoRoot,'apps/editor/node_modules',name));
    requireValue(!relative(repoRoot,installedRoot).startsWith('..'),'installed package outside checkout');
    const owns=path=>members.some(m=>m.path===path || m.path.startsWith(path+'/'));
    const ignored=!owns('node_modules')?new Set(['node_modules']):!owns('node_modules/.bin')?new Set(['node_modules/.bin']):new Set();
    equal(await installedMembers(installedRoot,ignored),members,name+' ALL installed original members differ');
  }
}
export function assertProtocolArchive(pin, sdkBytes, protocolBytes) {
  const entries=pin.bundledDependencies?.filter(d=>d.name===packages.protocol)??[];
  requireValue(entries.length===1,'one SDK bundled protocol required');
  const dependency=entries[0];
  requireValue(/^package\/vendor\/[\w.-]+\.tgz$/.test(dependency.member),'bundled protocol path');
  const bundled=memberBytes(sdkBytes,originalMembers(sdkBytes),dependency.member.slice(8));
  requireValue(bundled.length===dependency.bytes && hash(bundled)===dependency.sha256,'SDK bundled protocol metadata mismatch');
  requireValue(protocolBytes.equals(bundled),'direct protocol must be byte-identical to authenticated SDK bundled protocol');
}
export async function loadOriginals({target,repoRoot,hashes,installed=false,fetchImpl=fetch,authenticate=authenticateProduction,stage=stagingArchive}) {
  requireValue(['staging','production'].includes(target),'unknown target');
  protectedHashes(hashes??{});
  repoRoot=await realpath(repoRoot);
  const {pin,bytes:productionBytes,spec}=await productionPin(repoRoot);
  const app=join(repoRoot,'apps/editor'),pkg=await json(join(app,'package.json'));
  const lockBytes=await regular(repoRoot,'pnpm-lock.yaml'),lock=lockBytes.toString();
  const importer=lock.split('\n  apps/editor:\n')[1]?.split(/\n  [^ ]/)[0];
  const archives={},originals={};
  const frozenFile=(name,pin,bytes)=>{
    const path=relative(repoRoot,resolve(app,pin.slice(5)));
    requireValue(importer?.includes(`'${name}':\n        specifier: ${pin}\n`),name+' frozen importer mismatch');
    const entry=lock.split(`\n  '${name}@file:${path}':\n`)[1]?.split(/\n  [^ ]/)[0];
    requireValue(entry?.includes(`    resolution: {integrity: sha512-${hash(bytes,'sha512')}, tarball: file:${path}}\n`),name+' frozen archive integrity mismatch');
    return path;
  };
  const productionPath=frozenFile(packages.sdk,spec,productionBytes);
  const auth=await authenticate(pin,productionBytes,{fetchImpl});
  let sdkBytes=productionBytes,sdkPath=productionPath,authentication=auth;
  if(target==='staging') {
    const result=await stage(pin,{fetchImpl});
    sdkBytes=result.bytes;sdkPath=result.path;authentication=result.authentication;
  }
  const protocolSpec=pkg.dependencies[packages.protocol];
  requireValue(/^file:vendor\/[\w.-]+\.tgz$/.test(protocolSpec??''),'protocol must be a committed file pin');
  const protocolPath=relative(repoRoot,resolve(app,protocolSpec.slice(5)));
  const protocolBytes=await regular(repoRoot,protocolPath);
  assertProtocolArchive(pin,productionBytes,protocolBytes);
  if(target==='staging')assertProtocolArchive(pin,sdkBytes,protocolBytes);
  frozenFile(packages.protocol,protocolSpec,protocolBytes);
  const version=pkg.dependencies[packages.ui];
  requireValue(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version??''),'UI must be an exact npm version');
  const entry=lock.split(`\n  '${packages.ui}@${version}':\n`)[1]?.split(/\n  [^ ]/)[0];
  const integrity=/resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}/.exec(entry??'')?.[1];
  const frozenUi=importer?.split(`'${packages.ui}':\n        specifier: ${version}\n        version: `)[1]?.split('\n')[0]?.split('(')[0];
  requireValue(integrity && frozenUi===version,'UI frozen version/integrity missing');
  const uiPath=`https://registry.npmjs.org/@mdbase-dev/ui/-/ui-${version}.tgz`;
  const response=await fetchImpl(uiPath,{redirect:'error',signal:AbortSignal.timeout(30000)});
  requireValue(response.ok,'UI registry archive unavailable');
  const uiBytes=Buffer.from(await response.arrayBuffer());
  equal('sha512-'+hash(uiBytes,'sha512'),integrity,'UI registry archive integrity mismatch');
  for(const [key,path,bytes] of [['sdk',sdkPath,sdkBytes],['protocol',protocolPath,protocolBytes],['ui',uiPath,uiBytes]]) {
    originals[key]=originalMembers(bytes);
    archives[key]={path,bytes:bytes.length,sha256:hash(bytes),sri:'sha512-'+hash(bytes,'sha512'),members:originals[key].length};
  }
  const member=path=>memberBytes(sdkBytes,originals.sdk,path);
  const manifest=JSON.parse(member('package.json'));
  const publication=(await json(join(repoRoot,'config/release-components.json'))).sdkPublication;
  const trust=publication.environments[target];
  requireValue(manifest.name===trust.package && manifest.version===pin.version,'SDK package/version/target mismatch');
  requireValue(target==='production' ? manifest.private!==true && manifest.publishConfig?.registry==='https://registry.npmjs.org/' : manifest.private===true && manifest.publishConfig===undefined,'SDK distribution policy mismatch');
  const ui=JSON.parse(memberBytes(uiBytes,originals.ui,'package.json'));
  requireValue(ui.name===packages.ui && ui.version===version,'UI package identity mismatch');
  const provenance=JSON.parse(member('dist/native/provenance.json'));
  equal(provenance.trust,trust,'SDK provenance trust differs from release components');
  requireValue(provenance.schema==='mdbase-sdk/npm-publication/1' && provenance.environment===target && provenance.commit===pin.sourceCommit,'SDK provenance identity mismatch');
  const module=member('dist/application/packaged-trust.js');
  const literal=/^const metadata = (\{.*\});$/m.exec(module.toString());
  requireValue(literal,'unknown packaged trust literal');
  const release=JSON.parse(literal[1]);
  requireValue(release.schema==='mdbn-app-trust/release/1' && release.environment===target && release.cpOrigin===trust.cpOrigin && release.logOrigin===trust.logOrigin,'packaged SDK target mismatch');
  equal([release.assetSha256,provenance.trust.sha256,hash(await regular(repoRoot,`config/next-trust/${target}.json`))],
    Array(3).fill(hashes.EDITOR_TRUST_ASSET_SHA256),'packaged trust hash differs from protected trust hash');
  equal(release.source,{repository:'mdbase-dev/mdbase-connect',commit:trust.sourceCommit,version:trust.sourceVersion},'packaged trust source mismatch');
  if(target==='production') {
    equal(pin.trust,trust,'committed pin trust mismatch');
    equal(pin.packagedTrustModuleSha256,hash(module),'committed packaged trust module mismatch');
    equal(pin.runtime,provenance.runtime,'committed runtime mismatch');
    for(const dependency of pin.bundledDependencies) {
      requireValue(dependency.member.startsWith('package/vendor/'),'bundled dependency path mismatch');
      const bytes=member(dependency.member.slice('package/'.length));
      requireValue(bytes.length===dependency.bytes && hash(bytes)===dependency.sha256,'committed bundled archive mismatch');
    }
  }
  const assetPins=JSON.parse(member('dist/application/asset-pins.json')),nativeAssets={};
  equal(assetPins.runtime,provenance.runtime,'runtime provenance mismatch');
  for(const [name,pin] of [['runtime.wasm',assetPins.runtime],['sqlite3.wasm',assetPins.sqlite],['sqlite3.js',assetPins.sqlite.initializer]]) {
    const bytes=member('dist/native/'+name);
    requireValue(pin.sha256===hash(bytes) && pin.bytes===bytes.length,'native asset integrity mismatch');
    nativeAssets[name]={sha256:hash(bytes),bytes:bytes.length};
  }
  if(installed)await compareInstalled(repoRoot,archives,{fetchImpl});
  return {environment:target,release,nativeAssets,archives,authentication,lockSha256:hash(lockBytes),protectedHashes:hashes,
    production:{path:productionPath,sri:pin.sri},trustModuleSha256:hash(module),
    appOrigin:target==='staging'?'https://editor-staging.mdbase.dev':'https://editor.mdbase.dev'};
}
