import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { assertBuildIdentity, buildIdentityPlugin, buildIdentityTag, stampBuildIdentity } from '../build-identity.mjs';
import { inventoryDirectory } from './native-publish-bytes.mjs';

const previous='1'.repeat(40),candidate='2'.repeat(40);
const notFound=await readFile(new URL('../../public/404.html',import.meta.url));
// Same source bytes in both builds, as with 404.html between those two releases.
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'editor-build-identity-'));
 await mkdir(join(root,'assets'));await mkdir(join(root,'nested'));
 await writeFile(join(root,'index.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
 await writeFile(join(root,'404.html'),notFound);
 await writeFile(join(root,'nested/page.html'),'<html><head></head></html>');
 await writeFile(join(root,'assets/a.js'),'export const a=1;');
 return root;
}
const build=async(root,sha)=>{
 const out=root+'-'+sha.slice(0,6);await cp(root,out,{recursive:true});
 const plugin=buildIdentityPlugin(sha);
 plugin.configResolved({root:out,build:{outDir:'.'}});await plugin.writeBundle();
 return {out,inventory:await inventoryDirectory(out,{maxFileBytes:1024*1024})};
};

it('two builds of identical HTML sources from different commits differ in every HTML document',async()=>{
 const root=await fixture();
 try {
  const a=await build(root,previous),b=await build(root,candidate);
  const html=a.inventory.filter(x=>x.path.endsWith('.html')).map(x=>x.path);
  assert.deepEqual(html,['404.html','index.html','nested/page.html']);
  for(const path of html) {
   const left=a.inventory.find(x=>x.path===path),right=b.inventory.find(x=>x.path===path);
   assert.notEqual(left.sha256,right.sha256,path);
   assert.ok((await readFile(join(b.out,path),'utf8')).includes(buildIdentityTag(candidate)),path);
  }
  for(const x of a.inventory.filter(x=>!x.path.endsWith('.html')))
   assert.equal(x.sha256,b.inventory.find(y=>y.path===x.path).sha256,'non-HTML bytes unchanged '+x.path);
  // The Editor 404 document keeps its structure; only the identity is added.
  assert.equal((await readFile(join(b.out,'404.html'),'utf8')).replace(buildIdentityTag(candidate)+'\n',''),notFound.toString('utf8'));
  // The publisher accepts exactly this build's identity and nothing else.
  await assertBuildIdentity(b.out,b.inventory,candidate);
  await assert.rejects(assertBuildIdentity(a.out,a.inventory,candidate),/lacks this build's identity: 404.html/);
  await assert.rejects(assertBuildIdentity(root,b.inventory,candidate),/lacks this build's identity/);
  await assert.rejects(stampBuildIdentity(b.out,previous),/already carries a build identity/);
 } finally {await rm(root,{recursive:true,force:true});await rm(root+'-'+previous.slice(0,6),{recursive:true,force:true});await rm(root+'-'+candidate.slice(0,6),{recursive:true,force:true});}
});

it('refuses HTML it cannot stamp and a build without index.html',async()=>{
 const root=await mkdtemp(join(tmpdir(),'editor-build-identity-'));
 try {
  await writeFile(join(root,'404.html'),'<html><body>no head</body></html>');
  await assert.rejects(stampBuildIdentity(root,candidate),/needs a head element: 404.html/);
  await writeFile(join(root,'404.html'),'<html><head></head></html>');
  await assert.rejects(stampBuildIdentity(root,candidate),/found no index.html/);
 } finally {await rm(root,{recursive:true,force:true});}
});
