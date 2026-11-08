// Repin contract: derive the metadata from the manifest, never freeze a version.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';
import { productionPin } from './native/originals.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const json=async path=>JSON.parse(await readFile(new URL(path,new URL('../',import.meta.url)),'utf8'));
it('reads exactly the metadata and archive written by the SDK repin and binds the frozen resolution',async()=>{
 const {pin,spec}=await productionPin(root);
 const lock=parse(await readFile(new URL('../../../pnpm-lock.yaml',import.meta.url),'utf8'));
 const path='file:apps/editor/vendor/'+pin.artifact;
 assert.deepEqual(lock.importers['apps/editor'].dependencies['@mdbase-dev/sdk'],{specifier:spec,version:path});
 assert.deepEqual(lock.packages['@mdbase-dev/sdk@'+path].resolution,{integrity:pin.sri,tarball:path});
 const factsBytes=await readFile(new URL('../vendor/'+pin.artifactFacts,import.meta.url));
 assert.equal(createHash('sha256').update(factsBytes).digest('hex'),pin.artifactFactsSha256);
 const facts=JSON.parse(factsBytes);
 assert.equal(facts.source,pin.sourceCommit);assert.equal(facts.sha256,pin.sha256);
 assert.equal(facts.packagedTrustModuleSha256,pin.packagedTrustModuleSha256);
});
it('takes the exact npm UI version and its integrity from the ordinary manifest and frozen lock',async()=>{
 const pkg=await json('package.json'),version=pkg.dependencies['@mdbase-dev/ui'];
 assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
 const lock=parse(await readFile(new URL('../../../pnpm-lock.yaml',import.meta.url),'utf8'));
 const dependency=lock.importers['apps/editor'].dependencies['@mdbase-dev/ui'];
 assert.equal(dependency.specifier,version);assert.equal(dependency.version.split('(')[0],version);
 assert.match(lock.packages['@mdbase-dev/ui@'+version].resolution.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/);
});
