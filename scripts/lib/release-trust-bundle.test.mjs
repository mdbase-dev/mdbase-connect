import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTrustBundle, validateTrustBundle } from './release-trust-bundle.mjs';
const source = { repository: 'mdbase-dev/mdbase-connect', commit: 'a'.repeat(40), version: '0.1.0-beta.129' };
const release = { schemaVersion:1, repository:source.repository, commit:source.commit, version:source.version,
  publication:{workflow:'publish-images.yml',runId:10,runAttempt:1} };
const asset = { environment:'lab',control_plane_origin:'https://connect-lab.mdbase.dev',log_origin:'https://log.example',source };
const input = () => ({imageBundleBytes:Buffer.from(JSON.stringify(release)),assetBytes:Buffer.from(JSON.stringify(asset)),
  publication:{workflow:'publish-images.yml',runId:11,runAttempt:1,publisherCommit:'b'.repeat(40)},
  qualification:{workflow:'server-ci.yml',runId:12,runAttempt:1}});
test('binds existing authenticated image bytes and actual asset bytes, preserving release source',()=>{
 const x=input(),m=buildTrustBundle(x);assert.equal(m.commit,source.commit);assert.equal(m.publication.publisherCommit,'b'.repeat(40));
 assert.equal(m.imageBundle.sha256,createHash('sha256').update(x.imageBundleBytes).digest('hex'));
 assert.equal(m.trustAssets[0].length,x.assetBytes.length);assert.equal(m.trustAssets[0].sha256,createHash('sha256').update(x.assetBytes).digest('hex'));
});
for(const [name,edit]of Object.entries({
 unknown:m=>m.override=true,versionArray:m=>m.version=[source.version],publicationIdentity:m=>m.publication.workflow='other.yml',
 invalidPublisher:m=>m.publication.publisherCommit='branch',booleanAttempt:m=>m.publication.runAttempt=true,
 qualification:m=>m.qualification.workflow='fast.yml',imagePath:m=>m.imageBundle.path='../image.json',
 imageHash:m=>m.imageBundle.sha256='bad',imageExtra:m=>m.imageBundle.account='hidden',
 environment:m=>m.trustAssets[0].environment='production',environmentArray:m=>m.trustAssets[0].environment=['lab'],
 assetPath:m=>m.trustAssets[0].path='next-trust/production.json',traversal:m=>m.trustAssets[0].path='../lab.json',
 sourceMismatch:m=>m.trustAssets[0].source.commit='c'.repeat(40),tooLarge:m=>m.trustAssets[0].length=65537,
 zeroSize:m=>m.trustAssets[0].length=0,assetExtra:m=>m.trustAssets[0].rootOverride=true,
 http:m=>m.trustAssets[0].logOrigin='http://log.example',urlPath:m=>m.trustAssets[0].controlPlaneOrigin+='/',
 credentials:m=>m.trustAssets[0].logOrigin='https://user:pass@log.example',duplicate:m=>m.trustAssets.push(m.trustAssets[0]),
 missing:m=>delete m.trustAssets,wrongRepo:m=>m.repository='other/repo'
}))test('rejects '+name,()=>{const m=buildTrustBundle(input());edit(m);assert.throws(()=>validateTrustBundle(m));});
test('builder derives binding from asset bytes, refuses release mismatch',()=>{
 const x=input();x.assetBytes=Buffer.from(JSON.stringify({...asset,source:{...source,commit:'c'.repeat(40)}}));assert.throws(()=>buildTrustBundle(x));
});
test('rejects invalid UTF8 and unapproved publisher environment',()=>{
 const x=input();x.assetBytes=Buffer.from([255]);assert.throws(()=>buildTrustBundle(x));
 x.assetBytes=Buffer.from(JSON.stringify({...asset,environment:'staging'}));assert.throws(()=>buildTrustBundle(x));
});
